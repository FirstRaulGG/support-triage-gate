// Replies posted back to the reporter, as HTML. Pure.

import { KIT_FIELDS } from "./kits.js";
import type { TicketKind } from "./kits.js";
import { MAX_QUESTIONS } from "./output.js";
import type { ReplyOpening } from "./policy.js";

/**
 * Chat APIs post HTML. Echoing a reporter's text unescaped is HTML injection into the channel, and
 * support messages are full of `<`, `>` and `&` (error messages, JSON snippets).
 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** For comparing a reply we would post with one already stored as plain text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*\/\s*(p|li|ol|ul)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export interface TicketRef {
  number: number;
  title: string;
  summary?: string | null;
  severity?: string | null;
}

export interface ModelQuestion {
  field: string;
  text: string;
}

const NEEDS_INFO_INTRO: Record<TicketKind, string> = {
  BUG: "To reproduce it I still need a few details:",
  INVESTIGATION: "To look into it I need a few things:",
  QUESTION: "To give you a proper answer I need to know:",
  FEATURE: "To understand the request, could you help me with:",
};

/**
 * Reply for an incomplete kit: asks ONLY what is missing, at most `MAX_QUESTIONS` items, in the
 * canonical order of the kind (predictable across tickets).
 *
 * The model's question WINS over the fixed text when it exists for that field, because it quotes
 * what the person wrote. The fixed text is the safety net: model down, invalid JSON, or a field
 * with no question still get asked. Plain, but never silent.
 */
export function renderNeedsInfoReply(
  ticket: TicketRef,
  missing: readonly string[],
  kind: TicketKind,
  opening: ReplyOpening = "first",
  questions: readonly ModelQuestion[] = [],
): string {
  const specs = KIT_FIELDS[kind];
  const ordered = specs.filter((spec) => missing.includes(spec.name)).slice(0, MAX_QUESTIONS);

  const fromModel = new Map(questions.map((q) => [q.field, q.text]));
  const items = ordered
    .map((spec) => `<li>${escapeHtml(fromModel.get(spec.name) ?? spec.question)}</li>`)
    .join("");

  const remaining = missing.length - ordered.length;
  const more =
    remaining > 0
      ? `<p>Once you reply I may have ${remaining} more quick question${remaining > 1 ? "s" : ""}.</p>`
      : "";

  const stillMissing = `<p>I still need:</p><ol>${items}</ol>`;

  // From the second round on, the opening must acknowledge that the person ANSWERED. Repeating
  // "logged as ticket #N" after they wrote again is what makes it look like nobody read it.
  if (opening === "answered") {
    return `<p>Thanks! I added your reply to <b>ticket #${ticket.number}</b>.</p>` + stillMissing + more;
  }

  // WE changed our mind. The opening owns that instead of blaming a silence that is not theirs.
  if (opening === "revised") {
    return (
      `<p>Back on <b>ticket #${ticket.number}</b>: I went over what I had asked for and trimmed the list.</p>` +
      stillMissing +
      more
    );
  }

  return (
    `<p>Logged as <b>ticket #${ticket.number}</b>: ${escapeHtml(ticket.title)}.</p>` +
    `<p>${NEEDS_INFO_INTRO[kind]}</p>` +
    `<ol>${items}</ol>` +
    more
  );
}

/**
 * Closing line for "I have everything", per kind. A QUESTION produces neither an issue nor a pull
 * request, so promising analysis there would describe work that will not exist: the deliverable is
 * the answer.
 */
const ACK_CLOSING: Record<TicketKind, string> = {
  BUG: "I have what I need to reproduce it. We will look into it and get back to you in this thread.",
  INVESTIGATION: "I have what I need to look into it. We will come back to this thread with the result.",
  QUESTION: "Understood. You will get the answer right here in this thread; this does not become a development task.",
  FEATURE: "Understood. We will evaluate the request and get back to you in this thread.",
};

const ACK_CLOSING_FOLLOW_UP: Record<TicketKind, string> = {
  BUG: "I now have what I need to reproduce it. We will carry on and get back to you here.",
  INVESTIGATION: "Noted along with the rest. We will carry on and come back here with the result.",
  QUESTION: "Noted. You will get the answer right here in this thread.",
  FEATURE: "Noted along with the request. We will get back to you here once it has been evaluated.",
};

/**
 * Reply for a complete kit. It does NOT promise a deadline or a fix: promising what will not be
 * kept is worse than not answering.
 *
 * The header ("Ticket #N: title, priority") is an INTRODUCTION. Introducing the ticket again each
 * time the person writes is what makes a bot sound like an autoresponder, so it only appears on
 * the first reply.
 */
export function renderAckReply(ticket: TicketRef, kind: TicketKind, opening: ReplyOpening = "first"): string {
  if (opening === "answered") {
    return (
      `<p>Thanks! I added your reply to <b>ticket #${ticket.number}</b>.</p>` +
      `<p>${ACK_CLOSING_FOLLOW_UP[kind]}</p>`
    );
  }

  if (opening === "revised") {
    return (
      `<p>Back on <b>ticket #${ticket.number}</b>: I reviewed it with what was already in this thread.</p>` +
      `<p>${ACK_CLOSING_FOLLOW_UP[kind]}</p>`
    );
  }

  const severity = ticket.severity ? ` (priority ${escapeHtml(ticket.severity)})` : "";
  const summary = ticket.summary ? `<p>${escapeHtml(ticket.summary)}</p>` : "";
  return (
    `<p><b>Ticket #${ticket.number}</b>: ${escapeHtml(ticket.title)}${severity}</p>` +
    summary +
    `<p>${ACK_CLOSING[kind]}</p>`
  );
}

/** The single, fixed reply to a confirmed announcement. A constant, not a template. */
export function renderAnnouncementReply(): string {
  return (
    "<p>This channel is for reporting problems. Release announcements are not logged as tickets. " +
    "If something is broken, please start a new thread with what happened, where, and a screenshot " +
    "if you have one.</p>"
  );
}
