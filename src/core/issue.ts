// Turns a READY ticket into an issue: title, body and labels. Pure; the tracker adapter posts it.
//
// The issue becomes the source of truth for the WORK; the ticket stays the source of truth for the
// CONVERSATION. That is why the body always links back to the thread: whoever implements it needs
// to be able to ask more, and the history does not live in the tracker.

import { UNKNOWN, meaningful } from "./kits.js";
import type { TicketKind } from "./kits.js";

export interface IssueTicket {
  number: number;
  kind: TicketKind;
  title: string;
  summary?: string | null;
  area?: string | null;
  severity?: string | null;
  reporterName?: string | null;
  kit: unknown;
  threadUrl?: string | null;
}

/** Prefix per kind, so the issue list can be scanned without opening anything. */
export const KIND_LABEL: Record<TicketKind, string> = {
  BUG: "bug",
  INVESTIGATION: "investigation",
  QUESTION: "question",
  FEATURE: "feature",
};

/**
 * Kinds that do NOT become an issue.
 *
 * The deliverable of a QUESTION is the ANSWER in the thread, not a pull request. An issue there
 * creates development work nobody asked for and an item that will never have a commit.
 *
 * INVESTIGATION does become an issue on purpose: it takes effort, has a deliverable and deserves a
 * trail. The line is not "is there code", it is "does someone need to STOP and produce something".
 */
export const KINDS_WITHOUT_ISSUE: readonly TicketKind[] = ["QUESTION"];

export function shouldCreateIssue(kind: TicketKind): boolean {
  return !KINDS_WITHOUT_ISSUE.includes(kind);
}

const TITLE_MAX = 100;

export function renderIssueTitle(ticket: IssueTicket): string {
  const prefix = `[${KIND_LABEL[ticket.kind]}] `;
  const suffix = ` (ticket #${ticket.number})`;
  const room = TITLE_MAX - prefix.length - suffix.length;
  const body = ticket.title.length > room ? `${ticket.title.slice(0, room - 1)}…` : ticket.title;
  return `${prefix}${body}${suffix}`;
}

/** Derived, never improvised. `support` marks the origin, separating these from hand-made issues. */
export function renderIssueLabels(ticket: IssueTicket): string[] {
  const labels = ["support", `kind:${KIND_LABEL[ticket.kind]}`];
  if (ticket.severity) labels.push(`sev:${ticket.severity}`);
  if (ticket.area && ticket.area !== UNKNOWN) labels.push(`area:${ticket.area}`);
  return labels;
}

/** Switches the fence so a kit containing ``` cannot break the markdown block. */
function fencedJson(value: unknown): string {
  const json = JSON.stringify(value, null, 2) ?? "null";
  const fence = json.includes("```") ? "~~~" : "```";
  return `${fence}json\n${json}\n${fence}`;
}

/**
 * Omits the line when the value only describes an absence. An issue is read by people, and
 * "**When:** unknown" is worse than no line: it takes space, looks like data, and is not.
 */
function bullet(label: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = meaningful(String(value));
  return text ? `- **${label}:** ${text}` : null;
}

function present(lines: (string | null)[]): string[] {
  return lines.filter((line): line is string => line !== null);
}

function formatScope(scope: unknown): string | null {
  if (!scope || typeof scope !== "object") return null;
  const { breadth, customerRef } = scope as { breadth?: unknown; customerRef?: unknown };
  const breadthText = meaningful(String(breadth ?? ""));
  if (!breadthText) return null;
  const ref = meaningful(String(customerRef ?? ""));
  return ref ? `${breadthText.replace(/_/g, " ")}: ${ref}` : breadthText.replace(/_/g, " ");
}

function formatTarget(target: unknown): string | null {
  if (!target || typeof target !== "object") return null;
  const { kind, ref } = target as { kind?: unknown; ref?: unknown };
  const kindText = meaningful(String(kind ?? ""));
  if (!kindText) return null;
  const refText = meaningful(String(ref ?? ""));
  return refText ? `${kindText}: ${refText}` : `${kindText} (to be identified)`;
}

/**
 * The kit goes in as JSON AND as prose. The JSON is the contract (and what automation reads); the
 * prose is what a person reads. Duplicating it is cheap and nobody has to decode JSON to
 * understand a ticket.
 */
export function renderIssueBody(ticket: IssueTicket): string {
  const kit = (ticket.kit ?? {}) as Record<string, unknown>;
  const parts: string[] = [];

  if (ticket.summary) parts.push(ticket.summary, "");

  parts.push(
    ...present([
      bullet("Ticket", `#${ticket.number}`),
      bullet("Kind", KIND_LABEL[ticket.kind]),
      bullet("Severity", ticket.severity),
      bullet("Area", ticket.area),
      bullet("Reported by", ticket.reporterName),
    ]),
    "",
  );

  if (ticket.kind === "BUG") {
    parts.push("## Reproduction", "");
    const steps = Array.isArray(kit.steps) ? (kit.steps as unknown[]).map(String) : [];
    if (steps.length) parts.push(...steps.map((step, i) => `${i + 1}. ${step}`), "");
    parts.push(
      ...present([
        bullet("Where", kit.location),
        bullet("Seen by", kit.role),
        bullet("Expected", kit.expected),
        bullet("Actual", kit.actual),
        bullet("When", kit.occurredAt),
        bullet("Scope", formatScope(kit.scope)),
        bullet("Frequency", kit.frequency),
        bullet("Impact", kit.impact),
      ]),
      "",
    );
  } else if (ticket.kind === "INVESTIGATION") {
    parts.push("## What to look into", "");
    parts.push(
      ...present([
        bullet("Subject", kit.subject),
        bullet("Target", formatTarget(kit.target)),
        bullet("Period", kit.period),
        bullet("Deliverable", typeof kit.deliverable === "string" ? kit.deliverable.replace(/_/g, " ") : null),
      ]),
      "",
    );
  } else if (ticket.kind === "QUESTION") {
    parts.push("## Question", "");
    parts.push(...present([bullet("Question", kit.question), bullet("Where", kit.location)]), "");
  } else {
    parts.push("## Request", "");
    parts.push(
      ...present([
        bullet("Problem today", kit.problem),
        bullet("Desired outcome", kit.desiredOutcome),
        bullet("Impact", kit.impact),
      ]),
      "",
    );
  }

  const evidence = Array.isArray(kit.evidence) ? (kit.evidence as Record<string, unknown>[]) : [];
  if (evidence.length) {
    parts.push("## Evidence", "");
    parts.push(...evidence.map((item) => `- \`${String(item.kind)}\`: ${String(item.value)}`), "");
  }

  parts.push("## Full kit", "", fencedJson(ticket.kit), "");

  if (ticket.threadUrl) parts.push(`[Original thread](${ticket.threadUrl})`, "");

  parts.push(`<sub>Opened automatically by the support triage gate from ticket #${ticket.number}.</sub>`);
  return parts.join("\n");
}
