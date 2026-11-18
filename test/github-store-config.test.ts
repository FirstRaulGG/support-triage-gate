import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../src/config.js";
import { FileTicketStore } from "../src/store/file.js";
import { MemoryTicketStore } from "../src/store/memory.js";
import { GitHubTracker, parseRepoSlug } from "../src/trackers/github.js";
import { at, fakeFetch } from "./helpers.js";

describe("GitHubTracker", () => {
  const options = { token: "test-token", owner: "acme", repo: "app" };

  it("creates an issue with title, body and labels", async () => {
    const { fetchImpl, requests } = fakeFetch(() => ({ status: 201, body: { number: 7, html_url: "https://github.test/acme/app/issues/7" } }));
    const tracker = new GitHubTracker({ ...options, fetchImpl });

    expect(await tracker.createIssue({ title: "t", body: "b", labels: ["support"] })).toEqual({
      number: 7,
      url: "https://github.test/acme/app/issues/7",
    });
    expect(requests[0]!.url).toBe("https://api.github.com/repos/acme/app/issues");
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({ title: "t", body: "b", labels: ["support"] });
  });

  it("reads the issue outcome, and answers OPEN when the tracker is unreachable", async () => {
    const closed = fakeFetch(() => ({ body: { state: "closed", state_reason: "not_planned" } }));
    expect(await new GitHubTracker({ ...options, fetchImpl: closed.fetchImpl }).getIssueOutcome(7)).toBe("ABANDONED");

    const down = fakeFetch(() => ({ status: 503 }));
    expect(await new GitHubTracker({ ...options, fetchImpl: down.fetchImpl }).getIssueOutcome(7)).toBe("OPEN");
  });

  it("tells a merged pull request from a closed one", async () => {
    const merged = fakeFetch(() => ({ body: { number: 9, state: "closed", merged: true, head: { sha: "abc" } } }));
    expect(await new GitHubTracker({ ...options, fetchImpl: merged.fetchImpl }).getPullRequest(9)).toEqual({
      number: 9, state: "MERGED", previewUrl: null,
    });

    const closed = fakeFetch(() => ({ body: { number: 9, state: "closed", merged: false, head: { sha: "abc" } } }));
    expect((await new GitHubTracker({ ...options, fetchImpl: closed.fetchImpl }).getPullRequest(9)).state).toBe("CLOSED");
  });

  it("finds the preview of an open pull request by commit", async () => {
    const { fetchImpl, requests } = fakeFetch((url) => {
      if (url.includes("/pulls/9")) return { body: { number: 9, state: "open", merged: false, head: { sha: "abc123" } } };
      if (url.includes("/statuses")) return { body: [{ state: "pending" }, { state: "success", environment_url: "https://pr-9.preview.example.test" }] };
      return { body: [{ id: 55 }] };
    });
    const pr = await new GitHubTracker({ ...options, fetchImpl }).getPullRequest(9);

    expect(pr).toEqual({ number: 9, state: "OPEN", previewUrl: "https://pr-9.preview.example.test" });
    expect(requests.some((r) => r.url.includes("ref=abc123"))).toBe(true);
  });

  it("looks a pull request up by branch, and refuses a name it did not generate", async () => {
    const { fetchImpl, requests } = fakeFetch(() => ({ body: [{ number: 12 }] }));
    const tracker = new GitHubTracker({ ...options, fetchImpl });

    expect(await tracker.findPullRequestForBranch("support/3-export-fails")).toBe(12);
    expect(requests[0]!.url).toContain("head=acme%3Asupport%2F3-export-fails");

    expect(await tracker.findPullRequestForBranch("main&state=open")).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it("parses owner/repo and rejects anything else", () => {
    expect(parseRepoSlug("acme/app")).toEqual({ owner: "acme", repo: "app" });
    expect(parseRepoSlug("acme")).toBeNull();
    expect(parseRepoSlug("acme/app/extra")).toBeNull();
  });
});

function storeSuite(name: string, open: () => Promise<MemoryTicketStore>) {
  describe(name, () => {
    const thread = { channelKey: "c", threadId: "t1", title: "Export fails", reporterName: "Dana", reporterId: "u1" };

    it("is idempotent per thread and numbers tickets in order", async () => {
      const store = await open();
      const first = await store.upsertTicketFromThread(thread);
      const again = await store.upsertTicketFromThread({ ...thread, title: "edited title" });
      const second = await store.upsertTicketFromThread({ ...thread, threadId: "t2" });

      expect(again.id).toBe(first.id);
      expect(again.title).toBe("Export fails");
      expect([first.number, second.number]).toEqual([1, 2]);
    });

    it("stores each message once", async () => {
      const store = await open();
      const ticket = await store.upsertTicketFromThread(thread);
      const message = { externalId: "c:t1:m1", direction: "INBOUND" as const, author: "Dana", text: "hi", imageUrls: [], createdAt: at(0) };

      expect(await store.insertMessagesIfNew(ticket.id, [message])).toBe(1);
      expect(await store.insertMessagesIfNew(ticket.id, [message])).toBe(0);
      expect(await store.listMessages(ticket.id)).toHaveLength(1);
    });

    it("keeps lastInboundAt about the reporter, even when our own reply comes back in a poll", async () => {
      const store = await open();
      const ticket = await store.upsertTicketFromThread(thread);
      await store.insertMessagesIfNew(ticket.id, [
        { externalId: "c:t1:m1", direction: "INBOUND", author: "Dana", text: "hi", imageUrls: [], createdAt: at(0) },
      ]);
      await store.recordOutbound(ticket.id, { externalId: "c:t1:m2", author: "gate", text: "hello", imageUrls: [], createdAt: at(5) });
      // The poll returns the thread again, our reply included and looking like any other message.
      await store.insertMessagesIfNew(ticket.id, [
        { externalId: "c:t1:m2", direction: "INBOUND", author: "gate", text: "hello", imageUrls: [], createdAt: at(5) },
      ]);

      const stored = (await store.getTicket(ticket.number))!;
      expect(stored.lastInboundAt).toEqual(at(0));
      expect(stored.lastOutboundAt).toEqual(at(5));
      expect((await store.listMessages(ticket.id)).map((m) => m.direction)).toEqual(["INBOUND", "OUTBOUND"]);
    });

    it("creates manual tickets with no real thread", async () => {
      const store = await open();
      const ticket = await store.createManualTicket({ title: "By hand", text: "details", reporterName: null });

      expect(ticket.source).toBe("MANUAL");
      expect(ticket.threadId.startsWith("manual:")).toBe(true);
      expect(await store.listThreadIdsToWatch("c")).toEqual([]);
      expect(await store.listMessages(ticket.id)).toHaveLength(1);
    });

    it("filters by status and keeps watching closed threads", async () => {
      const store = await open();
      const ticket = await store.upsertTicketFromThread(thread);
      await store.updateTicket(ticket.id, { status: "RESOLVED" });

      expect(await store.listTickets({ statuses: ["NEW"] })).toHaveLength(0);
      expect(await store.listTickets({ statuses: ["RESOLVED"] })).toHaveLength(1);
      expect(await store.listThreadIdsToWatch("c")).toEqual(["t1"]);
    });
  });
}

storeSuite("MemoryTicketStore", async () => new MemoryTicketStore());
storeSuite("FileTicketStore", async () => FileTicketStore.open(join(await mkdtemp(join(tmpdir(), "gate-store-")), "tickets.json")));

describe("FileTicketStore persistence", () => {
  it("survives a restart with dates intact", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "gate-store-")), "nested", "tickets.json");
    const first = await FileTicketStore.open(path);
    const ticket = await first.upsertTicketFromThread({ channelKey: "c", threadId: "t1", title: "Export fails", reporterName: "Dana", reporterId: "u1" });
    await first.insertMessagesIfNew(ticket.id, [
      { externalId: "c:t1:m1", direction: "INBOUND", author: "Dana", text: "hi", imageUrls: [], createdAt: at(0) },
    ]);
    await first.updateTicket(ticket.id, { status: "READY", kind: "BUG", triagedAt: at(1), kit: { location: "/x" } });
    await first.setCursor("c", at(2));

    const second = await FileTicketStore.open(path);
    const restored = (await second.getTicket(1))!;
    expect(restored).toMatchObject({ status: "READY", kind: "BUG", kit: { location: "/x" } });
    expect(restored.triagedAt).toEqual(at(1));
    expect(restored.lastInboundAt).toEqual(at(0));
    expect(await second.getCursor("c")).toEqual(at(2));
    expect((await second.listMessages(restored.id))[0]!.createdAt).toEqual(at(0));
    expect((await second.upsertTicketFromThread({ channelKey: "c", threadId: "t2", title: "x", reporterName: null, reporterId: null })).number).toBe(2);
  });
});

describe("loadConfig", () => {
  it("defaults to a gate that reads and judges but writes nowhere", () => {
    const config = loadConfig({});
    expect(config).toMatchObject({ autoReply: false, autoIssue: false, teams: null, github: null, previewHosts: [] });
    expect(config.llm.provider).toBe("anthropic");
  });

  it("reads lists, flags and integrations", () => {
    const config = loadConfig({
      AUTO_REPLY: "1", AUTO_ISSUE: "true", AREAS: "web, api ,", PREVIEW_HOSTS: "preview.example.test",
      GITHUB_TOKEN: "t", GITHUB_REPO: "acme/app",
      TEAMS_TENANT_ID: "a", TEAMS_CLIENT_ID: "b", TEAMS_TEAM_ID: "c", TEAMS_CHANNEL_ID: "d",
      TRIAGE_MODEL: "some-model",
    });
    expect(config).toMatchObject({ autoReply: true, autoIssue: true, areas: ["web", "api"], previewHosts: ["preview.example.test"] });
    expect(config.github).toMatchObject({ owner: "acme", repo: "app" });
    expect(config.teams).toMatchObject({ teamId: "c", channelId: "d" });
    expect(config.llm.model).toBe("some-model");
  });

  it("fails loudly on a half-configured provider or a malformed repo", () => {
    expect(() => loadConfig({ LLM_PROVIDER: "openai-compatible" })).toThrow(ConfigError);
    expect(() => loadConfig({ LLM_PROVIDER: "mystery" })).toThrow(ConfigError);
    expect(() => loadConfig({ GITHUB_TOKEN: "t", GITHUB_REPO: "not-a-slug" })).toThrow(ConfigError);
  });
});
