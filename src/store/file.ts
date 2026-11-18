// JSON-file store: zero dependencies, good enough for one channel and one process.
//
// It is a reference implementation of `TicketStore`, not a database. Run several workers or a busy
// channel and you want a real one behind the same interface.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { MemoryTicketStore } from "./memory.js";
import type { StoreSnapshot } from "./memory.js";
import type { Ticket, TicketMessage } from "./types.js";

const TICKET_DATE_FIELDS = [
  "triagedAt",
  "lastInboundAt",
  "lastOutboundAt",
  "resolvedAt",
  "createdAt",
  "updatedAt",
] as const satisfies readonly (keyof Ticket)[];

function reviveDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export class FileTicketStore extends MemoryTicketStore {
  private constructor(private readonly path: string) {
    super();
  }

  static async open(path: string): Promise<FileTicketStore> {
    const store = new FileTicketStore(path);
    await store.load();
    return store;
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // first run
      throw err;
    }

    const data = JSON.parse(raw) as Partial<StoreSnapshot>;

    for (const [key, value] of Object.entries(data.cursors ?? {})) {
      const at = reviveDate(value);
      if (at) this.cursors.set(key, at);
    }

    this.tickets = (data.tickets ?? []).map((stored) => {
      const ticket = { ...stored } as Ticket;
      const record = ticket as unknown as Record<string, unknown>;
      for (const field of TICKET_DATE_FIELDS) record[field] = reviveDate(record[field]);
      ticket.createdAt ??= new Date();
      ticket.updatedAt ??= ticket.createdAt;
      return ticket;
    });

    this.messages = (data.messages ?? []).map(
      (stored) => ({ ...stored, createdAt: reviveDate(stored.createdAt) ?? new Date(0) }) as TicketMessage,
    );
  }

  /** Write to a temp file and rename: a crash mid-write must not leave half a store behind. */
  protected override async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(this.snapshot(), null, 2), "utf8");
    await rename(tmp, this.path);
  }
}
