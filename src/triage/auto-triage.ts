// Unattended triage: one thread in, one judged ticket out.
//
// The model only EXTRACTS the kit. `evaluateKit` judges whether it is complete and `anchorKit`
// removes evidence and names the reporter never wrote; both are pure code. The output schema has
// no `READY`, so the model cannot promote a ticket by saying so.

import { anchorKit } from "../core/anchor.js";
import { isGrounded, isNameGrounded } from "../core/grounding.js";
import { KIT_SCHEMAS, UNKNOWN, evaluateKit } from "../core/kits.js";
import type { AnyKit, KitEvaluation, TicketKind } from "../core/kits.js";
import { mergeKit } from "../core/merge.js";
import { gateStatus, parseTriageOutput } from "../core/output.js";
import type { GateStatus, TriageOutput } from "../core/output.js";
import { ZERO_USAGE, addUsage, extractJson } from "../llm/types.js";
import type { LlmClient, LlmMessage, LlmUsage } from "../llm/types.js";
import { SECOND_READ_PROMPT, buildTriagePrompt } from "./prompt.js";
import type { PromptOptions } from "./prompt.js";

export interface ThreadMessage {
  direction: "INBOUND" | "OUTBOUND";
  author?: string | null;
  /** ISO timestamp. */
  at: string;
  text: string;
}

export interface TriageInput {
  ticketNumber: number;
  reporterName?: string | null;
  messages: readonly ThreadMessage[];
  /**
   * The ticket BEFORE this pass, for the kit merge. Absent on the first triage.
   * Without it a field the model fails to re-confirm would erase what was already known.
   */
  previous?: { kind: TicketKind; kit: unknown } | null;
}

export type TriageResult =
  | {
      ok: true;
      output: TriageOutput;
      evaluation: KitEvaluation;
      status: GateStatus;
      usage: LlmUsage;
      model: string | null;
      /** Validation errors the model was sent back to fix before this result was accepted. */
      corrections: string[];
    }
  | { ok: false; error: string; raw?: string; usage: LlmUsage };

export interface TriageOptions extends PromptOptions {
  /** Re-read the thread for missing fields before asking a person. Default: on. */
  secondRead?: boolean;
}

/** The thread as the model sees it. Also the text every grounding check runs against. */
export function renderThread(input: TriageInput): string {
  const lines = input.messages
    .map((m) => `[${m.at}] ${m.author ?? "?"} (${m.direction === "OUTBOUND" ? "support" : "reporter"}): ${m.text}`)
    .join("\n\n");
  return `Ticket #${input.ticketNumber}\nReporter: ${input.reporterName ?? UNKNOWN}\n\n${lines}`;
}

/** Only what the REPORTER side wrote. Our own replies must not ground a recovered value. */
function reporterText(input: TriageInput): string {
  return input.messages
    .filter((m) => m.direction === "INBOUND")
    .map((m) => m.text)
    .join("\n\n");
}

/**
 * Fields whose recovered value must be ANCHORED in the thread text. These are the free-text ones,
 * where "filling in to please" produces invented data. Enum fields are a CHOICE between options,
 * not a quotation, and dates are rarely transcribed literally; checking those word by word would
 * only reject legitimate inference.
 */
const GROUNDED_FIELDS: Record<TicketKind, readonly string[]> = {
  BUG: ["location", "steps", "expected", "actual", "impact"],
  INVESTIGATION: ["subject", "period"],
  QUESTION: ["question", "location"],
  FEATURE: ["problem", "desiredOutcome", "impact"],
};

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join(" ");
  if (value && typeof value === "object") return Object.values(value).map(textOf).join(" ");
  return "";
}

/**
 * What must be checked against the conversation, or `null` when there is nothing to check.
 *
 * `scope` and `target` are the dangerous ones: the breadth/kind is a choice, but `customerRef` and
 * `ref` are NAMES, the fields where an invention does the most damage. Only the name is anchored,
 * and only when present.
 */
function groundableText(kind: TicketKind, field: string, value: unknown): string | null {
  if (field === "scope") return (value as { customerRef?: string } | null)?.customerRef || null;
  if (field === "target") return (value as { ref?: string } | null)?.ref || null;
  if (!GROUNDED_FIELDS[kind].includes(field)) return null;
  return textOf(value);
}

type Attempt =
  | { ok: true; value: TriageOutput; raw: string; usage: LlmUsage; model: string }
  | { ok: false; error: string; raw?: string; usage: LlmUsage };

/**
 * One trip to the model, validated. `raw` comes back on a validation error because it feeds the
 * correction. A network or provider failure comes back WITHOUT `raw` on purpose: there is no
 * format to correct, and insisting would only spend the second call on the same failure.
 */
async function tryOnce(messages: LlmMessage[], llm: LlmClient, options: TriageOptions): Promise<Attempt> {
  let text: string;
  let usage: LlmUsage;
  let model: string;
  try {
    const result = await llm.complete(messages);
    ({ text, usage, model } = result);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), usage: ZERO_USAGE };
  }

  const json = extractJson(text);
  if (json === null) return { ok: false, error: "the model did not return a JSON object", raw: text, usage };

  const parsed = parseTriageOutput(json, { areas: options.areas });
  if (!parsed.ok) return { ok: false, error: parsed.error, raw: text, usage };

  return { ok: true, value: parsed.value, raw: text, usage, model };
}

/**
 * SECOND READ: re-reads the conversation aiming only at what is missing, before asking a person.
 *
 * Two locks, because a model asked for a field tends to produce the field:
 *   1. only fields that were missing are accepted; nothing already known is overwritten;
 *   2. a free-text value is accepted only if it is ANCHORED in what the reporter wrote.
 * Whatever does not pass stays missing and becomes a question, exactly as before. The worst case
 * of this function is one spent call and no change.
 */
async function secondRead(
  input: TriageInput,
  kind: TicketKind,
  missing: readonly string[],
  llm: LlmClient,
): Promise<{ recovered: Record<string, unknown> | null; usage: LlmUsage }> {
  const request: LlmMessage[] = [
    { role: "system", content: SECOND_READ_PROMPT },
    { role: "user", content: `Missing fields: ${missing.join(", ")}\n\nConversation:\n\n${renderThread(input)}` },
  ];

  let text: string;
  let usage: LlmUsage;
  try {
    ({ text, usage } = await llm.complete(request));
  } catch {
    // Not a triage failure: without the second read the ticket simply goes on asking.
    return { recovered: null, usage: ZERO_USAGE };
  }

  const candidate = extractJson(text);
  if (candidate === null) return { recovered: null, usage };

  const grounding = reporterText(input);
  const accepted: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(candidate as Record<string, unknown>)) {
    if (!missing.includes(field)) continue;
    const anchor = groundableText(kind, field, value);
    const check = field === "scope" || field === "target" ? isNameGrounded : isGrounded;
    if (anchor !== null && !check(anchor, grounding)) continue;
    accepted[field] = value;
  }
  return { recovered: Object.keys(accepted).length > 0 ? accepted : null, usage };
}

/**
 * Never throws: returns `{ok: false}`. A ticket the model could not triage must not take the whole
 * batch down; the others carry on and this one waits for the next run.
 */
export async function autoTriage(
  input: TriageInput,
  llm: LlmClient,
  options: TriageOptions = {},
): Promise<TriageResult> {
  const messages: LlmMessage[] = [
    { role: "system", content: buildTriagePrompt(options) },
    { role: "user", content: renderThread(input) },
  ];

  let attempt = await tryOnce(messages, llm, options);
  let usage = attempt.usage;
  const corrections: string[] = [];

  // ONE correction, with the validation error fed back into the conversation. A scheduler would
  // retry the ticket anyway; the difference is that here the model SEES what it got wrong.
  // Without this it repeats the same format forever.
  if (!attempt.ok && attempt.raw !== undefined) {
    corrections.push(attempt.error);
    messages.push(
      { role: "assistant", content: attempt.raw },
      {
        role: "user",
        content:
          `Your previous output was REJECTED by validation.\n\nError: ${attempt.error}\n\n` +
          "Fix ONLY the format and return the whole JSON again. Do not invent content to plug a " +
          `gap: a field you did not have stays "${UNKNOWN}".`,
      },
    );
    attempt = await tryOnce(messages, llm, options);
    usage = addUsage(usage, attempt.usage);
  }

  if (!attempt.ok) return { ok: false, error: attempt.error, raw: attempt.raw, usage };

  const kind = attempt.value.kind;

  // The merge lives HERE, not in the caller, for a coupling reason: `evaluation` and `status`
  // returned by this function MUST describe the kit that gets stored. Merging later would leave
  // them in disagreement: a complete kit stored next to a NEEDS_INFO verdict.
  let kit = mergeKit({
    oldKind: input.previous?.kind ?? kind,
    oldKit: input.previous?.kit ?? null,
    newKind: kind,
    newKit: attempt.value.kit as AnyKit,
  });

  // Evidence and names are facts about the thread, not a report from the model.
  kit = anchorKit(kind, kit, reporterText(input));

  let evaluation = evaluateKit(kind, kit);

  // Before asking a person, re-read. Only when something is still missing, and only once.
  if (options.secondRead !== false && attempt.value.status === "TRIAGED" && evaluation.missing.length > 0) {
    const second = await secondRead(input, kind, evaluation.missing, llm);
    usage = addUsage(usage, second.usage);
    if (second.recovered) {
      // The schema is the last lock: a recovered value outside the contract discards the whole
      // second read instead of contaminating a kit that was already valid.
      const validated = KIT_SCHEMAS[kind].safeParse({ ...kit, ...second.recovered });
      if (validated.success) {
        // Anchored again: the second read may have proposed evidence or a name of its own.
        kit = anchorKit(kind, validated.data as AnyKit, reporterText(input));
        evaluation = evaluateKit(kind, kit);
      }
    }
  }

  const output = { ...attempt.value, kit } as TriageOutput;
  return {
    ok: true,
    output,
    evaluation,
    status: gateStatus(output, evaluation),
    usage,
    model: attempt.model,
    corrections,
  };
}
