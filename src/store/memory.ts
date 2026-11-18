// In-memory store. Used by the tests and the demo, and the base of the file store.

import { randomUUID } from "node:crypto";

import type {
  NewMessage,
  Ticket,
  TicketMessage,
  TicketPatch,
  TicketStatus,
  TicketStore,
} from "./types.js";

export interface StoreSnapshot {
  cursors: Record<string, string>;
  tickets: Ticket[];
  messages: TicketMessage[];
}

export class MemoryTicketStore implements TicketStore {
  protected cursors = new Map<string, Date>();
  protected tickets: Ticket[] = [];
  protected messages: TicketMessage[] = [];

  /** Hook for subclasses that persist. Called after every mutation. */
  protected async persist(): Promise<void> {}

  async getCursor(channelKey: string): Promise<Date | null> {
    return this.cursors.get(channelKey) ?? null;
  }

  async setCursor(channelKey: string, at: Date): Promise<void> {
    this.cursors.set(channelKey, at);
    await this.persist();
  }

  private nextNumber(): number {
    return this.tickets.reduce((max, t) => Math.max(max, t.number), 0) + 1;
  }

  private blankTicket(
    input: Pick<Ticket, "source" | "channelKey" | "threadId" | "title" | "reporterName" | "reporterId">,
  ): Ticket {
    const now = new Date();
    return {
      id: randomUUID(),
      number: this.nextNumber(),
      status: "NEW",
      kind: null,
      kit: null,
      kitMissing: [],
      questions: [],
      summary: null,
      area: null,
      severity: null,
      triageNote: null,
      rejectionKind: null,
      triageFailures: 0,
      triagedAt: null,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastReplyKey: null,
      issueNumber: null,
      issueUrl: null,
      branchName: null,
      prNumber: null,
      previewUrl: null,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
  }

  async upsertTicketFromThread(input: {
    channelKey: string;
    threadId: string;
    title: string;
    reporterName: string | null;
    reporterId: string | null;
  }): Promise<Ticket> {
    const existing = this.tickets.find(
      (t) => t.channelKey === input.channelKey && t.threadId === input.threadId,
    );
    if (existing) return { ...existing };

    const ticket = this.blankTicket({ source: "CHAT", ...input });
    this.tickets.push(ticket);
    await this.persist();
    return { ...ticket };
  }

  async createManualTicket(input: {
    title: string;
    text: string;
    reporterName: string | null;
  }): Promise<Ticket> {
    const ticket = this.blankTicket({
      source: "MANUAL",
      channelKey: "manual",
      // Synthetic on purpose: there is no thread, and nothing may ever post to this id.
      threadId: `manual:${randomUUID()}`,
      title: input.title,
      reporterName: input.reporterName,
      reporterId: null,
    });
    this.tickets.push(ticket);
    await this.insertMessagesIfNew(ticket.id, [
      {
        externalId: `manual:${ticket.id}`,
        direction: "INBOUND",
        author: input.reporterName,
        text: input.text,
        imageUrls: [],
        createdAt: ticket.createdAt,
      },
    ]);
    return (await this.getTicket(ticket.number))!;
  }

  private mustFind(id: string): Ticket {
    const ticket = this.tickets.find((t) => t.id === id);
    if (!ticket) throw new Error(`ticket ${id} not found`);
    return ticket;
  }

  async insertMessagesIfNew(ticketId: string, messages: readonly NewMessage[]): Promise<number> {
    const ticket = this.mustFind(ticketId);
    const known = new Set(this.messages.map((m) => m.externalId));
    let inserted = 0;

    for (const message of messages) {
      if (known.has(message.externalId)) continue;
      known.add(message.externalId);
      this.messages.push({ ...message, ticketId });
      inserted++;
    }

    // Recomputed from the stored INBOUND messages, never from "the newest message in the batch":
    // a poll returns the whole thread, our own replies included, and stamping those here would
    // turn the field into "last message seen" instead of "last message from the reporter".
    const inbound = this.messages
      .filter((m) => m.ticketId === ticketId && m.direction === "INBOUND")
      .map((m) => m.createdAt.getTime());
    ticket.lastInboundAt = inbound.length ? new Date(Math.max(...inbound)) : null;
    ticket.updatedAt = new Date();

    await this.persist();
    return inserted;
  }

  async recordOutbound(ticketId: string, message: Omit<NewMessage, "direction">): Promise<void> {
    const ticket = this.mustFind(ticketId);
    if (!this.messages.some((m) => m.externalId === message.externalId)) {
      this.messages.push({ ...message, direction: "OUTBOUND", ticketId });
    }
    ticket.lastOutboundAt = message.createdAt;
    ticket.updatedAt = new Date();
    await this.persist();
  }

  async getTicket(number: number): Promise<Ticket | null> {
    const ticket = this.tickets.find((t) => t.number === number);
    return ticket ? { ...ticket } : null;
  }

  async listTickets(filter: { statuses?: readonly TicketStatus[] } = {}): Promise<Ticket[]> {
    return this.tickets
      .filter((t) => !filter.statuses || filter.statuses.includes(t.status))
      .sort((a, b) => a.number - b.number)
      .map((t) => ({ ...t }));
  }

  async listMessages(ticketId: string): Promise<TicketMessage[]> {
    return this.messages
      .filter((m) => m.ticketId === ticketId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((m) => ({ ...m }));
  }

  async updateTicket(id: string, patch: TicketPatch): Promise<Ticket> {
    const ticket = this.mustFind(id);
    Object.assign(ticket, patch, { updatedAt: new Date() });
    await this.persist();
    return { ...ticket };
  }

  /**
   * Every chat thread, closed ones included. A resolved ticket that receives a reply would
   * otherwise go deaf: its root message never comes back in a poll, and the person would be
   * talking to nobody.
   */
  async listThreadIdsToWatch(channelKey: string): Promise<string[]> {
    return this.tickets
      .filter((t) => t.source === "CHAT" && t.channelKey === channelKey)
      .map((t) => t.threadId);
  }

  snapshot(): StoreSnapshot {
    return {
      cursors: Object.fromEntries([...this.cursors].map(([key, at]) => [key, at.toISOString()])),
      tickets: this.tickets.map((t) => ({ ...t })),
      messages: this.messages.map((m) => ({ ...m })),
    };
  }
}
