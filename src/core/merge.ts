// Merges the kit across re-triages. Pure.
//
// The model re-reads the WHOLE thread on every pass and extracts everything again; it does not
// increment. So a field it fails to re-confirm comes back as `unknown` and, written as is, erases
// what was already known: a complete, READY ticket drops back to NEEDS_INFO asking for something
// the reporter said in their first line.
//
// The rule, per field: if the NEW value is absent and the OLD one was known, the old one returns.
// If the new value is present, even if "emptier" than before, the new one WINS, because it may be
// a correction the reporter made on purpose.
//
// "Absent" uses the same per-field rule as the evaluator (`isFieldAbsent`), applied to the value
// itself. Deriving it from the evaluator's `missing` list would be wrong: advisory fields never
// appear there, so a regression in one of them would slip through unnoticed.

import { isFieldAbsent, kitFieldNames, safeParseKit } from "./kits.js";
import type { AnyKit, TicketKind } from "./kits.js";

/**
 * Fields that decide absence TOGETHER and therefore travel together.
 *
 * A bug's `evidence` is only absent when there is no attachment AND no reason. Restoring one
 * without the other builds a kit neither round ever had, and the gate would ask again for the
 * screenshot the reporter already explained they do not have.
 */
const COMPANIONS: Partial<Record<TicketKind, Record<string, readonly string[]>>> = {
  BUG: { evidence: ["noEvidenceReason"] },
};

export interface MergeKitInput {
  /** Kind before this triage. */
  oldKind: TicketKind;
  /** Stored kit: `null` on the first triage, `unknown` because it comes from storage. */
  oldKit: unknown;
  /** Kind the model assigned in THIS round. */
  newKind: TicketKind;
  /** Kit extracted in THIS round, already validated by the schema of the new kind. */
  newKit: AnyKit;
}

/**
 * Degrades to "no merge" (returns `newKit` untouched) in three cases, all deliberate:
 *   - first triage (`oldKit == null`): nothing to compare;
 *   - the kind changed: field names collide across kits with different meanings (`impact` exists
 *     in BUG and FEATURE and asks different things);
 *   - schema drift: the old kit no longer matches today's contract. A stale kit must never break
 *     today's re-triage.
 */
export function mergeKit(input: MergeKitInput): AnyKit {
  const { oldKind, oldKit, newKind, newKit } = input;

  if (oldKit == null) return newKit;
  if (oldKind !== newKind) return newKit;

  const old = safeParseKit(newKind, oldKit);
  if (!old) return newKit;

  const merged: Record<string, unknown> = { ...newKit };
  const oldRecord = old as Record<string, unknown>;

  for (const field of kitFieldNames(newKind)) {
    // A field is atomic: `scope` and `target` change owner whole, never by sub-key. Mixing
    // sub-keys would produce a combination no round ever validated together.
    //
    // Note `scope`: "one customer" with no name counts as PRESENT here although the evaluator
    // calls it incomplete. A known breadth is something the reporter said; treating it as absent
    // would restore the old scope over their correction, and the result would even look complete.
    if (isFieldAbsent(newKind, field, newKit) && !isFieldAbsent(newKind, field, old)) {
      merged[field] = oldRecord[field];
      for (const companion of COMPANIONS[newKind]?.[field] ?? []) {
        merged[companion] = oldRecord[companion];
      }
    }
  }

  // Built only from fields each side had already validated, so this parse is a typing step.
  return safeParseKit(newKind, merged) ?? newKit;
}
