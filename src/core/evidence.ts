// A ticket's evidence comes from the CONVERSATION, not from what the model says about it. Pure.
//
// The model proposes evidence items; this file keeps only the ones the thread can back up:
//
//   - a screenshot exists when the chat adapter left `ATTACHMENT_MARKER` in the reporter's text.
//     The model's own description of an image it never saw is not kept.
//   - a URL or a record id must be written in the thread, literally.
//   - an error message must be written in the thread, allowing for a shortened quote.
//
// It also works the other way: a reporter attaches a screenshot, the model does not mention it,
// and the attachment still counts.

import { isGrounded } from "./grounding.js";
import { ATTACHMENT_MARKER, usefulEvidence } from "./kits.js";
import type { EvidenceItem } from "./kits.js";

export function threadHasAttachment(thread: string): boolean {
  return thread.includes(ATTACHMENT_MARKER);
}

/** Generic: the image is not read here, only recorded as existing. */
export function attachmentEvidence(): EvidenceItem {
  return { kind: "screenshot", value: "image attached in the thread" };
}

function collapse(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function quotedIn(value: string, thread: string): boolean {
  const needle = collapse(value).replace(/[\s.,;:!?/)\]]+$/, "");
  return needle.length > 0 && collapse(thread).includes(needle);
}

/** "order #4821" is backed by a thread that says "order 4821": every id-like token is there. */
function idTokensIn(value: string, thread: string): boolean {
  const tokens = collapse(value).match(/[a-z0-9][a-z0-9_-]*\d[a-z0-9_-]*|\d{3,}/g) ?? [];
  const haystack = collapse(thread);
  return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
}

/** Whether the thread text backs up one item the model reported. */
export function isEvidenceInThread(item: EvidenceItem, thread: string): boolean {
  switch (item.kind) {
    case "screenshot":
      return threadHasAttachment(thread);
    case "url":
      return quotedIn(item.value, thread);
    case "record_id":
      return quotedIn(item.value, thread) || idTokensIn(item.value, thread);
    case "error":
      return quotedIn(item.value, thread) || isGrounded(item.value, thread);
  }
}

/**
 * Reconciles what the model reported with what the conversation proves.
 *
 * `thread` must be the reporter's text only. An item the thread does not back up is dropped, and
 * the field goes back to being a question.
 */
export function reconcileEvidence(evidence: readonly EvidenceItem[], thread: string): EvidenceItem[] {
  const quoted = usefulEvidence(evidence).filter(
    (item) => item.kind !== "screenshot" && isEvidenceInThread(item, thread),
  );
  return threadHasAttachment(thread) ? [attachmentEvidence(), ...quoted] : quoted;
}
