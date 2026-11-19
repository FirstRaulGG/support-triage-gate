import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ATTACHMENT_MARKER } from "../src/core/kits.js";
import { FileTokenStore, TeamsAuthError, getAccessToken, pollDeviceCode } from "../src/sources/teams/auth.js";
import { GraphError, classifyGraphStatus, graphFetch, isGraphUrl } from "../src/sources/teams/graph.js";
import { decodeEntities, extractInlineImageUrls, stripTeamsHtml } from "../src/sources/teams/html.js";
import { TeamsSource, normaliseTeamsMessage } from "../src/sources/teams/source.js";
import { fakeFetch } from "./helpers.js";

const noSleep = async () => {};

describe("stripTeamsHtml", () => {
  it("turns paragraphs, breaks and lists into lines", () => {
    expect(stripTeamsHtml("<p>one</p><p>two<br>three</p><ul><li>a</li><li>b</li></ul>")).toBe("one\ntwo\nthree\n- a\n- b");
  });

  it("replaces every image with the attachment marker", () => {
    expect(stripTeamsHtml('<p>see</p><img src="https://graph.microsoft.com/x"><img alt="y">')).toBe(
      `see\n${ATTACHMENT_MARKER}\n${ATTACHMENT_MARKER}`,
    );
  });

  it("does not let a person type the attachment marker", () => {
    expect(stripTeamsHtml(`<p>broken ${ATTACHMENT_MARKER} &#91;image attached&#93;</p>`)).toBe(
      "broken (image attached) (image attached)",
    );
  });

  it("keeps the name of a mention and drops the tag", () => {
    expect(stripTeamsHtml('<p><at id="0">Support Bot</at> the export fails</p>')).toBe("Support Bot the export fails");
  });

  it("decodes entities, with &amp; last", () => {
    expect(decodeEntities("a &lt; b &amp;&amp; c &#39;d&#x27; &eacute; &unknown;")).toBe("a < b && c 'd' é &unknown;");
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
    expect(decodeEntities("&#99999999999;")).toBe("&#99999999999;");
  });
});

describe("extractInlineImageUrls", () => {
  it("keeps Graph-hosted images only", () => {
    const html =
      '<img src="https://graph.microsoft.com/v1.0/teams/t/hostedContents/1/$value?a=1&amp;b=2">' +
      '<img src="https://evil.test/track.png">';
    expect(extractInlineImageUrls(html)).toEqual(["https://graph.microsoft.com/v1.0/teams/t/hostedContents/1/$value?a=1&b=2"]);
  });
});

describe("normaliseTeamsMessage", () => {
  const base = {
    id: "1700000000001",
    createdDateTime: "2025-01-15T12:00:00Z",
    messageType: "message",
    body: { contentType: "html", content: "<p>the export fails</p>" },
    from: { user: { id: "user-1", displayName: "Dana Whitfield" } },
  };

  it("maps a root message", () => {
    expect(normaliseTeamsMessage(base)).toMatchObject({
      id: "1700000000001",
      threadId: "1700000000001",
      isReply: false,
      author: "Dana Whitfield",
      authorId: "user-1",
      text: "the export fails",
    });
  });

  it("maps a reply to its thread and puts the subject first", () => {
    expect(normaliseTeamsMessage({ ...base, id: "2", replyToId: "1700000000001" })).toMatchObject({
      threadId: "1700000000001",
      isReply: true,
    });
    expect(normaliseTeamsMessage({ ...base, subject: "Export" })?.text).toBe("Export\nthe export fails");
  });

  it("drops system events, deleted, empty and author-less messages", () => {
    expect(normaliseTeamsMessage({ ...base, messageType: "systemEventMessage" })).toBeNull();
    expect(normaliseTeamsMessage({ ...base, deletedDateTime: "2025-01-15T12:05:00Z" })).toBeNull();
    expect(normaliseTeamsMessage({ ...base, body: { contentType: "html", content: "<p></p>" } })).toBeNull();
    expect(normaliseTeamsMessage({ ...base, from: { user: null } })).toBeNull();
    expect(normaliseTeamsMessage({ ...base, createdDateTime: "not a date" })).toBeNull();
    expect(normaliseTeamsMessage(null)).toBeNull();
  });
});

describe("graph client", () => {
  it("only talks to Microsoft Graph", async () => {
    expect(isGraphUrl("https://graph.microsoft.com/v1.0/me")).toBe(true);
    for (const url of ["http://graph.microsoft.com/x", "https://graph.microsoft.com.evil.test/x", "https://evil.test", "nope"]) {
      expect(isGraphUrl(url)).toBe(false);
    }
    await expect(graphFetch("https://evil.test/steal", {})).rejects.toThrow(/outside Microsoft Graph/);
  });

  it("classifies statuses", () => {
    expect([401, 403, 404, 429, 503, 418].map(classifyGraphStatus)).toEqual([
      "AUTH_FAILED", "PERMISSION_DENIED", "NOT_FOUND", "RATE_LIMITED", "TRANSIENT", "UNKNOWN",
    ]);
  });

  it("retries 429 and 5xx, then succeeds", async () => {
    let call = 0;
    const { fetchImpl, requests } = fakeFetch(() => (++call < 3 ? { status: call === 1 ? 429 : 503 } : { body: { ok: true } }));
    const response = await graphFetch("https://graph.microsoft.com/v1.0/x", {}, { fetchImpl, sleep: noSleep });
    expect(response.ok).toBe(true);
    expect(requests).toHaveLength(3);
  });

  it("does not retry a client error", async () => {
    const { fetchImpl, requests } = fakeFetch(() => ({ status: 403 }));
    const response = await graphFetch("https://graph.microsoft.com/v1.0/x", {}, { fetchImpl, sleep: noSleep });
    expect(response.status).toBe(403);
    expect(requests).toHaveLength(1);
  });
});

describe("TeamsSource", () => {
  const message = (id: string, created: string, extra: Record<string, unknown> = {}) => ({
    id,
    createdDateTime: created,
    messageType: "message",
    body: { contentType: "html", content: `<p>message ${id}</p>` },
    from: { user: { id: "user-1", displayName: "Dana Whitfield" } },
    ...extra,
  });

  function source(fetchImpl: typeof fetch) {
    return new TeamsSource({
      teamId: "team-1",
      channelId: "19:channel@thread.tacv2",
      getToken: async () => "access-token",
      request: { fetchImpl, sleep: noSleep },
    });
  }

  it("returns roots newer than the cursor and stops at the first old page", async () => {
    const { fetchImpl, requests } = fakeFetch((url) =>
      url.includes("skiptoken")
        ? { body: { value: [message("old", "2025-01-01T00:00:00Z")], "@odata.nextLink": "https://graph.microsoft.com/v1.0/next?skiptoken=2" } }
        : {
            body: {
              value: [message("new", "2025-01-15T12:00:00Z"), message("older", "2025-01-10T00:00:00Z")],
              "@odata.nextLink": "https://graph.microsoft.com/v1.0/next?skiptoken=1",
            },
          },
    );

    const roots = await source(fetchImpl).fetchRoots(new Date("2025-01-12T00:00:00Z"));
    expect(roots.map((m) => m.id)).toEqual(["new"]);
    expect(requests).toHaveLength(2); // the second page had nothing newer, so the third is never asked for
    expect((requests[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer access-token");
  });

  it("sees an edited message again", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      body: { value: [message("edited", "2025-01-01T00:00:00Z", { lastModifiedDateTime: "2025-01-15T12:00:00Z" })] },
    }));
    expect(await source(fetchImpl).fetchRoots(new Date("2025-01-12T00:00:00Z"))).toHaveLength(1);
  });

  it("refuses to follow a pagination link to another host", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      body: { value: [message("new", "2025-01-15T12:00:00Z")], "@odata.nextLink": "https://evil.test/next" },
    }));
    await expect(source(fetchImpl).fetchRoots(new Date("2025-01-12T00:00:00Z"))).rejects.toThrow(/outside Microsoft Graph/);
  });

  it("tags replies with their thread and posts HTML replies", async () => {
    const { fetchImpl, requests } = fakeFetch((url, init) =>
      init.method === "POST"
        ? { body: { id: "reply-9", createdDateTime: "2025-01-15T12:30:00Z" } }
        : { body: { value: [message("r1", "2025-01-15T12:10:00Z", { replyToId: "root-1" })] } },
    );
    const teams = source(fetchImpl);

    const replies = await teams.fetchReplies("root-1", new Date("2025-01-15T00:00:00Z"));
    expect(replies[0]).toMatchObject({ threadId: "root-1", isReply: true });

    const posted = await teams.postReply("root-1", "<p>hello</p>");
    expect(posted.id).toBe("reply-9");
    const post = requests.at(-1)!;
    expect(post.url).toContain("/messages/root-1/replies");
    expect(JSON.parse(String(post.init.body))).toEqual({ body: { contentType: "html", content: "<p>hello</p>" } });
  });

  it("raises a typed error on a failed call", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 403 }));
    await expect(source(fetchImpl).fetchRoots(new Date(0))).rejects.toBeInstanceOf(GraphError);
  });

  it("builds a thread link", () => {
    const { fetchImpl } = fakeFetch(() => ({}));
    expect(source(fetchImpl).threadUrl("root-1")).toContain("parentMessageId=root-1");
  });
});

describe("Teams auth", () => {
  const config = { tenantId: "tenant-1", clientId: "client-1" };

  it("stores a rotated refresh token before returning the access token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gate-auth-"));
    const path = join(dir, "nested", "refresh-token");
    const store = new FileTokenStore(path);
    expect(await store.read()).toBeNull();
    await store.write("refresh-old");

    const { fetchImpl, requests } = fakeFetch(() => ({ body: { access_token: "access-1", refresh_token: "refresh-new" } }));
    expect(await getAccessToken(config, store, fetchImpl)).toBe("access-1");
    expect(await readFile(path, "utf8")).toBe("refresh-new");
    expect(String(requests[0]!.init.body)).toContain("refresh_token=refresh-old");
  });

  it("explains how to sign in when there is no refresh token", async () => {
    const store = { read: async () => null, write: async () => {} };
    await expect(getAccessToken(config, store)).rejects.toMatchObject({ code: "no_refresh_token" });
  });

  it("surfaces provider errors as typed errors", async () => {
    const store = { read: async () => "refresh-old", write: async () => {} };
    const { fetchImpl } = fakeFetch(() => ({ status: 400, body: { error: "invalid_grant", error_description: "expired" } }));
    await expect(getAccessToken(config, store, fetchImpl)).rejects.toBeInstanceOf(TeamsAuthError);
  });

  it("reports device-code polling states", async () => {
    const pending = fakeFetch(() => ({ status: 400, body: { error: "authorization_pending" } }));
    expect(await pollDeviceCode(config, "device-1", pending.fetchImpl)).toEqual({ status: "pending" });

    const done = fakeFetch(() => ({ body: { access_token: "a", refresh_token: "r" } }));
    expect(await pollDeviceCode(config, "device-1", done.fetchImpl)).toEqual({ status: "done", accessToken: "a", refreshToken: "r" });
  });
});
