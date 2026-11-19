// Chat source port: where support threads come from and where replies go.

export interface ChatMessage {
  id: string;
  /** Id of the thread's root message. A root message's `threadId` is its own id. */
  threadId: string;
  isReply: boolean;
  author: string | null;
  /** Stable id of the author in the chat system, used to recognise the gate's own account. */
  authorId: string | null;
  /**
   * Plain text. Images are replaced by `ATTACHMENT_MARKER`, and an adapter must make sure the
   * marker appears ONLY where an image was: the same characters typed by a person are rewritten.
   */
  text: string;
  imageUrls: string[];
  createdAt: Date;
  modifiedAt: Date | null;
}

/** The later of creation and last edit. An edited message must be seen again. */
export function effectiveAt(message: Pick<ChatMessage, "createdAt" | "modifiedAt">): Date {
  if (!message.modifiedAt) return message.createdAt;
  return message.modifiedAt.getTime() > message.createdAt.getTime() ? message.modifiedAt : message.createdAt;
}

export interface ChatSource {
  /** Identifies the channel in the store (cursor and ticket idempotency key). */
  readonly channelKey: string;
  /** Thread-starting messages created or edited after `since`. */
  fetchRoots(since: Date): Promise<ChatMessage[]>;
  /** Replies in one thread, created or edited after `since`. */
  fetchReplies(threadId: string, since: Date): Promise<ChatMessage[]>;
  postReply(threadId: string, html: string): Promise<{ id: string; createdAt: Date }>;
  /** Link a person can click to open the thread, if the chat system has one. */
  threadUrl(threadId: string): string | null;
}

/** Idempotency key for a stored message. */
export function messageExternalId(channelKey: string, threadId: string, messageId: string): string {
  return `${channelKey}:${threadId}:${messageId}`;
}
