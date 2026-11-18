// Ingestion: groups chat messages into threads, materialises tickets and moves the cursor.

import { effectiveAt, messageExternalId } from "../sources/types.js";
import type { ChatMessage, ChatSource } from "../sources/types.js";
import type { NewMessage, TicketStore } from "../store/types.js";

export interface IngestResult {
  fetched: number;
  threads: number;
  newMessages: number;
  /** Where the cursor moved to. `null` = nothing new, cursor untouched. */
  cursorMovedTo: Date | null;
}

const DRAFT_TITLE_MAX = 80;

/** Provisional title, before triage rewrites it. */
export function draftTitle(text: string): string {
  const firstLine =
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  if (!firstLine) return "Untitled ticket";
  return firstLine.length <= DRAFT_TITLE_MAX ? firstLine : `${firstLine.slice(0, DRAFT_TITLE_MAX - 1)}…`;
}

export interface IngestOptions {
  /** How far back the very first poll looks. */
  firstPollDays?: number;
  /**
   * Chat ids of the gate's own account. Messages from it are stored as OUTBOUND even when they
   * were not posted through this process, so they can never be mistaken for a reporter's reply.
   */
  selfAuthorIds?: readonly string[];
  now?: () => Date;
}

export async function pollAndIngest(
  source: ChatSource,
  store: TicketStore,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const now = options.now?.() ?? new Date();
  const firstPollMs = (options.firstPollDays ?? 7) * 24 * 60 * 60 * 1000;
  const since = (await store.getCursor(source.channelKey)) ?? new Date(now.getTime() - firstPollMs);

  // No root message is filtered out. Requiring a mention or a keyword to open a ticket looks tidy
  // and silently drops the reports of everyone who simply describes their problem. The symptom is
  // mute, too: "nothing fetched" reads as "quiet channel". Noise is what REJECTED is for.
  const roots = await source.fetchRoots(since);

  // Replies are fetched for every known thread, closed ones included (see the store).
  const watched = new Set([...(await store.listThreadIdsToWatch(source.channelKey)), ...roots.map((m) => m.threadId)]);
  const replies: ChatMessage[] = [];
  for (const threadId of watched) {
    replies.push(...(await source.fetchReplies(threadId, since)));
  }

  const messages = [...roots, ...replies];
  if (messages.length === 0) return { fetched: 0, threads: 0, newMessages: 0, cursorMovedTo: null };

  const byThread = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    const bucket = byThread.get(message.threadId);
    if (bucket) bucket.push(message);
    else byThread.set(message.threadId, [message]);
  }

  const self = new Set(options.selfAuthorIds ?? []);
  let newMessages = 0;

  for (const [threadId, thread] of byThread) {
    const ordered = [...thread].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const first = ordered.find((m) => !m.isReply) ?? ordered[0]!;

    const ticket = await store.upsertTicketFromThread({
      channelKey: source.channelKey,
      threadId,
      title: draftTitle(first.text),
      reporterName: first.author,
      reporterId: first.authorId,
    });

    const rows: NewMessage[] = ordered.map((m) => ({
      externalId: messageExternalId(source.channelKey, threadId, m.id),
      direction: m.authorId && self.has(m.authorId) ? "OUTBOUND" : "INBOUND",
      author: m.author,
      text: m.text,
      imageUrls: m.imageUrls,
      createdAt: m.createdAt,
    }));
    newMessages += await store.insertMessagesIfNew(ticket.id, rows);
  }

  // The cursor moves ONCE, at the end, to the newest message processed. Moving it per message
  // looks safer and is the opposite: if the process dies mid-batch, the messages not yet stored
  // are behind the cursor and are never seen again. Reprocessing a whole batch is cheap because
  // ingestion is idempotent.
  //
  // It uses the same "effective" time as the fetch filter. If the cursor advanced by creation
  // time while the filter looked at edits, an edited message would be re-read on every poll.
  const newest = messages.reduce(
    (max, m) => (effectiveAt(m).getTime() > max.getTime() ? effectiveAt(m) : max),
    effectiveAt(messages[0]!),
  );
  await store.setCursor(source.channelKey, newest);

  return { fetched: messages.length, threads: byThread.size, newMessages, cursorMovedTo: newest };
}
