// A model that replies from a script. For tests and the offline demo.
//
// It makes one point concrete: the gate's guarantees do not depend on the model behaving. Script
// it to self-approve, to return broken shapes or to invent a field, and the same code decides.

import { ZERO_USAGE } from "./types.js";
import type { LlmClient, LlmMessage, LlmResult } from "./types.js";

export interface Script {
  /** A phrase that appears in the thread this script answers. */
  match: string;
  /** Replies to triage requests for that thread, in order. The last one repeats. */
  triage: unknown[];
  /** Replies to "second read" requests for that thread, in order. Defaults to "nothing found". */
  secondRead?: unknown[];
}

const SECOND_READ_MARKER = "RE-READ";

export class ScriptedLlm implements LlmClient {
  readonly calls: LlmMessage[][] = [];
  private readonly positions = new Map<string, number>();

  constructor(private readonly scripts: readonly Script[]) {}

  private next(key: string, replies: readonly unknown[]): unknown {
    const index = this.positions.get(key) ?? 0;
    this.positions.set(key, index + 1);
    return replies[Math.min(index, replies.length - 1)];
  }

  async complete(messages: readonly LlmMessage[]): Promise<LlmResult> {
    this.calls.push([...messages]);

    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const thread = messages.find((m) => m.role === "user")?.content ?? "";
    const script = this.scripts.find((s) => thread.includes(s.match));
    if (!script) throw new Error("ScriptedLlm: no script matches this thread");

    const isSecondRead = system.includes(SECOND_READ_MARKER);
    const reply = isSecondRead
      ? this.next(`${script.match}#second`, script.secondRead?.length ? script.secondRead : [{}])
      : this.next(`${script.match}#triage`, script.triage);

    return {
      text: typeof reply === "string" ? reply : JSON.stringify(reply),
      usage: ZERO_USAGE,
      model: "scripted",
    };
  }
}
