// The fields a model must not be able to make up, checked against the reporter's own words. Pure.
//
// `evaluateKit` judges whether a kit is COMPLETE. It cannot tell a real value from an invented
// one. Three kinds of value are both easy to invent and cheap to verify, so they are verified on
// every pass, first read included:
//
//   - evidence (see `evidence.ts`);
//   - the reason given for having no evidence, which would otherwise satisfy the evidence field;
//   - names: the customer a bug is scoped to, the target of an investigation.
//
// A value that fails is removed, so the field is missing again and becomes a question. The other
// free-text fields (steps, expected, actual) are the model's reading of the thread and are NOT
// verified here; see "What READY means" in the README.

import { reconcileEvidence } from "./evidence.js";
import { isGrounded, isNameGrounded } from "./grounding.js";
import type { AnyKit, EvidenceItem, TicketKind } from "./kits.js";

export function anchorKit(kind: TicketKind, kit: AnyKit, reporterText: string): AnyKit {
  const anchored: Record<string, unknown> = { ...kit };

  if (Array.isArray(anchored.evidence)) {
    anchored.evidence = reconcileEvidence(anchored.evidence as EvidenceItem[], reporterText);
  }

  if (kind === "BUG") {
    const reason = anchored.noEvidenceReason;
    if (typeof reason === "string" && !isGrounded(reason, reporterText)) delete anchored.noEvidenceReason;

    const scope = anchored.scope as { breadth: string; customerRef?: string };
    if (scope.customerRef && !isNameGrounded(scope.customerRef, reporterText)) {
      anchored.scope = { breadth: scope.breadth };
    }
  }

  if (kind === "INVESTIGATION") {
    const target = anchored.target as { kind: string; ref?: string };
    if (target.ref && !isNameGrounded(target.ref, reporterText)) anchored.target = { kind: target.kind };
  }

  return anchored as AnyKit;
}
