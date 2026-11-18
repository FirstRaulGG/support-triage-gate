// Closing the loop with whoever opened the ticket. Pure: decides what to announce and builds it.
//
// The trail from thread to issue to pull request is only worth something if it comes BACK. Without
// this step the reporter opens a ticket and never hears what happened: the work takes place in the
// tracker, far from where they asked.
//
// THE ANTI-REPEAT GUARD HERE IS NOT `shouldReply`. That guard demands a new inbound message before
// speaking again, which is right for a conversation and wrong for a proactive notice (nobody will
// "reply" to authorise the preview link). Here the guard is STATE: `previewUrl` holds the last
// link posted and `resolvedAt` marks that the closing notice went out.

import { escapeHtml } from "./render.js";

export type PrState = "OPEN" | "MERGED" | "CLOSED";

export interface PrSnapshot {
  number: number;
  state: PrState;
  /** Public preview URL for the head commit. `null` while the build has not finished. */
  previewUrl: string | null;
}

/**
 * Where the issue left the ticket. Total and mutually exclusive on purpose: each issue falls into
 * exactly one, which stops the two consumers from disagreeing about the same ticket: re-triage,
 * which RELEASES it, and closing, which ENDS it.
 *
 * Closed as "not planned" leaves the classification open: the kind may be wrong and is worth
 * judging again. Closed because the work SHIPPED is the opposite: the ticket needs to be ended.
 * Closed with no stated reason counts as DELIVERED, the conservative choice of the two.
 */
export type IssueOutcome = "OPEN" | "ABANDONED" | "DELIVERED";

export function issueOutcome(issue: { state: string; stateReason?: string | null }): IssueOutcome {
  if (issue.state.toLowerCase() !== "closed") return "OPEN";
  return (issue.stateReason ?? "").toLowerCase() === "not_planned" ? "ABANDONED" : "DELIVERED";
}

export interface FollowupTicket {
  number: number;
  title: string;
  status: string;
  /** "MANUAL" = opened outside the chat, with no thread to answer in. */
  source?: string | null;
  issueNumber?: number | null;
  prNumber?: number | null;
  previewUrl?: string | null;
  resolvedAt?: Date | null;
}

export type FollowupAction =
  | { kind: "none"; reason: string }
  | { kind: "preview"; html: string; previewUrl: string }
  /** `html: null` = close the ticket WITHOUT posting (a ticket with no thread). */
  | { kind: "resolved"; html: string | null };

/**
 * The URL comes from the tracker's API, an external system, and is about to become an `<a href>`
 * in a channel with customers in it.
 *
 * Requiring https and a host on the configured allowlist shuts out `javascript:` and `data:` URLs
 * and stops a deployment from an unexpected provider from becoming a clickable link in your name.
 * An empty allowlist means no preview is ever posted: the safe default for an outward-facing link.
 */
export function isSafePreviewUrl(raw: string, allowedHostSuffixes: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;

  const host = url.hostname.toLowerCase();
  return allowedHostSuffixes
    .map((suffix) => suffix.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean)
    .some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export function renderPreviewReply(ticket: FollowupTicket, previewUrl: string, prNumber: number): string {
  return (
    `<p><b>Ticket #${ticket.number}</b>: ${escapeHtml(ticket.title)}</p>` +
    `<p>A fix is ready for you to try before it goes live:</p>` +
    `<p><a href="${escapeHtml(previewUrl)}">Open the preview environment</a> (PR #${prNumber})</p>` +
    `<p>Let me know here whether it solves the problem.</p>`
  );
}

export function renderMergedReply(ticket: FollowupTicket, prNumber: number): string {
  return (
    `<p><b>Ticket #${ticket.number}</b>: ${escapeHtml(ticket.title)}</p>` +
    `<p>The change was approved and merged (PR #${prNumber}).</p>` +
    `<p>If you still see the problem once it is released, please start a new thread and we will pick it up from there.</p>`
  );
}

/**
 * Decides the next notice for a ticket that has a pull request.
 *
 * `CLOSED` without a merge deliberately produces no automatic notice: a pull request closed by
 * hand means someone decided something this code cannot explain, and an automatic "it will not
 * ship" would be a guess.
 */
export function decideFollowup(
  ticket: FollowupTicket,
  pr: PrSnapshot,
  previewHosts: readonly string[],
): FollowupAction {
  // NOT POSTING is not the same as NOT CLOSING: a ticket's lifecycle does not depend on having a
  // thread. Treating them as one leaves every manual ticket stuck in review after the merge.
  const silent = ticket.source === "MANUAL";

  if (pr.state === "MERGED") {
    if (ticket.resolvedAt) return { kind: "none", reason: "ALREADY_RESOLVED" };
    return { kind: "resolved", html: silent ? null : renderMergedReply(ticket, pr.number) };
  }

  if (pr.state === "CLOSED") return { kind: "none", reason: "PR_CLOSED_WITHOUT_MERGE" };

  if (silent) return { kind: "none", reason: "NO_THREAD" };
  if (!pr.previewUrl) return { kind: "none", reason: "PREVIEW_NOT_READY" };
  if (!isSafePreviewUrl(pr.previewUrl, previewHosts)) return { kind: "none", reason: "PREVIEW_URL_REJECTED" };
  if (pr.previewUrl === ticket.previewUrl) return { kind: "none", reason: "PREVIEW_ALREADY_POSTED" };

  return {
    kind: "preview",
    html: renderPreviewReply(ticket, pr.previewUrl, pr.number),
    previewUrl: pr.previewUrl,
  };
}

// --- The other half of the cycle: the issue closes, the ticket closes ----------------------
//
// The path above only covers tickets that became a pull request. Many do not: an issue can be
// closed by decision, because it shipped elsewhere, or because the work happened outside the repo.
// Without this path such tickets stay READY forever.

export const ISSUE_CLOSABLE_STATUSES = ["READY", "IN_PROGRESS"] as const;

/**
 * The text does NOT claim the thing was delivered, deliberately. "Closed as completed" is what the
 * person who closed it declared, not proof that code shipped. Writing "it is working now" would
 * send the reporter looking for something that may not exist. The text ends the ticket and hands
 * the verification to the person who can do it: the reporter.
 *
 * It also does not promise to reopen in this thread, because nothing re-triages a resolved ticket.
 * A new thread does become a new ticket. Promise only what the code does.
 */
export function renderIssueClosedReply(ticket: FollowupTicket): string {
  return (
    `<p><b>Ticket #${ticket.number}</b>: ${escapeHtml(ticket.title)}</p>` +
    `<p>This ticket has been closed on our side.</p>` +
    `<p>If what you asked for is sorted, there is nothing else to do. If it is not, please start a ` +
    `new thread describing what you see today; it becomes a new ticket and we pick it up from there.</p>`
  );
}

export type IssueClosedAction = Extract<FollowupAction, { kind: "none" } | { kind: "resolved" }>;

/**
 * Decides whether a closed issue ends the ticket. The order of the guards matters:
 *
 *   1. `resolvedAt` first: a closed ticket is never closed or notified again.
 *   2. A pull request WINS over the issue. A ticket with one belongs to `decideFollowup`, which
 *      knows about previews and merges. Letting both look at it would post two contradicting
 *      notices in the same pass, because merging the pull request closes the linked issue.
 *   3. ABANDONED does not end it: it releases the ticket for re-triage.
 */
export function decideIssueClosed(ticket: FollowupTicket, outcome: IssueOutcome): IssueClosedAction {
  if (ticket.resolvedAt) return { kind: "none", reason: "ALREADY_RESOLVED" };
  if (!(ISSUE_CLOSABLE_STATUSES as readonly string[]).includes(ticket.status)) {
    return { kind: "none", reason: "STATUS_NOT_CLOSABLE" };
  }
  if (!ticket.issueNumber) return { kind: "none", reason: "NO_ISSUE" };
  if (ticket.prNumber) return { kind: "none", reason: "PULL_REQUEST_OWNS_THIS" };
  if (outcome !== "DELIVERED") return { kind: "none", reason: `ISSUE_${outcome}` };

  const silent = ticket.source === "MANUAL";
  return { kind: "resolved", html: silent ? null : renderIssueClosedReply(ticket) };
}
