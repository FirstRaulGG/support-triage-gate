// Delegated auth for Microsoft Teams: device-code sign-in once, refresh token afterwards.
//
// WHY DELEGATED AND NOT APP-ONLY: with application permissions Graph lets an app READ channel
// messages but not POST replies to them outside of migration scenarios. A gate that has to answer
// in the thread therefore signs in as a real (service) account. The account signs in once through
// the device-code flow; after that only the refresh token is needed, and Microsoft rotates it.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { FetchLike } from "./graph.js";

const LOGIN_HOST = "https://login.microsoftonline.com";
const AUTH_TIMEOUT_MS = 30_000;

export const TEAMS_SCOPES = [
  "offline_access",
  "https://graph.microsoft.com/ChannelMessage.Read.All",
  "https://graph.microsoft.com/ChannelMessage.Send",
].join(" ");

export interface TeamsAuthConfig {
  tenantId: string;
  clientId: string;
  /** Only for confidential clients. Public clients (the usual device-code setup) have none. */
  clientSecret?: string;
}

/** Where the refresh token lives between runs. */
export interface TokenStore {
  read(): Promise<string | null>;
  write(refreshToken: string): Promise<void>;
}

/** Keeps the refresh token in a file readable only by the current user. */
export class FileTokenStore implements TokenStore {
  constructor(private readonly path: string) {}

  async read(): Promise<string | null> {
    try {
      const token = (await readFile(this.path, "utf8")).trim();
      return token || null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async write(refreshToken: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, refreshToken, { encoding: "utf8", mode: 0o600 });
  }
}

export class TeamsAuthError extends Error {
  readonly code: string;

  constructor(code: string, description?: string) {
    super(description ? `${code}: ${description}` : code);
    this.name = "TeamsAuthError";
    this.code = code;
  }
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  error?: unknown;
  error_description?: unknown;
}

function tokenUrl(tenantId: string): string {
  return `${LOGIN_HOST}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
}

async function postForm(url: string, body: URLSearchParams, fetchImpl: FetchLike): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
  });
  return (await response.json()) as Record<string, unknown>;
}

export interface DeviceCodeStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalSec: number;
  expiresInSec: number;
  /** Ready-made instruction from Microsoft ("To sign in, open ... and enter ..."). */
  message: string;
}

export async function startDeviceCode(config: TeamsAuthConfig, fetchImpl: FetchLike = fetch): Promise<DeviceCodeStart> {
  const url = `${LOGIN_HOST}/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/devicecode`;
  const json = await postForm(url, new URLSearchParams({ client_id: config.clientId, scope: TEAMS_SCOPES }), fetchImpl);

  if (typeof json.error === "string") {
    throw new TeamsAuthError(json.error, String(json.error_description ?? ""));
  }
  if (typeof json.device_code !== "string" || typeof json.user_code !== "string") {
    throw new TeamsAuthError("invalid_device_code_response");
  }
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: String(json.verification_uri ?? "https://microsoft.com/devicelogin"),
    intervalSec: Number(json.interval) > 0 ? Number(json.interval) : 5,
    expiresInSec: Number(json.expires_in) > 0 ? Number(json.expires_in) : 900,
    message: String(json.message ?? ""),
  };
}

export type DevicePollResult =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "done"; accessToken: string; refreshToken: string };

export async function pollDeviceCode(
  config: TeamsAuthConfig,
  deviceCode: string,
  fetchImpl: FetchLike = fetch,
): Promise<DevicePollResult> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: config.clientId,
    device_code: deviceCode,
  });
  if (config.clientSecret) body.set("client_secret", config.clientSecret);

  const json = (await postForm(tokenUrl(config.tenantId), body, fetchImpl)) as TokenResponse;
  if (typeof json.error === "string") {
    if (json.error === "authorization_pending") return { status: "pending" };
    if (json.error === "slow_down") return { status: "slow_down" };
    throw new TeamsAuthError(json.error, String(json.error_description ?? ""));
  }
  if (typeof json.access_token !== "string" || typeof json.refresh_token !== "string") {
    throw new TeamsAuthError("missing_tokens");
  }
  return { status: "done", accessToken: json.access_token, refreshToken: json.refresh_token };
}

/**
 * Exchanges the stored refresh token for an access token. Microsoft may rotate the refresh token
 * on any exchange; when it does, the new one is saved before the access token is returned, so a
 * crash right after cannot strand the store with a token that no longer works.
 */
export async function getAccessToken(
  config: TeamsAuthConfig,
  store: TokenStore,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const refreshToken = await store.read();
  if (!refreshToken) {
    throw new TeamsAuthError("no_refresh_token", "run `triage-gate auth` once to sign the service account in");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.clientId,
    refresh_token: refreshToken,
    scope: TEAMS_SCOPES,
  });
  if (config.clientSecret) body.set("client_secret", config.clientSecret);

  const json = (await postForm(tokenUrl(config.tenantId), body, fetchImpl)) as TokenResponse;
  if (typeof json.error === "string") {
    throw new TeamsAuthError(json.error, String(json.error_description ?? ""));
  }
  if (typeof json.access_token !== "string") throw new TeamsAuthError("missing_access_token");

  if (typeof json.refresh_token === "string" && json.refresh_token !== refreshToken) {
    await store.write(json.refresh_token);
  }
  return json.access_token;
}
