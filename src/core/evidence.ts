// A ticket's evidence comes from the CONVERSATION, not from what the model says about it. Pure.
//
// Two opposite failures share one fix:
//
//   - A model returns `evidence: [{kind: "screenshot", value: "unknown"}]` for a thread with no
//     attachment at all. If the gate only counts array length, the marker of ABSENCE is accepted
//     as proof and someone starts work believing a screenshot exists.
//   - A reporter does attach the screenshot, the model does not mention it, and the ticket sits
//     for weeks being asked for evidence that was in the first message.
//
// Whether evidence exists is a fact about the thread text. Chat adapters leave
// `ATTACHMENT_MARKER` where an image was, and that marker is the source of truth.

import { ATTACHMENT_MARKER, usefulEvidence } from "./kits.js";
import type { EvidenceItem } from "./kits.js";

export function threadHasAttachment(thread: string): boolean {
  return thread.includes(ATTACHMENT_MARKER);
}

/** Deliberately generic: the image is not read here, only recorded as existing. */
export function attachmentEvidence(): EvidenceItem {
  return { kind: "screenshot", value: "image attached in the thread" };
}

/**
 * Reconciles what the model reported with what the conversation proves.
 *
 * It only ADDS. Real evidence from the model (a URL, a record id) stays, because it is more
 * specific than "there is an image". The derived item goes in only when an attachment exists and
 * the model reported nothing usable.
 */
export function reconcileEvidence(evidence: readonly EvidenceItem[], thread: string): EvidenceItem[] {
  const useful = usefulEvidence(evidence);
  if (useful.length > 0) return useful;
  return threadHasAttachment(thread) ? [attachmentEvidence()] : [];
}
