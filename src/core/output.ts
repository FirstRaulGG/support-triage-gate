// The contract between the model and the gate.
//
// THE RULE THIS PROJECT EXISTS FOR: the model PRODUCES the kit; code JUDGES whether it is complete.
// The model may say "TRIAGED" (I extracted the kit, you decide) or "REJECTED" (this is not a
// ticket, and here is why). It can never say "READY": the enum does not contain it, and
// `parseTriageOutput` refuses it with an explicit message. A gate that lets the model approve its own work
// is the classic failure of this design: the model "feels" it understood, marks the ticket ready,
// and an issue with no reproduction steps lands on an engineer's desk.

import { z } from "zod";

import {
  BugKitSchema,
  FeatureKitSchema,
  InvestigationKitSchema,
  QuestionKitSchema,
  UNKNOWN,
  evaluateKit,
} from "./kits.js";
import type { AnyKit, KitEvaluation } from "./kits.js";
import { coerceTriageShape } from "./shape.js";
import type { ShapeOptions } from "./shape.js";

export const SEVERITIES = ["P1", "P2", "P3", "P4"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const REJECTION_KINDS = ["ANNOUNCEMENT", "DUPLICATE", "OTHER"] as const;
export type RejectionKind = (typeof REJECTION_KINDS)[number];

/** Hard cap on questions per message. Specific questions resolve in one; long lists get ignored. */
export const MAX_QUESTIONS = 2;

const envelope = {
  status: z.enum(["TRIAGED", "REJECTED"]),
  title: z.string().trim().min(5).max(120),
  summary: z.string().trim().min(10).max(400),
  area: z.string().trim().min(1).default(UNKNOWN),
  severity: z.enum(SEVERITIES),
  /** Required when REJECTED: a rejection without a reason cannot be audited. */
  triageNote: z.string().trim().min(10).optional(),
  /** WHY it was rejected, as an enum, so nothing downstream has to guess from free text. */
  rejectionKind: z.enum(REJECTION_KINDS).optional(),
  /**
   * Questions WRITTEN BY THE MODEL from what the reporter actually said. Code still decides WHICH
   * field is missing; the model only chooses the words. Optional on purpose: without them the
   * renderer falls back to the fixed text per field.
   */
  questions: z
    .array(z.object({ field: z.string().trim().min(1), text: z.string().trim().min(10).max(240) }))
    .max(6)
    .optional(),
  duplicateOfTicketNumber: z.number().int().positive().optional(),
};

/**
 * Discriminated by `kind`, so a bug-shaped kit on an INVESTIGATION ticket is a parse error and not
 * a half-filled kit that slips through.
 */
export const TriageOutputSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("BUG"), kit: BugKitSchema, ...envelope }).strict(),
    z.object({ kind: z.literal("INVESTIGATION"), kit: InvestigationKitSchema, ...envelope }).strict(),
    z.object({ kind: z.literal("QUESTION"), kit: QuestionKitSchema, ...envelope }).strict(),
    z.object({ kind: z.literal("FEATURE"), kit: FeatureKitSchema, ...envelope }).strict(),
  ])
  .superRefine((value, ctx) => {
    if (value.status === "REJECTED" && !value.triageNote) {
      ctx.addIssue({
        code: "custom",
        path: ["triageNote"],
        message: "REJECTED requires a triageNote explaining why",
      });
    }
  });

export type TriageOutput = z.infer<typeof TriageOutputSchema>;

export type ParseResult = { ok: true; value: TriageOutput } | { ok: false; error: string };

export const READY_REFUSAL =
  'The model cannot emit status "READY". Emit "TRIAGED": the gate promotes a ticket to READY ' +
  "from the kit you extracted.";

/**
 * Validates the model's output. `READY` gets its own message: with only "invalid enum value" the
 * model would retry without understanding the rule.
 */
export function parseTriageOutput(raw: unknown, options: ShapeOptions = {}): ParseResult {
  if (raw && typeof raw === "object") {
    const status = (raw as { status?: unknown }).status;
    if (typeof status === "string" && status.trim().toUpperCase() === "READY") {
      return { ok: false, error: READY_REFUSAL };
    }
  }

  const parsed = TriageOutputSchema.safeParse(coerceTriageShape(raw, options));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, error: `Invalid triage output: ${detail}` };
  }
  return { ok: true, value: parsed.data };
}

/** Judges the kit that matches the output's kind. */
export function evaluateOutput(output: TriageOutput): KitEvaluation {
  return evaluateKit(output.kind, output.kit as AnyKit);
}

export type GateStatus = "READY" | "NEEDS_INFO" | "REJECTED";

/** The only place a ticket becomes READY. Note what is NOT an input: anything the model claimed. */
export function gateStatus(output: Pick<TriageOutput, "status">, evaluation: KitEvaluation): GateStatus {
  if (output.status === "REJECTED") return "REJECTED";
  return evaluation.complete ? "READY" : "NEEDS_INFO";
}
