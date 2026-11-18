// The "minimal kit": what an engineer needs before a support ticket is workable.
//
// Each ticket kind has its own kit. One bug-shaped kit for everything is the classic mistake: a
// request like "can you summarise what happened last night?" gets answered with "what are the
// steps to reproduce?", which is a correct question for a bug and a useless one for that request.
//
// Everything in this file is pure. The model fills a kit in; `evaluateKit` decides whether it is
// complete. No LLM takes part in that decision.

import { z } from "zod";

export const TICKET_KINDS = ["BUG", "INVESTIGATION", "QUESTION", "FEATURE"] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];

/** What the model writes when the thread does not say. Always counts as missing. */
export const UNKNOWN = "unknown";

/**
 * Marker the chat adapters leave in the message text where an image was attached.
 * Evidence is then a fact about the text, not something the model reports (see `evidence.ts`).
 */
export const ATTACHMENT_MARKER = "[image attached]";

/**
 * Values that describe an absence instead of filling it. Without this list a field holding
 * "not provided" passes every length check and the question that would fetch the real value is
 * never asked. Matched against the WHOLE value: "the cause is unknown to the user" stays valid.
 */
const BLANK_VALUES = new Set([
  UNKNOWN,
  "n/a",
  "na",
  "none",
  "-",
  "?",
  "not sure",
  "not provided",
  "not specified",
  "not mentioned",
  "don't know",
  "dont know",
  "tbd",
]);

/** Returns the trimmed value, or "" when it only describes an absence. */
export function meaningful(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  return BLANK_VALUES.has(trimmed.toLowerCase()) ? "" : trimmed;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export const EVIDENCE_KINDS = ["screenshot", "url", "error", "record_id"] as const;

export const evidenceItemSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  value: z.string().trim().min(1),
});

export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

/**
 * Evidence that is worth something. `{kind: "screenshot", value: "unknown"}` is schema-valid and
 * proves nothing, so counting array length would let a ticket through the evidence gate empty.
 */
export function usefulEvidence(evidence: readonly EvidenceItem[]): EvidenceItem[] {
  return evidence.filter((item) => meaningful(item.value).length > 0);
}

// ---------------------------------------------------------------------------
// Schemas — deliberately tolerant
// ---------------------------------------------------------------------------
// Every field has a default. An incomplete kit must still PARSE so the evaluator can say what is
// missing; strictness here would turn "three fields missing" into "parse error", and the reporter
// would get silence instead of questions.

export const SCOPE_BREADTHS = ["one_customer", "several", "all"] as const;
export const FREQUENCIES = ["always", "intermittent", "once"] as const;

export const BugKitSchema = z
  .object({
    /** Page, route or module where the problem shows up. */
    location: z.string().trim().default(""),
    /** Who saw it (end user, admin, internal). Free text; helps prioritise, never blocks. */
    role: z.string().trim().default(UNKNOWN),
    steps: z.array(z.string().trim()).default([]),
    expected: z.string().trim().default(""),
    actual: z.string().trim().default(""),
    /** ISO date-time, normalised by the model. */
    occurredAt: z.string().trim().default(UNKNOWN),
    scope: z
      .object({
        breadth: z.enum([...SCOPE_BREADTHS, UNKNOWN]).default(UNKNOWN),
        customerRef: z.string().trim().optional(),
      })
      .default({ breadth: UNKNOWN }),
    evidence: z.array(evidenceItemSchema).default([]),
    /** Only when there is NO evidence and a legitimate reason (e.g. the error no longer shows). */
    noEvidenceReason: z.string().trim().optional(),
    frequency: z.enum([...FREQUENCIES, UNKNOWN]).default(UNKNOWN),
    impact: z.string().trim().default(""),
  })
  .strict();

export const TARGET_KINDS = ["customer", "account", "integration", "system"] as const;
export const DELIVERABLES = ["root_cause", "affected_list", "timeline", "impact_estimate"] as const;

export const InvestigationKitSchema = z
  .object({
    /** What to look into, in one sentence. */
    subject: z.string().trim().default(""),
    target: z
      .object({
        kind: z.enum([...TARGET_KINDS, UNKNOWN]).default(UNKNOWN),
        ref: z.string().trim().optional(),
      })
      .default({ kind: UNKNOWN }),
    /** Time window. Without it an incident cannot be told apart from noise. */
    period: z.string().trim().default(UNKNOWN),
    /** What the person wants BACK. It changes the work completely. */
    deliverable: z.enum([...DELIVERABLES, UNKNOWN]).default(UNKNOWN),
    evidence: z.array(evidenceItemSchema).default([]),
  })
  .strict();

export const QuestionKitSchema = z
  .object({
    question: z.string().trim().default(""),
    location: z.string().trim().default(""),
  })
  .strict();

export const FeatureKitSchema = z
  .object({
    /** The PROBLEM, not the solution the reporter imagined. */
    problem: z.string().trim().default(""),
    desiredOutcome: z.string().trim().default(""),
    impact: z.string().trim().default(""),
  })
  .strict();

export type BugKit = z.infer<typeof BugKitSchema>;
export type InvestigationKit = z.infer<typeof InvestigationKitSchema>;
export type QuestionKit = z.infer<typeof QuestionKitSchema>;
export type FeatureKit = z.infer<typeof FeatureKitSchema>;
export type AnyKit = BugKit | InvestigationKit | QuestionKit | FeatureKit;

export const KIT_SCHEMAS = {
  BUG: BugKitSchema,
  INVESTIGATION: InvestigationKitSchema,
  QUESTION: QuestionKitSchema,
  FEATURE: FeatureKitSchema,
} as const;

// ---------------------------------------------------------------------------
// Field specs — single source of truth for order, fallback questions and prompt shape
// ---------------------------------------------------------------------------

export interface KitFieldSpec {
  name: string;
  /** Asked verbatim when the model did not write a better, thread-specific question. */
  question: string;
}

/**
 * Askable fields per kind, in the order questions are asked. The prompt, the reply renderer and
 * the merge all read this list, so adding a field in one place cannot leave the others behind.
 */
export const KIT_FIELDS: Record<TicketKind, readonly KitFieldSpec[]> = {
  BUG: [
    { name: "location", question: "Where does this happen? A page name or URL is ideal." },
    { name: "role", question: "Who ran into it: you, or a customer who reported it to you?" },
    { name: "steps", question: "Which steps lead to the problem? Please list at least two." },
    { name: "expected", question: "What did you expect to happen?" },
    { name: "actual", question: "What happened instead?" },
    { name: "occurredAt", question: "When did it happen? A date and rough time is enough." },
    { name: "scope", question: "Does it affect one customer, several, or everyone? If one, who?" },
    { name: "evidence", question: "Can you attach a screenshot or paste the error message?" },
    { name: "frequency", question: "Does it happen every time, now and then, or just once?" },
    { name: "impact", question: "What can't you (or the customer) do because of it?" },
  ],
  INVESTIGATION: [
    { name: "subject", question: "What exactly would you like us to look into?" },
    { name: "target", question: "Which customer, account or integration is this about?" },
    { name: "period", question: "What time window should we look at?" },
    {
      name: "deliverable",
      question:
        "What would help most: the likely cause, the list of who was affected, a timeline, or an impact estimate?",
    },
    { name: "evidence", question: "Do you have a screenshot, record id or error message to start from?" },
  ],
  QUESTION: [
    { name: "question", question: "What is the question, exactly?" },
    { name: "location", question: "Which page or feature is it about?" },
  ],
  FEATURE: [
    { name: "problem", question: "What problem are you trying to solve today, without this feature?" },
    { name: "desiredOutcome", question: "What would you like to be able to do?" },
    { name: "impact", question: "How does not having this get in your way?" },
  ],
};

export function kitFieldNames(kind: TicketKind): string[] {
  return KIT_FIELDS[kind].map((f) => f.name);
}

/**
 * The kit SHAPE per kind, shown to the model instead of described in prose. Field names alone do
 * not teach field shape: a model told about "scope" and "evidence" will happily return a string
 * and a list of strings. A test keeps these keys in step with the schemas.
 */
export const KIT_SHAPES: Record<TicketKind, Record<string, unknown>> = {
  BUG: {
    location: "/settings/billing",
    role: "who saw it, e.g. end user, admin",
    steps: ["open page X", "click Y"],
    expected: "what should have happened",
    actual: "what happened",
    occurredAt: "2025-01-15T13:18:00Z",
    scope: { breadth: `${SCOPE_BREADTHS.join(" | ")} | ${UNKNOWN}`, customerRef: "customer name" },
    evidence: [{ kind: EVIDENCE_KINDS.join(" | "), value: "screenshot attached in the thread" }],
    noEvidenceReason: "only when there is no evidence and a real reason why",
    frequency: `${FREQUENCIES.join(" | ")} | ${UNKNOWN}`,
    impact: "what can no longer be done",
  },
  INVESTIGATION: {
    subject: "what to look into, in one sentence",
    target: { kind: `${TARGET_KINDS.join(" | ")} | ${UNKNOWN}`, ref: "which one" },
    period: "between Jan 10 and Jan 20",
    deliverable: `${DELIVERABLES.join(" | ")} | ${UNKNOWN}`,
    evidence: [{ kind: EVIDENCE_KINDS.join(" | "), value: "screenshot attached in the thread" }],
  },
  QUESTION: {
    question: "the question, exactly",
    location: "/reports/monthly",
  },
  FEATURE: {
    problem: "the problem today, without the feature",
    desiredOutcome: "what the person wants to be able to do",
    impact: "how the gap gets in the way",
  },
};

// ---------------------------------------------------------------------------
// Evaluation — 100% deterministic
// ---------------------------------------------------------------------------

/** Mechanical minimums. Shorter than this and the field was filled in just to "pass". */
export const MIN_STEPS = 2;
export const MIN_STEP_LENGTH = 10;
export const MIN_BEHAVIOR_LENGTH = 15;
export const MIN_TEXT_LENGTH = 10;
export const MIN_SUBJECT_LENGTH = 15;

export interface KitEvaluation {
  complete: boolean;
  /** Blocking fields: without them nobody can start, and asking is the only way forward. */
  missing: string[];
  /** Never block. They flag something a human should glance at. */
  warnings: string[];
}

/**
 * Field-level absence, shared by the evaluator and the merge. One rule per field, in one place:
 * if the two used separate copies they would drift, and a ticket would be "complete" for one and
 * "missing a field" for the other.
 */
export function isFieldAbsent(kind: TicketKind, field: string, kit: AnyKit): boolean {
  switch (kind) {
    case "BUG":
      return bugFieldAbsent(kit as BugKit, field);
    case "INVESTIGATION":
      return investigationFieldAbsent(kit as InvestigationKit, field);
    case "QUESTION":
      return questionFieldAbsent(kit as QuestionKit, field);
    case "FEATURE":
      return featureFieldAbsent(kit as FeatureKit, field);
  }
}

function bugFieldAbsent(kit: BugKit, field: string): boolean {
  switch (field) {
    case "location":
      return !meaningful(kit.location);
    case "role":
      return !meaningful(kit.role);
    case "steps": {
      const steps = kit.steps.map(meaningful);
      return steps.length < MIN_STEPS || steps.some((s) => s.length < MIN_STEP_LENGTH);
    }
    case "expected":
      return meaningful(kit.expected).length < MIN_BEHAVIOR_LENGTH;
    case "actual":
      return meaningful(kit.actual).length < MIN_BEHAVIOR_LENGTH;
    case "occurredAt":
      return !meaningful(kit.occurredAt) || Number.isNaN(Date.parse(kit.occurredAt));
    case "scope":
      return kit.scope.breadth === UNKNOWN;
    case "evidence": {
      const hasEvidence = usefulEvidence(kit.evidence).length > 0;
      const hasReason = meaningful(kit.noEvidenceReason).length >= MIN_TEXT_LENGTH;
      return !hasEvidence && !hasReason;
    }
    case "frequency":
      return kit.frequency === UNKNOWN;
    case "impact":
      return meaningful(kit.impact).length < MIN_TEXT_LENGTH;
    default:
      return false;
  }
}

function investigationFieldAbsent(kit: InvestigationKit, field: string): boolean {
  switch (field) {
    case "subject":
      return meaningful(kit.subject).length < MIN_SUBJECT_LENGTH;
    case "target":
      return kit.target.kind === UNKNOWN;
    case "period":
      return !meaningful(kit.period);
    case "deliverable":
      return kit.deliverable === UNKNOWN;
    case "evidence":
      return usefulEvidence(kit.evidence).length === 0;
    default:
      return false;
  }
}

function questionFieldAbsent(kit: QuestionKit, field: string): boolean {
  switch (field) {
    case "question":
      return meaningful(kit.question).length < MIN_TEXT_LENGTH;
    case "location":
      return !meaningful(kit.location);
    default:
      return false;
  }
}

function featureFieldAbsent(kit: FeatureKit, field: string): boolean {
  switch (field) {
    case "problem":
      return meaningful(kit.problem).length < MIN_TEXT_LENGTH;
    case "desiredOutcome":
      return meaningful(kit.desiredOutcome).length < MIN_TEXT_LENGTH;
    case "impact":
      return meaningful(kit.impact).length < MIN_TEXT_LENGTH;
    default:
      return false;
  }
}

/**
 * Fields that only help PRIORITISE. Absent, they become a warning and never a question.
 *
 * Blocking is reserved for what stops the work from starting. Not knowing how often a bug happens
 * does not stop anyone from opening the page and looking; asking for it anyway is how a reporter
 * who attached a screenshot and described the symptom precisely ends up answering five questions.
 */
const ADVISORY_FIELDS: Record<TicketKind, Record<string, string>> = {
  BUG: {
    role: "role not identified: who saw the problem has to be inferred from the location.",
    occurredAt: "occurredAt has no usable date: start the log search from when the report was written.",
    frequency: "frequency unknown: prioritise assuming it repeats.",
    impact: "impact not described: severity comes from the triage judgement, not from the report.",
  },
  INVESTIGATION: {
    evidence: "no evidence attached: the investigation starts from the data alone.",
  },
  QUESTION: {},
  FEATURE: {
    impact: "impact not described: priority comes from the triage judgement, not from the report.",
  },
};

export function isAdvisoryField(kind: TicketKind, field: string): boolean {
  return field in ADVISORY_FIELDS[kind];
}

/** Judges the completeness of a kit of the given kind. Deterministic; no LLM involved. */
export function evaluateKit(kind: TicketKind, kit: AnyKit): KitEvaluation {
  const missing: string[] = [];
  const warnings: string[] = [];

  for (const { name } of KIT_FIELDS[kind]) {
    if (!isFieldAbsent(kind, name, kit)) continue;
    const advisory = ADVISORY_FIELDS[kind][name];
    if (advisory) warnings.push(advisory);
    else missing.push(name);
  }

  if (kind === "BUG") {
    const scope = (kit as BugKit).scope;
    // "Only one customer" without saying WHICH cannot be acted on: there is nothing to reproduce
    // against. The merge treats this differently on purpose (see `merge.ts`).
    if (scope.breadth === "one_customer" && !meaningful(scope.customerRef) && !missing.includes("scope")) {
      missing.push("scope");
    }
  }

  if (kind === "INVESTIGATION") {
    const target = (kit as InvestigationKit).target;
    // A missing `ref` does NOT block here, unlike a bug's customer. In an investigation,
    // identifying the target is often the request itself ("which accounts were affected?").
    if (target.kind !== UNKNOWN && target.kind !== "system" && !meaningful(target.ref)) {
      warnings.push(`target "${target.kind}" has no identifier: the investigation starts by finding which.`);
    }
  }

  return { complete: missing.length === 0, missing, warnings };
}

/** Parses a stored or merged kit with the schema of its kind. Throws on contract drift. */
export function parseKit(kind: TicketKind, kit: unknown): AnyKit {
  return KIT_SCHEMAS[kind].parse(kit) as AnyKit;
}

export function safeParseKit(kind: TicketKind, kit: unknown): AnyKit | null {
  const parsed = KIT_SCHEMAS[kind].safeParse(kit);
  return parsed.success ? (parsed.data as AnyKit) : null;
}
