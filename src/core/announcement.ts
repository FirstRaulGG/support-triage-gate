// A "we shipped X" announcement posted in the support channel is not a ticket. Pure.
//
// Channels get used for both: reports ("the export button does nothing") and announcements
// ("[SHIPPED] new export button"). Treated as a report, an announcement gets triaged as a feature
// request and its own author is asked how the missing feature affects them.
//
// THE TAG ALONE DOES NOT DECIDE. A tag whitelist used as a gate before the model breaks on the
// message the channel will certainly produce:
//
//     "[FIXED] calendar sync
//      it is happening again, new events are not showing up"
//
// That is a REGRESSION report, the most important message a support channel carries, and a closed
// rule would silence it with "announcements are not tickets".
//
// So dismissing a message takes TWO keys that must agree: the model classifies it as an
// announcement having read the whole body, AND the text opens with a known tag. The tag alone
// never silences a report; the model alone never silences an untagged message. The mistake needs
// both to fail together, and when they disagree the ticket goes to a person.

import { ATTACHMENT_MARKER } from "./kits.js";
import { shouldReply } from "./policy.js";
import type { PolicyMessage, ReplyDecision } from "./policy.js";

export const DEFAULT_ANNOUNCEMENT_TAGS = ["SHIPPED", "RELEASED", "FIXED"] as const;

function normaliseTag(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}

/**
 * A HINT, not a verdict: does the text OPEN with a known announcement tag?
 *
 *   1. Empty text is a report (the safe default).
 *   2. Attachment markers at the very start are skipped: they are system metadata, not the
 *      author's bracket.
 *   3. Only the START counts. A bracket in the middle of the body is not a tag.
 *   4. The bracket content must match the closed list exactly. "[URGENT] the PDF fails" has a
 *      bracket and is still a report.
 */
export function looksLikeAnnouncement(
  text: string | null | undefined,
  tags: readonly string[] = DEFAULT_ANNOUNCEMENT_TAGS,
): boolean {
  let rest = (text ?? "").trim();
  if (!rest) return false;

  while (rest.startsWith(ATTACHMENT_MARKER)) {
    rest = rest.slice(ATTACHMENT_MARKER.length).trimStart();
  }

  if (!rest.startsWith("[")) return false;
  const close = rest.indexOf("]");
  if (close === -1) return false;

  const known = new Set(tags.map(normaliseTag));
  return known.has(normaliseTag(rest.slice(1, close)));
}

export type AnnouncementVerdict = "ANNOUNCEMENT" | "NOT_ANNOUNCEMENT" | "DISPUTED";

/**
 * Combines the two keys. `DISPUTED` means exactly one of them fired: the model called it an
 * announcement but there is no tag. The gate refuses to dismiss it and hands it to a person.
 * (A tag the model did not confirm is simply a report; the model read the body.)
 */
export function announcementVerdict(input: {
  modelSaysAnnouncement: boolean;
  firstMessageText: string | null | undefined;
  tags?: readonly string[];
}): AnnouncementVerdict {
  if (!input.modelSaysAnnouncement) return "NOT_ANNOUNCEMENT";
  return looksLikeAnnouncement(input.firstMessageText, input.tags) ? "ANNOUNCEMENT" : "DISPUTED";
}

export interface AnnouncementReplyTicket {
  status: string;
  rejectionKind?: string | null;
  source?: string | null;
  messages: readonly PolicyMessage[];
  lastOutboundAt?: Date | null;
}

/**
 * A sibling of `decideAutoReply`, not an extension of it. That function never answers a REJECTED
 * ticket, and widening it would also answer duplicates and declined requests. This one speaks only
 * to a confirmed announcement, once: REJECTED is never re-triaged, and after we post,
 * `lastOutboundAt` is newer than the only inbound message.
 */
export function decideAnnouncementReply(ticket: AnnouncementReplyTicket, enabled: boolean): ReplyDecision {
  if (!enabled) return { send: false, reason: "AUTO_REPLY_DISABLED" };
  if (ticket.source === "MANUAL") return { send: false, reason: "NO_THREAD" };
  if (ticket.status !== "REJECTED") return { send: false, reason: "STATUS_NOT_REJECTED" };
  if (ticket.rejectionKind !== "ANNOUNCEMENT") return { send: false, reason: "NOT_AN_ANNOUNCEMENT" };
  if (!shouldReply({ messages: ticket.messages, lastOutboundAt: ticket.lastOutboundAt })) {
    return { send: false, reason: "SHOULD_NOT_REPLY" };
  }
  return { send: true };
}
