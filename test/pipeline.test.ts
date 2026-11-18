import { describe, expect, it } from "vitest";

import { ATTACHMENT_MARKER } from "../src/core/kits.js";
import { runDemo } from "../src/demo.js";
import { ScriptedLlm } from "../src/llm/scripted.js";
import type { Script } from "../src/llm/scripted.js";
import { pollAndIngest } from "../src/pipeline/ingest.js";
import { Gate } from "../src/pipeline/run.js";
import type { GateOptions } from "../src/pipeline/run.js";
import { MEMORY_SELF_ID, MemoryChatSource } from "../src/sources/memory.js";
import { MemoryTicketStore } from "../src/store/memory.js";
import { MemoryTracker } from "../src/trackers/memory.js";
import { bugOutput, completeBugKit } from "./helpers.js";

const REPORT = `The export button gives an empty file on every workspace.\n${ATTACHMENT_MARKER}`;

function setup(scripts: Script[], options: GateOptions = {}) {
  let clock = Date.UTC(2025, 0, 15, 12, 0, 0);
  const now = () => new Date((clock += 1000));
  const source = new MemoryChatSource("test:support", now);
  const store = new MemoryTicketStore();
  const tracker = new MemoryTracker();
  const llm = new ScriptedLlm(scripts);
  const gate = new Gate(
    { store, llm, source, tracker },
    { autoReply: true, autoIssue: true, selfAuthorIds: [MEMORY_SELF_ID], previewHosts: ["preview.example.test"], now, ...options },
  );
  return { source, store, tracker, llm, gate, now };
}

const completeScript: Script = { match: "export button", triage: [bugOutput()] };

describe("ingestion", () => {
  it("opens one ticket per thread, stores each message once and moves the cursor", async () => {
    const { source, store, now } = setup([]);
    const root = source.add({ author: "Dana", text: "first line is the title\nmore detail" });
    source.add({ threadId: root.id, author: "Dana", text: "a reply" });

    const first = await pollAndIngest(source, store, { now });
    expect(first).toMatchObject({ fetched: 2, threads: 1, newMessages: 2 });
    expect((await store.getTicket(1))!.title).toBe("first line is the title");

    const second = await pollAndIngest(source, store, { now });
    expect(second).toMatchObject({ fetched: 0, newMessages: 0, cursorMovedTo: null });
  });

  it("does not filter any root message out", async () => {
    const { source, store, now } = setup([]);
    source.add({ author: "Dana", text: "no mention, no tag, just a problem" });
    await pollAndIngest(source, store, { now });
    expect(await store.listTickets()).toHaveLength(1);
  });

  it("keeps listening to a resolved thread", async () => {
    const { source, store, now } = setup([]);
    const root = source.add({ author: "Dana", text: "something broke" });
    await pollAndIngest(source, store, { now });
    await store.updateTicket((await store.getTicket(1))!.id, { status: "RESOLVED" });

    source.add({ threadId: root.id, author: "Dana", text: "it is back" });
    expect((await pollAndIngest(source, store, { now })).newMessages).toBe(1);
  });
});

describe("a complete report", () => {
  it("goes from thread to READY, acknowledgement and issue in one cycle", async () => {
    const { source, store, tracker, gate } = setup([completeScript]);
    source.add({ author: "Dana Whitfield", text: REPORT });

    const report = await gate.runCycle();
    const ticket = (await store.getTicket(1))!;

    expect(report.errors).toEqual([]);
    expect(ticket).toMatchObject({ status: "READY", kind: "BUG", issueNumber: 101, branchName: "support/1-report-export-produces-an-empty-file" });
    expect(source.posted).toHaveLength(1);
    expect(tracker.issues[0]!.title).toBe("[bug] Report export produces an empty file (ticket #1)");
    expect(tracker.issues[0]!.body).toContain("https://chat.example.test/threads/");
  });

  it("does nothing more on the next cycles: no repeated reply, no second issue", async () => {
    const { source, tracker, gate, llm } = setup([completeScript]);
    source.add({ author: "Dana Whitfield", text: REPORT });

    await gate.runCycle();
    const second = await gate.runCycle();
    await gate.runCycle();

    expect(second.events).toEqual([]);
    expect(source.posted).toHaveLength(1);
    expect(tracker.issues).toHaveLength(1);
    expect(llm.calls).toHaveLength(1);
  });
});

describe("an incomplete report", () => {
  const script: Script = {
    match: "export is broken",
    triage: [
      bugOutput({
        kit: completeBugKit({ location: "unknown", steps: [] }),
        questions: [
          { field: "location", text: "You said the export is broken: on which page?" },
          { field: "expected", text: "A question about a field that is NOT missing." },
        ],
      }),
      bugOutput(),
    ],
  };

  it("asks once, waits, re-triages on the answer and then opens the issue", async () => {
    const { source, store, tracker, gate } = setup([script]);
    const root = source.add({ author: "Dana", text: `The export is broken.\n${ATTACHMENT_MARKER}` });

    await gate.runCycle();
    expect((await store.getTicket(1))!).toMatchObject({ status: "NEEDS_INFO", kitMissing: ["location", "steps"] });
    expect(source.posted[0]!.html).toContain("You said the export is broken: on which page?");
    expect(source.posted[0]!.html).not.toContain("NOT missing");
    expect(tracker.issues).toHaveLength(0);

    await gate.runCycle();
    await gate.runCycle();
    expect(source.posted).toHaveLength(1); // silence while the reporter is silent

    source.add({ threadId: root.id, author: "Dana", text: "On the reports page: I open it and click export." });
    await gate.runCycle();

    expect((await store.getTicket(1))!).toMatchObject({ status: "READY", kitMissing: [], issueNumber: 101 });
    expect(source.posted).toHaveLength(2);
    expect(source.posted[1]!.html).toContain("Thanks! I added your reply");
  });
});

describe("writing is opt-in", () => {
  it("by default triages and reports intent, and posts or opens nothing", async () => {
    const { source, store, tracker, gate } = setup([completeScript], { autoReply: false, autoIssue: false });
    source.add({ author: "Dana", text: REPORT });

    const report = await gate.runCycle();

    expect((await store.getTicket(1))!.status).toBe("READY");
    expect(source.posted).toEqual([]);
    expect(tracker.issues).toEqual([]);
    expect(report.events.map((e) => e.outcome)).toEqual(["READY", "WOULD_POST", "WOULD_OPEN_ISSUE"]);
  });
});

describe("a P1 is held for a person", () => {
  it("is triaged and gets its issue, but no automatic reply", async () => {
    const { source, store, tracker, gate } = setup([{ match: "export button", triage: [bugOutput({ severity: "P1" })] }]);
    source.add({ author: "Dana", text: REPORT });

    const report = await gate.runCycle();

    expect((await store.getTicket(1))!.status).toBe("READY");
    expect(source.posted).toEqual([]);
    expect(tracker.issues).toHaveLength(1);
    expect(report.events).toContainEqual({ ticket: 1, step: "reply", outcome: "HELD_FOR_HUMAN", detail: "P1" });
  });
});

describe("announcements", () => {
  const announcement = (match: string): Script => ({
    match,
    triage: [
      {
        kind: "FEATURE", status: "REJECTED", rejectionKind: "ANNOUNCEMENT",
        triageNote: "announces something that is already live", title: "Release announcement",
        summary: "Announcement of a feature that is live.", area: "web", severity: "P4", kit: {},
      },
    ],
  });

  it("dismisses a tagged announcement with one fixed reply", async () => {
    const { source, store, tracker, gate } = setup([announcement("Bulk archive")]);
    source.add({ author: "Priya", text: "[SHIPPED] Bulk archive is live for everyone" });

    await gate.runCycle();
    await gate.runCycle();

    expect((await store.getTicket(1))!).toMatchObject({ status: "REJECTED", rejectionKind: "ANNOUNCEMENT" });
    expect(source.posted).toHaveLength(1);
    expect(source.posted[0]!.html).toContain("Release announcements are not logged as tickets");
    expect(tracker.issues).toEqual([]);
  });

  it("refuses to dismiss an untagged message on the model's word alone", async () => {
    const { source, store, gate } = setup([announcement("the new export")]);
    source.add({ author: "Priya", text: "the new export never finishes for me" });

    await gate.runCycle();

    expect((await store.getTicket(1))!).toMatchObject({ status: "NEEDS_HUMAN", rejectionKind: null });
    expect(source.posted).toEqual([]);
  });
});

describe("a model that never produces valid output", () => {
  it("is retried a bounded number of times, then handed to a person", async () => {
    const { source, store, gate, llm } = setup([{ match: "export button", triage: ["not json at all"] }], { maxTriageFailures: 2 });
    source.add({ author: "Dana", text: REPORT });

    const first = await gate.runCycle();
    expect(first.errors[0]).toMatchObject({ step: "triage", outcome: "TRIAGE_FAILED" });
    expect((await store.getTicket(1))!).toMatchObject({ status: "NEW", triageFailures: 1 });

    await gate.runCycle();
    expect((await store.getTicket(1))!).toMatchObject({ status: "NEEDS_HUMAN", triageFailures: 2 });

    const calls = llm.calls.length;
    await gate.runCycle();
    expect(llm.calls).toHaveLength(calls);
  });

  it("does not stop the other tickets in the batch", async () => {
    const { source, store, gate } = setup([{ match: "first thread", triage: ["garbage"] }, completeScript]);
    source.add({ author: "Dana", text: "first thread: something" });
    source.add({ author: "Dana", text: REPORT });

    await gate.runCycle();
    expect((await store.getTicket(2))!.status).toBe("READY");
  });
});

describe("closing the loop", () => {
  async function readyTicket(options: GateOptions = {}) {
    const ctx = setup([completeScript], options);
    ctx.source.add({ author: "Dana", text: REPORT });
    await ctx.gate.runCycle();
    return ctx;
  }

  it("posts the preview once, then announces the merge and resolves the ticket", async () => {
    const { source, store, tracker, gate } = await readyTicket();
    const branch = (await store.getTicket(1))!.branchName!;

    const pr = tracker.openPullRequest(branch, "https://pr-1.preview.example.test");
    await gate.runCycle();
    await gate.runCycle();

    expect((await store.getTicket(1))!).toMatchObject({ status: "IN_REVIEW", prNumber: pr, previewUrl: "https://pr-1.preview.example.test" });
    expect(source.posted.filter((p) => p.html.includes("preview environment"))).toHaveLength(1);

    tracker.setPullRequest(pr, { state: "MERGED", previewUrl: null });
    await gate.runCycle();
    await gate.runCycle();

    const ticket = (await store.getTicket(1))!;
    expect(ticket.status).toBe("RESOLVED");
    expect(ticket.resolvedAt).not.toBeNull();
    expect(source.posted.filter((p) => p.html.includes("approved and merged"))).toHaveLength(1);
  });

  it("never posts a preview link from a host that is not allowed", async () => {
    const { source, store, tracker, gate } = await readyTicket();
    tracker.openPullRequest((await store.getTicket(1))!.branchName!, "https://evil.test/phish");

    await gate.runCycle();
    expect(source.posted.some((p) => p.html.includes("evil.test"))).toBe(false);
  });

  it("resolves the ticket when its issue is closed as completed, without a pull request", async () => {
    const { source, store, tracker, gate } = await readyTicket();
    tracker.closeIssue(101, "DELIVERED");

    await gate.runCycle();
    expect((await store.getTicket(1))!.status).toBe("RESOLVED");
    expect(source.posted.at(-1)!.html).toContain("closed on our side");
  });

  it("resolves even with replies off: the lifecycle does not depend on being able to post", async () => {
    const { source, store, tracker, gate } = await readyTicket({ autoReply: false });
    tracker.closeIssue(101, "DELIVERED");

    await gate.runCycle();
    expect((await store.getTicket(1))!.status).toBe("RESOLVED");
    expect(source.posted).toEqual([]);
  });

  it("holds a ticket with a live issue when the reporter writes again", async () => {
    const { source, store, gate, llm } = await readyTicket();
    source.add({ threadId: source.messages[0]!.id, author: "Dana", text: "any news on the export button?" });

    await gate.runCycle();
    expect(llm.calls).toHaveLength(1);
    expect((await store.getTicket(1))!.issueNumber).toBe(101);
  });

  it("re-triages and frees the ticket when its issue was closed as not planned", async () => {
    const { source, store, tracker, gate, llm } = await readyTicket();
    tracker.closeIssue(101, "ABANDONED");
    source.add({ threadId: source.messages[0]!.id, author: "Dana", text: "the export button still gives an empty file" });

    await gate.runCycle();

    expect(llm.calls).toHaveLength(2);
    const ticket = (await store.getTicket(1))!;
    expect(ticket.status).toBe("READY");
    expect(ticket.issueNumber).toBe(102); // a fresh issue, not the abandoned one
  });
});

describe("tickets with no thread", () => {
  it("are triaged and get an issue, and nothing is ever posted for them", async () => {
    const { source, store, tracker, gate } = setup([completeScript]);
    await store.createManualTicket({ title: "By hand", text: REPORT, reporterName: "Dana" });

    await gate.runCycle();
    tracker.closeIssue(101, "DELIVERED");
    await gate.runCycle();

    expect((await store.getTicket(1))!.status).toBe("RESOLVED");
    expect(source.posted).toEqual([]);
    expect(tracker.issues[0]!.body).not.toContain("Original thread");
  });
});

describe("the offline demo", () => {
  it("runs end to end and lands every thread where it should", async () => {
    const lines: string[] = [];
    const { store, source, tracker } = await runDemo({ write: (line) => lines.push(line) });

    const byNumber = Object.fromEntries((await store.listTickets()).map((t) => [t.number, t.status]));
    expect(byNumber).toEqual({ 1: "RESOLVED", 2: "READY", 3: "REJECTED", 4: "READY", 5: "READY" });

    // The regression that opens with an announcement tag became an issue; the question did not.
    expect(tracker.issues.map((i) => i.title)).toEqual([
      "[bug] Gantt export downloads an empty PDF (ticket #1)",
      "[bug] Duplicate reminder emails are back (ticket #4)",
      "[bug] Calendar sync never runs after connecting (ticket #2)",
    ]);
    expect(source.posted).toHaveLength(8);
    expect(lines.join("\n")).toContain('cannot emit status "READY"');
  });
});
