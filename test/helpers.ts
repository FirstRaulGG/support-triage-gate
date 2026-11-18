import { BugKitSchema } from "../src/core/kits.js";
import type { BugKit } from "../src/core/kits.js";
import type { LlmClient, LlmMessage, LlmResult } from "../src/llm/types.js";
import { ZERO_USAGE } from "../src/llm/types.js";

/** A complete bug kit. Every test that needs "incomplete" removes exactly what it is about. */
export function completeBugKit(overrides: Record<string, unknown> = {}): BugKit {
  return BugKitSchema.parse({
    location: "/reports/export",
    role: "workspace admin",
    steps: ["open the reports page", "click the export button"],
    expected: "a CSV file with every row of the report",
    actual: "the download starts and the file is empty",
    occurredAt: "2025-01-15T10:00:00Z",
    scope: { breadth: "all" },
    evidence: [{ kind: "screenshot", value: "screenshot attached in the thread" }],
    frequency: "always",
    impact: "nobody can send the monthly report",
    ...overrides,
  });
}

/** A valid model output for a bug. */
export function bugOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "BUG",
    status: "TRIAGED",
    title: "Report export produces an empty file",
    summary: "Exporting a report downloads an empty CSV file for every workspace.",
    area: "web",
    severity: "P2",
    kit: completeBugKit(),
    questions: [],
    ...overrides,
  };
}

/** A model that returns the given replies in order (the last one repeats) and records its calls. */
export class QueueLlm implements LlmClient {
  readonly calls: LlmMessage[][] = [];
  private index = 0;

  constructor(private readonly replies: readonly (unknown | Error)[]) {}

  async complete(messages: readonly LlmMessage[]): Promise<LlmResult> {
    this.calls.push([...messages]);
    const reply = this.replies[Math.min(this.index++, this.replies.length - 1)];
    if (reply instanceof Error) throw reply;
    return {
      text: typeof reply === "string" ? reply : JSON.stringify(reply),
      usage: { ...ZERO_USAGE, inputTokens: 100, outputTokens: 20 },
      model: "test-model",
    };
  }
}

export function at(minutes: number): Date {
  return new Date(Date.UTC(2025, 0, 15, 12, minutes, 0));
}

/** A `fetch` that answers from a list of handlers and records what it was asked. */
export function fakeFetch(
  handler: (url: string, init: RequestInit) => { status?: number; body?: unknown; headers?: Record<string, string> },
): { fetchImpl: typeof fetch; requests: { url: string; init: RequestInit }[] } {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const url = String(input);
    requests.push({ url, init });
    const { status = 200, body = {}, headers = {} } = handler(url, init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }) as typeof fetch;
  return { fetchImpl, requests };
}
