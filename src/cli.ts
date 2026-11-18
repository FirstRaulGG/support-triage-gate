#!/usr/bin/env node
// Command-line entry point.

import { existsSync } from "node:fs";
import { parseArgs } from "node:util";

import { ConfigError, loadConfig } from "./config.js";
import type { Config } from "./config.js";
import { runDemo } from "./demo.js";
import { ClaudeClient } from "./llm/claude.js";
import { OpenAiCompatibleClient } from "./llm/openai-compatible.js";
import type { LlmClient } from "./llm/types.js";
import { ZERO_USAGE } from "./llm/types.js";
import { Gate } from "./pipeline/run.js";
import type { CycleReport } from "./pipeline/run.js";
import { FileTokenStore, getAccessToken, pollDeviceCode, startDeviceCode } from "./sources/teams/auth.js";
import { TeamsSource } from "./sources/teams/source.js";
import { FileTicketStore } from "./store/file.js";
import { GitHubTracker } from "./trackers/github.js";

const HELP = `support-triage-gate

Usage: triage-gate <command> [options]

Commands:
  demo [--live]          Run the whole pipeline on synthetic threads. No credentials needed
                         unless --live, which uses the configured model instead of a script.
  auth                   Sign the Teams service account in (device code). Run once.
  run [--watch <sec>]    One cycle: poll, triage, reply, open issues, follow up.
                         With --watch, repeat every <sec> seconds.
  list                   List tickets.
  show <number>          Show one ticket with its kit and conversation.
  new <title> <text>     Create a ticket by hand (no chat thread).
  triage <number>        Triage one ticket again now.

Configuration comes from environment variables (see .env.example). Replies and issues are OFF
until AUTO_REPLY=1 / AUTO_ISSUE=1: by default the gate reads and judges, and writes nowhere.`;

function buildLlm(config: Config): LlmClient {
  if (config.llm.provider === "anthropic") {
    return new ClaudeClient({ model: config.llm.model, apiKey: config.llm.apiKey });
  }
  return new OpenAiCompatibleClient(config.llm);
}

async function buildGate(config: Config): Promise<{ gate: Gate; store: FileTicketStore }> {
  const store = await FileTicketStore.open(config.storePath);

  const tokenStore = new FileTokenStore(config.tokenPath);
  const teams = config.teams;
  const source = teams
    ? new TeamsSource({
        teamId: teams.teamId,
        channelId: teams.channelId,
        getToken: () => getAccessToken(teams, tokenStore),
      })
    : null;

  const tracker = config.github ? new GitHubTracker(config.github) : null;

  const gate = new Gate(
    { store, llm: buildLlm(config), source, tracker },
    {
      autoReply: config.autoReply,
      autoIssue: config.autoIssue,
      productName: config.productName,
      areas: config.areas,
      announcementTags: config.announcementTags.length ? config.announcementTags : undefined,
      previewHosts: config.previewHosts,
      selfAuthorIds: config.selfAuthorIds,
    },
  );
  return { gate, store };
}

function printReport(report: CycleReport): void {
  if (report.ingest) {
    console.log(`polled: ${report.ingest.newMessages} new message(s) in ${report.ingest.threads} thread(s)`);
  }
  for (const event of report.events) {
    console.log(`#${event.ticket} ${event.step} ${event.outcome}${event.detail ? ` (${event.detail})` : ""}`);
  }
  for (const error of report.errors) {
    console.error(`#${error.ticket} ${error.step} ${error.outcome}: ${error.detail ?? ""}`);
  }
  const { inputTokens, outputTokens, cachedInputTokens } = report.usage;
  if (inputTokens + outputTokens > 0) {
    console.log(`tokens: ${inputTokens} in (${cachedInputTokens} cached), ${outputTokens} out`);
  }
  if (!report.events.length && !report.errors.length) console.log("nothing to do");
}

async function commandAuth(config: Config): Promise<void> {
  if (!config.teams) throw new ConfigError("Teams is not configured (TEAMS_* variables)");
  const start = await startDeviceCode(config.teams);
  console.log(start.message || `Open ${start.verificationUri} and enter the code ${start.userCode}`);

  const deadline = Date.now() + start.expiresInSec * 1000;
  let interval = start.intervalSec;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    const result = await pollDeviceCode(config.teams, start.deviceCode);
    if (result.status === "slow_down") interval += 5;
    if (result.status === "done") {
      await new FileTokenStore(config.tokenPath).write(result.refreshToken);
      console.log(`Signed in. Refresh token stored in ${config.tokenPath}`);
      return;
    }
  }
  throw new Error("sign-in timed out; run `triage-gate auth` again");
}

async function commandRun(config: Config, watchSeconds: number | null): Promise<void> {
  const { gate } = await buildGate(config);
  if (!config.teams) console.error("note: Teams is not configured, so nothing is polled");

  for (;;) {
    printReport(await gate.runCycle());
    if (watchSeconds === null) return;
    await new Promise((resolve) => setTimeout(resolve, watchSeconds * 1000));
  }
}

async function commandList(config: Config): Promise<void> {
  const store = await FileTicketStore.open(config.storePath);
  const tickets = await store.listTickets();
  if (!tickets.length) console.log("no tickets yet");
  for (const ticket of tickets) {
    const issue = ticket.issueNumber ? ` issue #${ticket.issueNumber}` : "";
    console.log(
      `#${ticket.number} ${ticket.status.padEnd(11)} ${(ticket.kind ?? "-").padEnd(13)} ${(ticket.severity ?? "--").padEnd(2)} ${ticket.title}${issue}`,
    );
  }
}

async function commandShow(config: Config, number: number): Promise<void> {
  const store = await FileTicketStore.open(config.storePath);
  const ticket = await store.getTicket(number);
  if (!ticket) throw new Error(`ticket #${number} not found`);

  console.log(`#${ticket.number} ${ticket.title}`);
  console.log(`status: ${ticket.status}   kind: ${ticket.kind ?? "-"}   severity: ${ticket.severity ?? "-"}`);
  if (ticket.summary) console.log(`summary: ${ticket.summary}`);
  if (ticket.kitMissing.length) console.log(`missing: ${ticket.kitMissing.join(", ")}`);
  if (ticket.triageNote) console.log(`note: ${ticket.triageNote}`);
  if (ticket.issueUrl) console.log(`issue: ${ticket.issueUrl}`);
  if (ticket.branchName) console.log(`branch: ${ticket.branchName}`);
  if (ticket.kit) console.log(`kit: ${JSON.stringify(ticket.kit, null, 2)}`);

  console.log("\nconversation:");
  for (const message of await store.listMessages(ticket.id)) {
    console.log(`  [${message.createdAt.toISOString()}] ${message.direction} ${message.author ?? "?"}: ${message.text}`);
  }
}

async function commandNew(config: Config, title: string, text: string): Promise<void> {
  const store = await FileTicketStore.open(config.storePath);
  const ticket = await store.createManualTicket({ title, text, reporterName: null });
  console.log(`created ticket #${ticket.number}; it is triaged on the next \`run\``);
}

async function commandTriage(config: Config, number: number): Promise<void> {
  const { gate, store } = await buildGate(config);
  const ticket = await store.getTicket(number);
  if (!ticket) throw new Error(`ticket #${number} not found`);
  const report: CycleReport = { ingest: null, events: [], errors: [], usage: ZERO_USAGE };
  await gate.triage(ticket, report);
  printReport(report);
}

function ticketNumber(value: string | undefined): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new ConfigError("expected a ticket number");
  return number;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      watch: { type: "string" },
      live: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const [command, ...rest] = positionals;
  if (values.help || !command || command === "help") {
    console.log(HELP);
    return;
  }

  // Local convenience; a deployment sets real environment variables instead.
  if (existsSync(".env")) process.loadEnvFile(".env");

  if (command === "demo") {
    await runDemo(values.live ? { llm: buildLlm(loadConfig()) } : {});
    return;
  }

  const config = loadConfig();
  switch (command) {
    case "auth":
      return commandAuth(config);
    case "run": {
      const watch = values.watch === undefined ? null : Number(values.watch);
      if (watch !== null && (!Number.isFinite(watch) || watch < 10)) {
        throw new ConfigError("--watch takes a number of seconds, 10 or more");
      }
      return commandRun(config, watch);
    }
    case "list":
      return commandList(config);
    case "show":
      return commandShow(config, ticketNumber(rest[0]));
    case "new": {
      const [title, text] = rest;
      if (!title || !text) throw new ConfigError("usage: triage-gate new <title> <text>");
      return commandNew(config, title, text);
    }
    case "triage":
      return commandTriage(config, ticketNumber(rest[0]));
    default:
      throw new ConfigError(`unknown command "${command}". Run \`triage-gate help\`.`);
  }
}

main().catch((err: unknown) => {
  // Messages only. A stack trace or a raw provider response has no business in a terminal that
  // may be captured by a log collector.
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exitCode = 1;
});
