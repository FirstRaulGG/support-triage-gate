// An in-memory chat channel. For tests and the offline demo.

import { effectiveAt } from "./types.js";
import type { ChatMessage, ChatSource } from "./types.js";

export const MEMORY_SELF_ID = "gate-bot";

export class MemoryChatSource implements ChatSource {
  readonly channelKey: string;
  readonly messages: ChatMessage[] = [];
  /** Everything the gate posted, in order. */
  readonly posted: { threadId: string; html: string }[] = [];
  private sequence = 0;

  constructor(
    channelKey = "memory:support",
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.channelKey = channelKey;
  }

  /** Adds a message as if a person had written it. Omit `threadId` to start a thread. */
  add(input: {
    id?: string;
    threadId?: string;
    author: string;
    authorId?: string;
    text: string;
    createdAt?: Date;
    imageUrls?: string[];
  }): ChatMessage {
    const id = input.id ?? `m${++this.sequence}`;
    const message: ChatMessage = {
      id,
      threadId: input.threadId ?? id,
      isReply: input.threadId !== undefined && input.threadId !== id,
      author: input.author,
      authorId: input.authorId ?? `user:${input.author}`,
      text: input.text,
      imageUrls: input.imageUrls ?? [],
      createdAt: input.createdAt ?? this.clock(),
      modifiedAt: null,
    };
    this.messages.push(message);
    return message;
  }

  async fetchRoots(since: Date): Promise<ChatMessage[]> {
    return this.messages.filter((m) => !m.isReply && effectiveAt(m).getTime() > since.getTime());
  }

  async fetchReplies(threadId: string, since: Date): Promise<ChatMessage[]> {
    return this.messages.filter(
      (m) => m.isReply && m.threadId === threadId && effectiveAt(m).getTime() > since.getTime(),
    );
  }

  async postReply(threadId: string, html: string): Promise<{ id: string; createdAt: Date }> {
    const message = this.add({ threadId, author: "Support Bot", authorId: MEMORY_SELF_ID, text: html });
    this.posted.push({ threadId, html });
    return { id: message.id, createdAt: message.createdAt };
  }

  threadUrl(threadId: string): string {
    return `https://chat.example.test/threads/${encodeURIComponent(threadId)}`;
  }
}
