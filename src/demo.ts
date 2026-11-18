// The whole pipeline on synthetic threads, with no credentials: `triage-gate demo`.
//
// Offline, the MODEL's replies come from a script (including a model that tries to approve its own
// ticket and one that returns a broken shape). Everything else is the real code: parsing, shape
// repair, evaluation, the reply policy, issue rendering, follow-up. With `--live`, a real model
// answers instead.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { htmlToText } from "./core/render.js";
import { ScriptedLlm } from "./llm/scripted.js";
import type { Script } from "./llm/scripted.js";
import type { LlmClient } from "./llm/types.js";
import { Gate } from "./pipeline/run.js";
import type { CycleReport } from "./pipeline/run.js";
import { MEMORY_SELF_ID, MemoryChatSource } from "./sources/memory.js";
import { stripTeamsHtml } from "./sources/teams/html.js";
import { MemoryTicketStore } from "./store/memory.js";
import { MemoryTracker } from "./trackers/memory.js";

interface DemoThread {
  id: string;
  author: string;
  minutesAgo: number;
  html: string;
  followUp?: { author: string; html: string };
  scripted: Script;
}

interface DemoFile {
  product: string;
  threads: DemoThread[];
}

export async function loadDemoFile(): Promise<DemoFile> {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = await readFile(join(here, "..", "fixtures", "threads", "demo.json"), "utf8");
  return JSON.parse(raw) as DemoFile;
}

function printReport(title: string, report: CycleReport, write: (line: string) => void): void {
  write(`\n=== ${title} ===`);
  if (report.ingest) {
    write(`ingested: ${report.ingest.newMessages} new message(s) in ${report.ingest.threads} thread(s)`);
  }
  for (const event of report.events) {
    write(`  #${event.ticket} ${event.step.padEnd(8)} ${event.outcome}${event.detail ? `  (${event.detail})` : ""}`);
  }
  for (const error of report.errors) {
    write(`  #${error.ticket} ${error.step.padEnd(8)} ${error.outcome}: ${error.detail ?? ""}`);
  }
}

export async function runDemo(
  options: { llm?: LlmClient; write?: (line: string) => void } = {},
): Promise<{ store: MemoryTicketStore; source: MemoryChatSource; tracker: MemoryTracker }> {
  const write = options.write ?? ((line: string) => console.log(line));
  const demo = await loadDemoFile();

  // A fixed clock that only moves forward keeps the run reproducible.
  let clock = Date.UTC(2025, 0, 15, 12, 0, 0);
  const now = () => new Date((clock += 1000));

  const source = new MemoryChatSource("demo:support", now);
  const store = new MemoryTicketStore();
  const tracker = new MemoryTracker();
  const llm = options.llm ?? new ScriptedLlm(demo.threads.map((thread) => thread.scripted));

  const gate = new Gate(
    { store, llm, source, tracker },
    {
      autoReply: true,
      autoIssue: true,
      productName: demo.product,
      previewHosts: ["preview.example.test"],
      selfAuthorIds: [MEMORY_SELF_ID],
      now,
    },
  );

  const base = clock;
  for (const thread of demo.threads) {
    source.add({
      id: thread.id,
      author: thread.author,
      text: stripTeamsHtml(thread.html),
      createdAt: new Date(base - thread.minutesAgo * 60_000),
    });
  }

  write(`Product: ${demo.product}. ${demo.threads.length} threads arrive in the support channel.`);
  write(options.llm ? "Model: live." : "Model: scripted (offline). The gate's decisions below are real.");

  printReport("Cycle 1: first poll", await gate.runCycle(), write);

  for (const thread of demo.threads) {
    if (!thread.followUp) continue;
    source.add({ threadId: thread.id, author: thread.followUp.author, text: stripTeamsHtml(thread.followUp.html) });
  }
  printReport("Cycle 2: a reporter answered the questions", await gate.runCycle(), write);

  // An engineer pushes the branch the gate named and opens a pull request with a preview.
  const worked = (await store.listTickets()).find((t) => t.branchName && t.issueNumber);
  if (worked?.branchName) {
    const pr = tracker.openPullRequest(worked.branchName, "https://pr-1.preview.example.test");
    printReport(`Cycle 3: a pull request opens for ticket #${worked.number}`, await gate.runCycle(), write);
    tracker.setPullRequest(pr, { state: "MERGED", previewUrl: null });
    printReport("Cycle 4: the pull request is merged", await gate.runCycle(), write);
  }

  write("\n=== Tickets ===");
  for (const ticket of await store.listTickets()) {
    const issue = ticket.issueNumber ? `  issue #${ticket.issueNumber}` : "";
    write(`  #${ticket.number} ${ticket.status.padEnd(11)} ${(ticket.kind ?? "-").padEnd(13)} ${ticket.title}${issue}`);
  }

  write("\n=== What the gate posted ===");
  for (const post of source.posted) {
    write(`  [thread ${post.threadId}] ${htmlToText(post.html)}`);
  }

  return { store, source, tracker };
}
