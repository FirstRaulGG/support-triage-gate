// Persistence port. The pipeline talks to this interface only, so tests run against the in-memory
// store and a real deployment can swap in a database without touching any decision.

import type { TicketKind } from "../core/kits.js";
import type { ModelQuestion } from "../core/render.js";
import type { Direction } from "../core/policy.js";

export const TICKET_STATUSES = [
  "NEW",
  "NEEDS_INFO",
  "READY",
  "REJECTED",
  /** The gate declined to decide (its two announcement checks disagreed). A person must look. */
  "NEEDS_HUMAN",
  "IN_PROGRESS",
  "IN_REVIEW",
  "RESOLVED",
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export type TicketSource = "CHAT" | "MANUAL";

export interface Ticket {
  id: string;
  /** Human-facing sequential number. */
  number: number;
  source: TicketSource;
  channelKey: string;
  threadId: string;
  title: string;
  reporterName: string | null;
  reporterId: string | null;
  status: TicketStatus;
  kind: TicketKind | null;
  kit: unknown;
  kitMissing: string[];
  questions: ModelQuestion[];
  summary: string | null;
  area: string | null;
  severity: string | null;
  triageNote: string | null;
  rejectionKind: string | null;
  /** Consecutive failed triage attempts, so a ticket the model cannot parse does not loop forever. */
  triageFailures: number;
  triagedAt: Date | null;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  /** Substance of the last reply we posted (status, fields asked), used to avoid repeating it. */
  lastReplyKey: string | null;
  issueNumber: number | null;
  issueUrl: string | null;
  branchName: string | null;
  prNumber: number | null;
  previewUrl: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TicketMessage {
  /** Idempotency key: the same chat message is never stored twice. */
  externalId: string;
  ticketId: string;
  direction: Direction;
  author: string | null;
  text: string;
  imageUrls: string[];
  createdAt: Date;
}

export type NewMessage = Omit<TicketMessage, "ticketId">;

export type TicketPatch = Partial<
  Omit<Ticket, "id" | "number" | "source" | "channelKey" | "threadId" | "createdAt" | "updatedAt">
>;

export interface TicketStore {
  getCursor(channelKey: string): Promise<Date | null>;
  setCursor(channelKey: string, at: Date): Promise<void>;

  /** Idempotent on (channelKey, threadId): the thread IS the ticket. */
  upsertTicketFromThread(input: {
    channelKey: string;
    threadId: string;
    title: string;
    reporterName: string | null;
    reporterId: string | null;
  }): Promise<Ticket>;

  createManualTicket(input: { title: string; text: string; reporterName: string | null }): Promise<Ticket>;

  /**
   * Inserts the messages not seen before and recomputes `lastInboundAt` from the INBOUND messages
   * stored. Returns how many were new.
   */
  insertMessagesIfNew(ticketId: string, messages: readonly NewMessage[]): Promise<number>;

  /** Records a message WE posted and stamps `lastOutboundAt`. */
  recordOutbound(ticketId: string, message: Omit<NewMessage, "direction">): Promise<void>;

  getTicket(number: number): Promise<Ticket | null>;
  listTickets(filter?: { statuses?: readonly TicketStatus[] }): Promise<Ticket[]>;
  listMessages(ticketId: string): Promise<TicketMessage[]>;
  updateTicket(id: string, patch: TicketPatch): Promise<Ticket>;

  /** Thread ids whose replies must be fetched on each poll. */
  listThreadIdsToWatch(channelKey: string): Promise<string[]>;
}
