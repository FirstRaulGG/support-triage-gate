// Minimal Microsoft Graph client: retries, timeouts, a host allowlist and typed errors.

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export type FetchLike = typeof fetch;

/**
 * Pagination links come from the API response. Following one blindly would send the bearer token
 * wherever the response says, so every URL is checked against the one host we mean to talk to.
 */
export function isGraphUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.hostname.toLowerCase() === "graph.microsoft.com";
}

export type GraphErrorKind =
  | "AUTH_FAILED"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "TRANSIENT"
  | "UNKNOWN";

export function classifyGraphStatus(status: number): GraphErrorKind {
  if (status === 401) return "AUTH_FAILED";
  if (status === 403) return "PERMISSION_DENIED";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "TRANSIENT";
  return "UNKNOWN";
}

export class GraphError extends Error {
  readonly kind: GraphErrorKind;
  readonly status: number;

  constructor(status: number) {
    const kind = classifyGraphStatus(status);
    super(`Microsoft Graph returned ${status} (${kind})`);
    this.name = "GraphError";
    this.kind = kind;
    this.status = status;
  }
}

export interface GraphRequestOptions {
  fetchImpl?: FetchLike;
  attempts?: number;
  timeoutMs?: number;
  /** Injectable so tests do not actually wait between retries. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Retries 429 and 5xx, honouring `Retry-After` up to a ceiling. Other statuses return at once. */
export async function graphFetch(
  url: string,
  init: RequestInit,
  options: GraphRequestOptions = {},
): Promise<Response> {
  if (!isGraphUrl(url)) throw new Error("refusing to call a URL outside Microsoft Graph");

  const { fetchImpl = fetch, attempts = 3, timeoutMs = 30_000, sleep = defaultSleep } = options;
  let last: Response | null = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (response.ok || (response.status !== 429 && response.status < 500)) return response;

    last = response;
    if (attempt === attempts - 1) break;

    const retryAfter = Number(response.headers.get("retry-after"));
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 15_000) : (attempt + 1) * 1000;
    await sleep(waitMs);
  }
  return last!;
}

export async function graphJson<T>(
  url: string,
  token: string,
  init: RequestInit = {},
  options: GraphRequestOptions = {},
): Promise<T> {
  const response = await graphFetch(
    url,
    {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    },
    options,
  );
  if (!response.ok) throw new GraphError(response.status);
  return (await response.json()) as T;
}
