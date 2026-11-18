// Microsoft Teams channel as a `ChatSource`.

import type { ChatMessage, ChatSource } from "../types.js";
import { effectiveAt } from "../types.js";
import { GRAPH_BASE, graphJson } from "./graph.js";
import type { GraphRequestOptions } from "./graph.js";
import { extractInlineImageUrls, stripTeamsHtml } from "./html.js";

const PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 10;

interface RawGraphMessage {
  id?: unknown;
  replyToId?: unknown;
  createdDateTime?: unknown;
  lastModifiedDateTime?: unknown;
  deletedDateTime?: unknown;
  messageType?: unknown;
  subject?: unknown;
  body?: { content?: unknown; contentType?: unknown };
  from?: { user?: { id?: unknown; displayName?: unknown } | null } | null;
}

interface GraphPage {
  value?: unknown[];
  "@odata.nextLink"?: unknown;
}

/**
 * Graph message -> `ChatMessage`, or `null` for anything that is not a person's message: system
 * events, deleted or empty messages, and messages with no human author (bots, connectors).
 */
export function normaliseTeamsMessage(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const message = raw as RawGraphMessage;

  const id = typeof message.id === "string" ? message.id : null;
  const createdRaw = typeof message.createdDateTime === "string" ? message.createdDateTime : null;
  if (!id || !createdRaw) return null;

  const createdAt = new Date(createdRaw);
  if (Number.isNaN(createdAt.getTime())) return null;
  if (typeof message.messageType === "string" && message.messageType !== "message") return null;
  if (typeof message.deletedDateTime === "string" && message.deletedDateTime) return null;

  const content = typeof message.body?.content === "string" ? message.body.content : "";
  const isPlainText = message.body?.contentType === "text";
  const subject = typeof message.subject === "string" && message.subject.trim() ? message.subject.trim() : null;
  const bodyText = isPlainText ? content.trim() : stripTeamsHtml(content);
  const text = subject ? `${subject}\n${bodyText}`.trim() : bodyText;
  if (!text) return null;

  const user = message.from?.user ?? null;
  const author = typeof user?.displayName === "string" ? user.displayName : null;
  const authorId = typeof user?.id === "string" ? user.id : null;
  if (!author && !authorId) return null;

  const modified = typeof message.lastModifiedDateTime === "string" ? new Date(message.lastModifiedDateTime) : null;
  const replyToId = typeof message.replyToId === "string" && message.replyToId ? message.replyToId : null;

  return {
    id,
    threadId: replyToId ?? id,
    isReply: replyToId !== null,
    author,
    authorId,
    text,
    imageUrls: isPlainText ? [] : extractInlineImageUrls(content),
    createdAt,
    modifiedAt: modified && !Number.isNaN(modified.getTime()) ? modified : null,
  };
}

export interface TeamsSourceOptions {
  teamId: string;
  channelId: string;
  /** Returns a fresh delegated access token. Called once per request batch. */
  getToken: () => Promise<string>;
  maxPages?: number;
  request?: GraphRequestOptions;
}

export class TeamsSource implements ChatSource {
  readonly channelKey: string;
  private readonly base: string;

  constructor(private readonly options: TeamsSourceOptions) {
    this.channelKey = `teams:${options.channelId}`;
    this.base =
      `${GRAPH_BASE}/teams/${encodeURIComponent(options.teamId)}` +
      `/channels/${encodeURIComponent(options.channelId)}/messages`;
  }

  private async paginate(
    firstUrl: string,
    since: Date,
    stopWhenPageIsOld: boolean,
    mapMessage: (message: ChatMessage) => ChatMessage = (m) => m,
  ): Promise<ChatMessage[]> {
    const token = await this.options.getToken();
    const maxPages = this.options.maxPages ?? DEFAULT_MAX_PAGES;
    const out: ChatMessage[] = [];
    let url = firstUrl;

    for (let page = 0; page < maxPages && url; page++) {
      const json = await graphJson<GraphPage>(url, token, {}, this.options.request);
      const items = Array.isArray(json.value) ? json.value : [];
      let pageHasNewer = false;

      for (const item of items) {
        const message = normaliseTeamsMessage(item);
        if (!message) continue;
        if (effectiveAt(message).getTime() <= since.getTime()) continue;
        pageHasNewer = true;
        out.push(mapMessage(message));
      }

      // Channel messages come newest first: a page with nothing newer than the cursor means the
      // rest is older still. (Replies are not ordered that way, so they read every page.)
      if (stopWhenPageIsOld && items.length > 0 && !pageHasNewer) break;

      const next = json["@odata.nextLink"];
      url = typeof next === "string" ? next : "";
    }
    return out;
  }

  fetchRoots(since: Date): Promise<ChatMessage[]> {
    return this.paginate(`${this.base}?$top=${PAGE_SIZE}`, since, true);
  }

  fetchReplies(threadId: string, since: Date): Promise<ChatMessage[]> {
    const url = `${this.base}/${encodeURIComponent(threadId)}/replies?$top=${PAGE_SIZE}`;
    return this.paginate(url, since, false, (message) => ({ ...message, threadId, isReply: true }));
  }

  async postReply(threadId: string, html: string): Promise<{ id: string; createdAt: Date }> {
    const token = await this.options.getToken();
    const json = await graphJson<{ id?: unknown; createdDateTime?: unknown }>(
      `${this.base}/${encodeURIComponent(threadId)}/replies`,
      token,
      { method: "POST", body: JSON.stringify({ body: { contentType: "html", content: html } }) },
      this.options.request,
    );
    if (typeof json.id !== "string") throw new Error("Microsoft Graph returned no message id");

    const created = typeof json.createdDateTime === "string" ? new Date(json.createdDateTime) : new Date();
    return { id: json.id, createdAt: Number.isNaN(created.getTime()) ? new Date() : created };
  }

  threadUrl(threadId: string): string {
    return (
      `https://teams.microsoft.com/l/message/${encodeURIComponent(this.options.channelId)}/${encodeURIComponent(threadId)}` +
      `?groupId=${encodeURIComponent(this.options.teamId)}&parentMessageId=${encodeURIComponent(threadId)}`
    );
  }
}
