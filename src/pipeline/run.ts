// One full cycle of the gate: poll, triage, reply, open issues, close the loop.
//
// This file only ORCHESTRATES. Every decision it acts on comes from a pure function in `core/`;
// if a rule is worth arguing about, it lives there with a test, not here in an `if`.

import { announcementVerdict, decideAnnouncementReply } from "../core/announcement.js";
import { decideFollowup, decideIssueClosed } from "../core/followup.js";
import type { FollowupAction, FollowupTicket } from "../core/followup.js";
import { renderIssueBody, renderIssueLabels, renderIssueTitle, shouldCreateIssue } from "../core/issue.js";
import { KIT_FIELDS } from "../core/kits.js";
import { MAX_QUESTIONS } from "../core/output.js";
import { decideAutoReply, needsRetriage, replyOpening } from "../core/policy.js";
import { htmlToText, renderAckReply, renderAnnouncementReply, renderNeedsInfoReply } from "../core/render.js";
import { branchNameForTicket } from "../core/work.js";
import { ZERO_USAGE, addUsage } from "../llm/types.js";
import type { LlmClient, LlmUsage } from "../llm/types.js";
import type { ChatSource } from "../sources/types.js";
import type { Ticket, TicketMessage, TicketPatch, TicketStore } from "../store/types.js";
import type { IssueTracker } from "../trackers/types.js";
import { autoTriage } from "../triage/auto-triage.js";
import type { IngestResult } from "./ingest.js";
import { pollAndIngest } from "./ingest.js";

export interface GateDeps {
  store: TicketStore;
  llm: LlmClient;
  /** Absent = no polling and no replies (tickets can still be created manually). */
  source?: ChatSource | null;
  /** Absent = tickets stop at READY. */
  tracker?: IssueTracker | null;
}

export interface GateOptions {
  /** Post replies in the chat. OFF by default: reading and judging never write anywhere external. */
  autoReply?: boolean;
  /** Open issues for READY tickets. OFF by default, for the same reason. */
  autoIssue?: boolean;
  productName?: string;
  areas?: readonly string[];
  announcementTags?: readonly string[];
  /** Host suffixes a preview link must match before it is shown to a reporter. */
  previewHosts?: readonly string[];
  selfAuthorIds?: readonly string[];
  firstPollDays?: number;
  /** After this many failed triage attempts a ticket is handed to a person instead of retried. */
  maxTriageFailures?: number;
  now?: () => Date;
}

export interface CycleEvent {
  ticket: number;
  step: "triage" | "reply" | "issue" | "followup";
  outcome: string;
  detail?: string;
}

export interface CycleReport {
  ingest: IngestResult | null;
  events: CycleEvent[];
  errors: CycleEvent[];
  usage: LlmUsage;
}

const GATE_AUTHOR = "support-triage-gate";

function toPolicyMessages(messages: readonly TicketMessage[]) {
  return messages.map((m) => ({ direction: m.direction, createdAt: m.createdAt }));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Gate {
  constructor(
    private readonly deps: GateDeps,
    private readonly options: GateOptions = {},
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** Runs every step once. A failure in one ticket never stops the others. */
  async runCycle(): Promise<CycleReport> {
    const report: CycleReport = { ingest: null, events: [], errors: [], usage: ZERO_USAGE };

    if (this.deps.source) {
      report.ingest = await pollAndIngest(this.deps.source, this.deps.store, {
        firstPollDays: this.options.firstPollDays,
        selfAuthorIds: this.options.selfAuthorIds,
        now: this.options.now,
      });
    }

    await this.forEachTicket(report, "triage", (ticket) => this.triageIfDue(ticket, report));
    await this.forEachTicket(report, "reply", (ticket) => this.replyIfDue(ticket, report));
    await this.forEachTicket(report, "issue", (ticket) => this.openIssueIfDue(ticket, report));
    await this.forEachTicket(report, "followup", (ticket) => this.followUpIfDue(ticket, report));

    return report;
  }

  private async forEachTicket(
    report: CycleReport,
    step: CycleEvent["step"],
    work: (ticket: Ticket) => Promise<void>,
  ): Promise<void> {
    // Re-listed per step on purpose: each step acts on what the previous one stored.
    for (const ticket of await this.deps.store.listTickets()) {
      try {
        await work(ticket);
      } catch (err) {
        report.errors.push({ ticket: ticket.number, step, outcome: "ERROR", detail: errorText(err) });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Triage
  // -------------------------------------------------------------------------

  private async triageIfDue(ticket: Ticket, report: CycleReport): Promise<void> {
    const maxFailures = this.options.maxTriageFailures ?? 3;
    let issueAbandoned = false;

    if (ticket.status === "NEW") {
      if (ticket.triageFailures >= maxFailures) return;
    } else {
      const base = {
        status: ticket.status,
        triagedAt: ticket.triagedAt,
        lastInboundAt: ticket.lastInboundAt,
        issueNumber: ticket.issueNumber,
      };
      // Cheap check first: only ask the tracker when everything else already says "re-triage".
      if (!needsRetriage({ ...base, issueAbandoned: true })) return;
      if (ticket.issueNumber) {
        if (!this.deps.tracker) return;
        issueAbandoned = (await this.deps.tracker.getIssueOutcome(ticket.issueNumber)) === "ABANDONED";
      }
      if (!needsRetriage({ ...base, issueAbandoned })) return;
    }

    await this.triage(ticket, report, { releaseIssue: issueAbandoned });
  }

  /** Triage one ticket now, whatever its state. Used by the cycle and by the CLI. */
  async triage(ticket: Ticket, report: CycleReport, flags: { releaseIssue?: boolean } = {}): Promise<Ticket> {
    const { store, llm } = this.deps;
    const messages = await store.listMessages(ticket.id);

    const result = await autoTriage(
      {
        ticketNumber: ticket.number,
        reporterName: ticket.reporterName,
        messages: messages.map((m) => ({
          direction: m.direction,
          author: m.author,
          at: m.createdAt.toISOString(),
          text: m.text,
        })),
        previous: ticket.kind ? { kind: ticket.kind, kit: ticket.kit } : null,
      },
      llm,
      {
        productName: this.options.productName,
        areas: this.options.areas,
        announcementTags: this.options.announcementTags,
      },
    );
    report.usage = addUsage(report.usage, result.usage);

    if (!result.ok) {
      const failures = ticket.triageFailures + 1;
      const giveUp = failures >= (this.options.maxTriageFailures ?? 3);
      report.errors.push({ ticket: ticket.number, step: "triage", outcome: "TRIAGE_FAILED", detail: result.error });
      // A ticket the model cannot triage must not retry forever in silence. After a few attempts
      // it is put in front of a person, with the reason. This holds for a re-triage too: a ticket
      // that was already triaged keeps its kit, but stops being re-read every cycle.
      return store.updateTicket(ticket.id, {
        triageFailures: failures,
        ...(giveUp ? { status: "NEEDS_HUMAN", triageNote: `automatic triage failed: ${result.error}` } : {}),
      });
    }

    const { output, evaluation } = result;
    let status: Ticket["status"] = result.status;
    let triageNote = output.triageNote ?? null;
    let rejectionKind = output.status === "REJECTED" ? (output.rejectionKind ?? "OTHER") : null;

    if (rejectionKind === "ANNOUNCEMENT") {
      const firstInbound = messages.find((m) => m.direction === "INBOUND");
      const verdict = announcementVerdict({
        modelSaysAnnouncement: true,
        firstMessageText: firstInbound?.text,
        tags: this.options.announcementTags,
      });
      if (verdict === "DISPUTED") {
        // One key out of two. The gate will not dismiss a possible report on the model's word.
        status = "NEEDS_HUMAN";
        rejectionKind = null;
        triageNote = "the model read this as a release announcement, but it has no known tag: please check";
      }
    }

    // Any other rejection is the model's word alone, and a wrong one would bury a real report in
    // silence: a rejected ticket is never re-read and nobody is told. The model may propose it;
    // a person confirms it.
    if (status === "REJECTED" && rejectionKind !== "ANNOUNCEMENT") {
      status = "NEEDS_HUMAN";
      triageNote = `the model would dismiss this as ${rejectionKind ?? "OTHER"}: ${triageNote ?? "no reason given"}`;
    }

    // Only questions about fields that are actually missing survive, in a bounded number.
    const questions = (output.questions ?? []).filter((q) => evaluation.missing.includes(q.field));

    const patch: TicketPatch = {
      status,
      kind: output.kind,
      kit: output.kit,
      kitMissing: evaluation.missing,
      questions,
      title: output.title,
      summary: output.summary,
      area: output.area,
      severity: output.severity,
      triageNote,
      rejectionKind,
      triagedAt: this.now(),
      triageFailures: 0,
      // An issue closed as "not planned" no longer binds the ticket: a fresh one may be opened.
      ...(flags.releaseIssue ? { issueNumber: null, issueUrl: null, branchName: null, prNumber: null } : {}),
    };

    report.events.push({
      ticket: ticket.number,
      step: "triage",
      outcome: status,
      detail: [
        status === "REJECTED"
          ? `not a ticket: ${rejectionKind ?? "OTHER"}`
          : status === "NEEDS_HUMAN"
            ? (triageNote ?? "held for a person")
            : evaluation.missing.length
            ? `missing: ${evaluation.missing.join(", ")}`
            : output.kind,
        ...result.corrections.map((error) => `model output refused once: ${error}`),
      ].join("; "),
    });
    return store.updateTicket(ticket.id, patch);
  }

  // -------------------------------------------------------------------------
  // Replies
  // -------------------------------------------------------------------------

  /** What we would say now, plus a key that changes only when the SUBSTANCE of it changes. */
  private draftReply(ticket: Ticket, messages: readonly TicketMessage[]): { html: string; key: string } | null {
    if (!ticket.kind) return null;
    const ref = { number: ticket.number, title: ticket.title, summary: ticket.summary, severity: ticket.severity };
    const opening = replyOpening({ messages: toPolicyMessages(messages), lastOutboundAt: ticket.lastOutboundAt });

    if (ticket.status === "NEEDS_INFO") {
      const asked = KIT_FIELDS[ticket.kind]
        .map((spec) => spec.name)
        .filter((name) => ticket.kitMissing.includes(name))
        .slice(0, MAX_QUESTIONS);
      const texts = asked.map((name) => ticket.questions.find((q) => q.field === name)?.text ?? "");
      return {
        html: renderNeedsInfoReply(ref, ticket.kitMissing, ticket.kind, opening, ticket.questions),
        key: JSON.stringify(["NEEDS_INFO", ticket.kind, asked, texts]),
      };
    }
    if (ticket.status === "READY") {
      return { html: renderAckReply(ref, ticket.kind, opening), key: JSON.stringify(["READY", ticket.kind]) };
    }
    return null;
  }

  private async replyIfDue(ticket: Ticket, report: CycleReport): Promise<void> {
    const enabled = this.options.autoReply === true && !!this.deps.source;
    const messages = await this.deps.store.listMessages(ticket.id);
    const policyMessages = toPolicyMessages(messages);

    if (ticket.status === "REJECTED") {
      const decision = decideAnnouncementReply(
        { ...ticket, messages: policyMessages },
        // Evaluated as if enabled, so a dry run can report what WOULD have been said.
        true,
      );
      if (!decision.send) return;
      await this.post(ticket, renderAnnouncementReply(), "ANNOUNCEMENT", enabled, report);
      return;
    }

    const draft = this.draftReply(ticket, messages);
    if (!draft) return;

    const decision = decideAutoReply(
      {
        ...ticket,
        messages: policyMessages,
        // Compared by substance, not by rendered text: the opening line legitimately differs
        // between rounds, and that alone must never count as "something new to say".
        nextReply: draft.key,
        lastReply: ticket.lastReplyKey,
      },
      true,
    );
    if (!decision.send) {
      if (decision.reason === "P1_NEEDS_HUMAN") {
        report.events.push({ ticket: ticket.number, step: "reply", outcome: "HELD_FOR_HUMAN", detail: "P1" });
      }
      return;
    }

    const posted = await this.post(ticket, draft.html, ticket.status, enabled, report);
    if (posted) await this.deps.store.updateTicket(ticket.id, { lastReplyKey: draft.key });
  }

  /** Posts in the ticket's thread and records it. With replies off, only reports the intent. */
  private async post(
    ticket: Ticket,
    html: string,
    label: string,
    enabled: boolean,
    report: CycleReport,
    step: CycleEvent["step"] = "reply",
  ): Promise<boolean> {
    const source = this.deps.source;
    if (!enabled || !source || ticket.source !== "CHAT") {
      report.events.push({ ticket: ticket.number, step, outcome: "WOULD_POST", detail: label });
      return false;
    }

    const sent = await source.postReply(ticket.threadId, html);
    await this.deps.store.recordOutbound(ticket.id, {
      // The same id the message will have when the next poll returns it, so it is stored once and
      // keeps its OUTBOUND direction.
      externalId: `${source.channelKey}:${ticket.threadId}:${sent.id}`,
      author: GATE_AUTHOR,
      text: htmlToText(html),
      imageUrls: [],
      createdAt: sent.createdAt,
    });
    report.events.push({ ticket: ticket.number, step, outcome: "POSTED", detail: label });
    return true;
  }

  // -------------------------------------------------------------------------
  // Issues
  // -------------------------------------------------------------------------

  private async openIssueIfDue(ticket: Ticket, report: CycleReport): Promise<void> {
    const { tracker, source, store } = this.deps;
    if (ticket.status !== "READY" || ticket.issueNumber || !ticket.kind) return;
    if (!shouldCreateIssue(ticket.kind)) return;

    if (!tracker || this.options.autoIssue !== true) {
      report.events.push({ ticket: ticket.number, step: "issue", outcome: "WOULD_OPEN_ISSUE" });
      return;
    }

    const issueTicket = {
      number: ticket.number,
      kind: ticket.kind,
      title: ticket.title,
      summary: ticket.summary,
      area: ticket.area,
      severity: ticket.severity,
      reporterName: ticket.reporterName,
      kit: ticket.kit,
      threadUrl: ticket.source === "CHAT" ? (source?.threadUrl(ticket.threadId) ?? null) : null,
    };
    const issue = await tracker.createIssue({
      title: renderIssueTitle(issueTicket),
      body: renderIssueBody(issueTicket),
      labels: renderIssueLabels(issueTicket),
    });

    await store.updateTicket(ticket.id, {
      issueNumber: issue.number,
      issueUrl: issue.url,
      // Stored, not re-derived later: the title may change after work has started.
      branchName: branchNameForTicket(ticket),
    });
    report.events.push({ ticket: ticket.number, step: "issue", outcome: "ISSUE_OPENED", detail: `#${issue.number}` });
  }

  // -------------------------------------------------------------------------
  // Follow-up
  // -------------------------------------------------------------------------

  private async followUpIfDue(ticket: Ticket, report: CycleReport): Promise<void> {
    const { tracker, store } = this.deps;
    if (!tracker || !ticket.issueNumber || ticket.resolvedAt) return;
    if (!["READY", "IN_PROGRESS", "IN_REVIEW"].includes(ticket.status)) return;

    let current = ticket;
    if (!current.prNumber && current.branchName) {
      const prNumber = await tracker.findPullRequestForBranch(current.branchName);
      if (prNumber) current = await store.updateTicket(current.id, { prNumber, status: "IN_REVIEW" });
    }

    const followupTicket: FollowupTicket = current;
    let action: FollowupAction;
    if (current.prNumber) {
      const pr = await tracker.getPullRequest(current.prNumber);
      action = decideFollowup(followupTicket, pr, this.options.previewHosts ?? []);
    } else {
      action = decideIssueClosed(followupTicket, await tracker.getIssueOutcome(current.issueNumber!));
    }

    const enabled = this.options.autoReply === true && !!this.deps.source;

    if (action.kind === "preview") {
      const posted = await this.post(current, action.html, "PREVIEW", enabled, report, "followup");
      // Stored only once actually posted, so turning replies on later still sends the link.
      if (posted) await store.updateTicket(current.id, { previewUrl: action.previewUrl });
      return;
    }

    if (action.kind === "resolved") {
      if (action.html) await this.post(current, action.html, "RESOLVED", enabled, report, "followup");
      // Closing does not depend on having been able to post: the lifecycle is not the thread's.
      await store.updateTicket(current.id, { status: "RESOLVED", resolvedAt: this.now() });
      report.events.push({ ticket: current.number, step: "followup", outcome: "RESOLVED" });
    }
  }
}
