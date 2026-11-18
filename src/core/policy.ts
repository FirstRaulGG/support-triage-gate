// When may the gate speak, and when must a ticket be judged again? Pure.
//
// Replying is the only thing this project does in front of customers, so every reason to stay
// quiet is a line that can be read, pointed at and tested, instead of an `if` buried in a loop.

export type Direction = "INBOUND" | "OUTBOUND";

export interface PolicyMessage {
  direction: Direction;
  createdAt: Date;
}

/** Whitespace is not content: what changes the text must be something the person will READ. */
function normaliseReply(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * We reply only if (a) the last message is INBOUND and newer than our last reply, OR (b) we
 * re-judged the ticket after we last spoke AND what we would say now DIFFERS from what we said.
 *
 * Without (a) there are two loops: asking again on every poll while the reporter is silent, and
 * answering our own answer, since the message we post comes back on the next poll.
 *
 * (b) exists because a re-triage can produce a new question while the last PHYSICAL message in the
 * thread is our own previous reply; (a) alone would stay false forever and the question would
 * never be asked.
 *
 * The text comparison in (b) is what makes it safe. `triagedAt` alone does not prove there is
 * something new to say: any re-triage stamps it, including one that changes nothing. Comparing the
 * text keeps "re-triaged, same result" silent. It also converges: once we post, `lastOutboundAt`
 * is newer than the `triagedAt` that triggered it and (b) is false again.
 */
export function shouldReply(input: {
  messages: readonly PolicyMessage[];
  lastOutboundAt?: Date | null;
  triagedAt?: Date | null;
  /** Text we would post NOW. Without it clause (b) is off. */
  nextReply?: string | null;
  /** Text of our last message in the thread, as stored. */
  lastReply?: string | null;
}): boolean {
  const { messages, lastOutboundAt, triagedAt, nextReply, lastReply } = input;
  if (messages.length === 0) return false;

  const last = [...messages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).at(-1)!;

  const newInbound =
    last.direction === "INBOUND" &&
    (!lastOutboundAt || last.createdAt.getTime() > lastOutboundAt.getTime());

  const rejudgedSinceWeSpoke =
    !!triagedAt && (!lastOutboundAt || triagedAt.getTime() > lastOutboundAt.getTime());

  const somethingNewToSay =
    !!nextReply && normaliseReply(nextReply) !== normaliseReply(lastReply ?? "");

  return newInbound || (rejudgedSinceWeSpoke && somethingNewToSay);
}

/**
 * How a reply should open. Three DIFFERENT situations:
 *   - "first":    we have not spoken in this thread yet;
 *   - "answered": the reporter wrote after our last message;
 *   - "revised":  nobody answered; WE changed our mind (rules loosened, re-triage found more).
 *
 * Thanking someone for an answer they never gave is the same lie of tone as re-introducing the
 * ticket every time they write.
 */
export type ReplyOpening = "first" | "answered" | "revised";

export function replyOpening(input: {
  messages: readonly PolicyMessage[];
  lastOutboundAt?: Date | null;
}): ReplyOpening {
  const { messages, lastOutboundAt } = input;
  if (!lastOutboundAt) return "first";
  const answeredAfter = messages.some(
    (m) => m.direction === "INBOUND" && m.createdAt.getTime() > lastOutboundAt.getTime(),
  );
  return answeredAfter ? "answered" : "revised";
}

// ---------------------------------------------------------------------------
// Re-triage
// ---------------------------------------------------------------------------

/**
 * Statuses in which a new message can still change the judgement. READY is here on purpose: a
 * reply can reveal that the ticket was filed under the wrong kind, and re-triage is the only way
 * to fix that, including downwards, from READY to NEEDS_INFO, when the new kind needs a kit nobody
 * has filled in yet.
 */
export const RETRIAGEABLE_STATUSES = ["NEEDS_INFO", "READY"] as const;

export interface RetriageCandidate {
  status: string;
  triagedAt?: Date | null;
  lastInboundAt?: Date | null;
  issueNumber?: number | null;
  /**
   * Was the issue closed as "not planned"? Comes from the tracker, hence optional: absent means
   * "not checked" and keeps the ticket held.
   */
  issueAbandoned?: boolean;
}

/**
 * Did the reporter write after we judged the ticket? Then it must be judged AGAIN.
 *
 * Without this the cycle is: we ask, they answer, the answer is stored and nothing looks at it,
 * and the next reply is built from the frozen list of missing fields. The same questions again.
 * Asking and then ignoring the answer is worse than not asking.
 *
 * `triagedAt` is the anchor, not `lastOutboundAt`: the question is "did information arrive AFTER
 * the last judgement", not "after I spoke". It is also what makes this converge, since a re-triage
 * stamps `triagedAt` again and each new message costs at most one pass.
 *
 * A ticket with a LIVE issue is left alone: its title and kind already became an issue, and
 * rewriting them here would let the two sides drift apart unnoticed. An issue closed as "not
 * planned" is not a live contract.
 */
export function needsRetriage(ticket: RetriageCandidate): boolean {
  if (!(RETRIAGEABLE_STATUSES as readonly string[]).includes(ticket.status)) return false;
  if (ticket.issueNumber && !ticket.issueAbandoned) return false;
  if (!ticket.triagedAt || !ticket.lastInboundAt) return false;
  return ticket.lastInboundAt.getTime() > ticket.triagedAt.getTime();
}

// ---------------------------------------------------------------------------
// Auto-reply
// ---------------------------------------------------------------------------

export type ReplyDecision = { send: true } | { send: false; reason: string };

export interface AutoReplyTicket {
  status: string;
  severity?: string | null;
  /** "MANUAL" tickets were opened outside the chat and have no thread to answer in. */
  source?: string | null;
  messages: readonly PolicyMessage[];
  lastOutboundAt?: Date | null;
  triagedAt?: Date | null;
  nextReply?: string | null;
  lastReply?: string | null;
}

/**
 * Decides whether the gate answers on its own.
 *
 * The rule that matters most is P1: real urgency deserves someone awake, not a scheduler. Getting
 * the tone wrong on a critical ticket costs more than the delay of waiting for a person.
 */
export function decideAutoReply(ticket: AutoReplyTicket, enabled: boolean): ReplyDecision {
  if (!enabled) return { send: false, reason: "AUTO_REPLY_DISABLED" };
  if (ticket.source === "MANUAL") return { send: false, reason: "NO_THREAD" };
  if (ticket.status !== "NEEDS_INFO" && ticket.status !== "READY") {
    return { send: false, reason: "STATUS_NOT_ANSWERABLE" };
  }
  if (ticket.severity === "P1") return { send: false, reason: "P1_NEEDS_HUMAN" };
  if (!shouldReply(ticket)) return { send: false, reason: "SHOULD_NOT_REPLY" };
  return { send: true };
}
