// Normalises the SHAPE of the model's output before validation. Pure.
//
// A model that gets the content right and the container wrong is a common failure: kit fields at
// the root instead of under `kit`, `scope` as a sentence, `evidence` as a list of strings. A strict
// schema rejects all of them, and if the ticket is retried on a schedule the same mistake repeats
// forever, silently. A ticket killed by a misplaced brace is worse than an incomplete one; the
// incomplete one at least produces a question.
//
// Only FORM is touched here. Nothing fills an empty field, promotes a status or guesses content.
// A value that cannot be recognised becomes `UNKNOWN`, which is exactly what makes the evaluator
// ASK instead of assume.

import {
  DELIVERABLES,
  EVIDENCE_KINDS,
  FREQUENCIES,
  KIT_SHAPES,
  SCOPE_BREADTHS,
  TARGET_KINDS,
  TICKET_KINDS,
  UNKNOWN,
} from "./kits.js";
import type { TicketKind } from "./kits.js";

export interface ShapeOptions {
  /** Product areas the model may assign. Anything else becomes `UNKNOWN`. Empty = accept any. */
  areas?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalise(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** A known enum value passes; anything else becomes `UNKNOWN`, and `UNKNOWN` becomes a question. */
function enumOrUnknown(value: unknown, allowed: readonly string[]): unknown {
  if (typeof value !== "string") return value;
  const candidate = normalise(value).replace(/[\s-]+/g, "_");
  return allowed.includes(candidate) ? candidate : UNKNOWN;
}

/** "all customers" -> `{breadth: "all"}`. No match means `UNKNOWN`: asking beats inventing. */
function coerceScope(value: unknown): unknown {
  if (isRecord(value)) return { ...value, breadth: enumOrUnknown(value.breadth, SCOPE_BREADTHS) };
  if (typeof value !== "string") return value;

  const text = normalise(value);
  if (/\b(all|every|everyone|everybody|global)\b/.test(text)) return { breadth: "all" };
  if (/\b(several|multiple|some|many|a few|more than one)\b/.test(text)) return { breadth: "several" };
  // "one customer (Acme)" keeps the text: without `customerRef` the evaluator would ask for it.
  if (/\b(one|single|only|just|1)\b/.test(text)) return { breadth: "one_customer", customerRef: value.trim() };
  return { breadth: UNKNOWN };
}

function guessEvidenceKind(value: string): string {
  const text = value.trim();
  if (/^https?:\/\//i.test(text)) return "url";
  if (/screenshot|image|picture|attach|\.png|\.jpe?g|\.gif/i.test(text)) return "screenshot";
  if (/^[a-z0-9_-]{12,}$/i.test(text) && /\d/.test(text)) return "record_id";
  return "error";
}

/** A bare string becomes an evidence item, with the kind inferred from the string itself. */
function coerceEvidenceItem(value: unknown): unknown {
  if (isRecord(value)) {
    if (typeof value.value !== "string") return value;
    const kind = typeof value.kind === "string" ? normalise(value.kind).replace(/[\s-]+/g, "_") : "";
    return (EVIDENCE_KINDS as readonly string[]).includes(kind)
      ? { ...value, kind }
      : { ...value, kind: guessEvidenceKind(value.value) };
  }
  if (typeof value !== "string" || !value.trim()) return value;
  return { kind: guessEvidenceKind(value), value: value.trim() };
}

/** INVESTIGATION: `target` as a string ("the billing integration") keeps the text as `ref`. */
function coerceTarget(value: unknown): unknown {
  if (isRecord(value)) return { ...value, kind: enumOrUnknown(value.kind, TARGET_KINDS) };
  if (typeof value !== "string") return value;
  return { kind: UNKNOWN, ref: value.trim() };
}

function coerceKit(kind: TicketKind, kit: Record<string, unknown>): Record<string, unknown> {
  const out = { ...kit };

  if ("scope" in out) out.scope = coerceScope(out.scope);
  if ("target" in out) out.target = coerceTarget(out.target);
  if (Array.isArray(out.evidence)) out.evidence = out.evidence.map(coerceEvidenceItem);
  if (typeof out.evidence === "string") out.evidence = [coerceEvidenceItem(out.evidence)];
  // Steps as one string ("1. open the page\n2. click") -> the array the schema expects.
  if (typeof out.steps === "string") {
    out.steps = out.steps
      .split(/\r?\n|(?<=[.;])\s+(?=\d[.)])/)
      .map((step) => step.replace(/^\s*\d+[.)]\s*/, "").trim())
      .filter(Boolean);
  }
  if ("frequency" in out) out.frequency = enumOrUnknown(out.frequency, FREQUENCIES);
  if (kind === "INVESTIGATION" && "deliverable" in out) {
    out.deliverable = enumOrUnknown(out.deliverable, DELIVERABLES);
  }
  // `null` is how many models say "nothing here". Schema defaults only apply to `undefined`.
  for (const [key, value] of Object.entries(out)) {
    if (value === null) delete out[key];
  }
  return out;
}

/**
 * Returns the object in the shape the output schema expects. Never throws: unrecognisable input
 * comes back untouched, so the validation error still describes the model's real problem.
 *
 * Idempotent: output that is already correct passes through unchanged.
 */
export function coerceTriageShape(raw: unknown, options: ShapeOptions = {}): unknown {
  if (!isRecord(raw)) return raw;

  const kind = typeof raw.kind === "string" ? raw.kind.trim().toUpperCase() : null;
  if (!kind || !(TICKET_KINDS as readonly string[]).includes(kind)) return raw;

  const kitKeys = Object.keys(KIT_SHAPES[kind as TicketKind]);
  const kit: Record<string, unknown> = isRecord(raw.kit) ? { ...raw.kit } : {};
  const rest: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (key === "kit") continue;
    // A kit field left at the root moves into the kit. If it is already there, the kit wins: a
    // model that filled both places tends to leave the summary at the root and the data in the kit.
    if (kitKeys.includes(key)) {
      if (!(key in kit)) kit[key] = value;
      continue;
    }
    if (value !== null) rest[key] = value;
  }

  if (typeof rest.area === "string") {
    const area = normalise(rest.area);
    const allowed = options.areas?.map(normalise) ?? [];
    rest.area = allowed.length === 0 || allowed.includes(area) ? area || UNKNOWN : UNKNOWN;
  }
  if (typeof rest.status === "string") rest.status = rest.status.trim().toUpperCase();
  if (typeof rest.severity === "string") rest.severity = rest.severity.trim().toUpperCase();
  if (typeof rest.rejectionKind === "string") rest.rejectionKind = rest.rejectionKind.trim().toUpperCase();

  return { ...rest, kind, kit: coerceKit(kind as TicketKind, kit) };
}
