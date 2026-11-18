// Configuration from environment variables. Missing credentials switch a capability OFF; they are
// never an error by themselves. A gate with no tracker still triages; one with no chat still
// accepts manual tickets.

import { join } from "node:path";

import { DEFAULT_CLAUDE_MODEL } from "./llm/claude.js";
import { parseRepoSlug } from "./trackers/github.js";

type Env = Record<string, string | undefined>;

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function flag(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

export interface Config {
  llm:
    | { provider: "anthropic"; model: string; apiKey?: string }
    | { provider: "openai-compatible"; model: string; baseUrl: string; apiKey: string };
  teams: { tenantId: string; clientId: string; clientSecret?: string; teamId: string; channelId: string } | null;
  github: { token: string; owner: string; repo: string; previewEnvironment?: string } | null;
  storeDir: string;
  storePath: string;
  tokenPath: string;
  autoReply: boolean;
  autoIssue: boolean;
  productName?: string;
  areas: string[];
  previewHosts: string[];
  announcementTags: string[];
  selfAuthorIds: string[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: Env = process.env): Config {
  const provider = (env.LLM_PROVIDER ?? "anthropic").trim().toLowerCase();
  let llm: Config["llm"];

  if (provider === "anthropic") {
    llm = {
      provider: "anthropic",
      model: env.TRIAGE_MODEL?.trim() || DEFAULT_CLAUDE_MODEL,
      apiKey: env.ANTHROPIC_API_KEY?.trim() || undefined,
    };
  } else if (provider === "openai-compatible") {
    const baseUrl = env.OPENAI_COMPAT_BASE_URL?.trim();
    const apiKey = env.OPENAI_COMPAT_API_KEY?.trim();
    const model = env.TRIAGE_MODEL?.trim();
    if (!baseUrl || !apiKey || !model) {
      throw new ConfigError(
        "LLM_PROVIDER=openai-compatible needs OPENAI_COMPAT_BASE_URL, OPENAI_COMPAT_API_KEY and TRIAGE_MODEL",
      );
    }
    llm = { provider: "openai-compatible", model, baseUrl, apiKey };
  } else {
    throw new ConfigError(`unknown LLM_PROVIDER "${provider}" (use "anthropic" or "openai-compatible")`);
  }

  const teams =
    env.TEAMS_TENANT_ID && env.TEAMS_CLIENT_ID && env.TEAMS_TEAM_ID && env.TEAMS_CHANNEL_ID
      ? {
          tenantId: env.TEAMS_TENANT_ID.trim(),
          clientId: env.TEAMS_CLIENT_ID.trim(),
          clientSecret: env.TEAMS_CLIENT_SECRET?.trim() || undefined,
          teamId: env.TEAMS_TEAM_ID.trim(),
          channelId: env.TEAMS_CHANNEL_ID.trim(),
        }
      : null;

  let github: Config["github"] = null;
  if (env.GITHUB_TOKEN?.trim() && env.GITHUB_REPO?.trim()) {
    const slug = parseRepoSlug(env.GITHUB_REPO);
    if (!slug) throw new ConfigError('GITHUB_REPO must look like "owner/repo"');
    github = {
      token: env.GITHUB_TOKEN.trim(),
      ...slug,
      previewEnvironment: env.GITHUB_PREVIEW_ENVIRONMENT?.trim() || undefined,
    };
  }

  const storeDir = env.STORE_DIR?.trim() || ".triage-gate";

  return {
    llm,
    teams,
    github,
    storeDir,
    storePath: join(storeDir, "tickets.json"),
    tokenPath: join(storeDir, "teams-refresh-token"),
    autoReply: flag(env.AUTO_REPLY),
    autoIssue: flag(env.AUTO_ISSUE),
    productName: env.PRODUCT_NAME?.trim() || undefined,
    areas: list(env.AREAS),
    previewHosts: list(env.PREVIEW_HOSTS),
    announcementTags: list(env.ANNOUNCEMENT_TAGS),
    selfAuthorIds: list(env.TEAMS_SELF_USER_IDS),
  };
}
