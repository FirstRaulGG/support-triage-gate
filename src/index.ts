// Public API. The pure core is usable on its own, without the pipeline or any adapter.

export * from "./core/kits.js";
export * from "./core/output.js";
export * from "./core/shape.js";
export * from "./core/merge.js";
export * from "./core/grounding.js";
export * from "./core/evidence.js";
export * from "./core/announcement.js";
export * from "./core/policy.js";
export * from "./core/render.js";
export * from "./core/issue.js";
export * from "./core/work.js";
export * from "./core/followup.js";

export * from "./llm/types.js";
export { ClaudeClient, DEFAULT_CLAUDE_MODEL } from "./llm/claude.js";
export type { ClaudeClientOptions } from "./llm/claude.js";
export { OpenAiCompatibleClient } from "./llm/openai-compatible.js";
export type { OpenAiCompatibleOptions } from "./llm/openai-compatible.js";
export { ScriptedLlm } from "./llm/scripted.js";
export type { Script } from "./llm/scripted.js";

export { buildTriagePrompt } from "./triage/prompt.js";
export type { PromptOptions } from "./triage/prompt.js";
export { autoTriage, renderThread } from "./triage/auto-triage.js";
export type { ThreadMessage, TriageInput, TriageOptions, TriageResult } from "./triage/auto-triage.js";

export * from "./sources/types.js";
export { MemoryChatSource } from "./sources/memory.js";
export { TeamsSource, normaliseTeamsMessage } from "./sources/teams/source.js";
export type { TeamsSourceOptions } from "./sources/teams/source.js";
export { FileTokenStore, getAccessToken, pollDeviceCode, startDeviceCode } from "./sources/teams/auth.js";
export type { TeamsAuthConfig, TokenStore } from "./sources/teams/auth.js";

export * from "./trackers/types.js";
export { GitHubTracker } from "./trackers/github.js";
export type { GitHubTrackerOptions } from "./trackers/github.js";
export { MemoryTracker } from "./trackers/memory.js";

export * from "./store/types.js";
export { MemoryTicketStore } from "./store/memory.js";
export { FileTicketStore } from "./store/file.js";

export { pollAndIngest } from "./pipeline/ingest.js";
export type { IngestOptions, IngestResult } from "./pipeline/ingest.js";
export { Gate } from "./pipeline/run.js";
export type { CycleEvent, CycleReport, GateDeps, GateOptions } from "./pipeline/run.js";

export { loadConfig } from "./config.js";
export type { Config } from "./config.js";
