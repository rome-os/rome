// THROWAWAY PROTOTYPE — not wired into anything, not migrated, not exported.
// Answers one question: can an email mirror over `sqlMessages`, filled by a
// paged backfill and by the inbound push, pass `testMessagesContract`, and what
// does attributing an outbound message to a person cost in provider calls?
//
// Everything here is the smallest thing that runs. No error handling, no
// logging, no watermark, no rate limiting, no labels, no attachments.

import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { DrizzleDb } from "../db/index.js";
import type {
  ListMessagesParams,
  ListMessagesResult,
  MailAttachmentDownload,
  MailProvider,
  ProvisionResult,
  RomeMailEvent,
  RomeMailListItem,
  RomeMailMessage,
  SendMailInput,
  SendMailResult,
} from "../lib/rome-cloud-mail.js";
import type { Messages } from "./messages.js";
import { inList, keysIn, sqlMessages } from "./messages-sql.js";

// ---------------------------------------------------------------------------
// The mirror tables
// ---------------------------------------------------------------------------

// One row per message the mailbox holds. `to_address` is null until something
// hydrates it, because a list row carries no `to` at all.
export const emailMessagesProto = sqliteTable("email_messages_proto", {
  providerMessageId: text("provider_message_id").primaryKey(),
  threadId: text("thread_id").notNull(),
  fromAddress: text("from_address").notNull(),
  toAddress: text("to_address"),
  outbound: integer("outbound", { mode: "boolean" }).notNull(),
  receivedAt: integer("received_at", { mode: "timestamp" }).notNull(),
  subject: text("subject"),
  body: text("body"),
});

// The counterparty of a thread, learned from the first inbound message on it.
// A thread Rome started that nobody answered has no row here.
export const emailThreadsProto = sqliteTable("email_threads_proto", {
  threadId: text("thread_id").primaryKey(),
  counterparty: text("counterparty").notNull(),
});

/** The two tables as raw DDL, since a prototype has no migration. */
export function createEmailMirrorTables(db: DrizzleDb): void {
  db.run(sql`
    CREATE TABLE email_messages_proto (
      provider_message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      from_address TEXT NOT NULL,
      to_address TEXT,
      outbound INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      subject TEXT,
      body TEXT
    )`);
  db.run(sql`CREATE INDEX idx_email_proto_thread ON email_messages_proto (thread_id, received_at)`);
  db.run(sql`
    CREATE TABLE email_threads_proto (
      thread_id TEXT PRIMARY KEY,
      counterparty TEXT NOT NULL
    )`);
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/**
 * `Messages` over the email mirror, exactly the `whatsAppMessages` shape.
 *
 * The account scope is the interesting half. An inbound message is keyed by who
 * sent it, which a list row already says. An outbound message is keyed by whom
 * Rome sent it to, which a list row does not say — so the key falls back to the
 * thread's counterparty. Resolving the fallback at read time rather than at
 * write time is what makes the backfill order-free: the walk is newest-first,
 * so a thread's outbound rows are mirrored before the inbound row that names
 * the person they belong to.
 *
 * An outbound message with neither a hydrated `to` nor a thread counterparty
 * keys to NULL and so reaches no account read. That is the unanswered-thread
 * hole, made visible rather than papered over.
 */
export function emailMessages(db: DrizzleDb): Messages {
  return sqlMessages({
    channel: "email",
    db,
    view(scope) {
      const keys = keysIn(scope.keys);
      if (scope.by === "conversation") {
        const threads = inList(sql`m.thread_id`, keys);
        if (threads === null) return null;
        return sql`
          SELECT
            'email' AS source,
            m.thread_id AS key,
            m.received_at AS at,
            m.outbound AS outbound,
            m.provider_message_id AS ref,
            m.body AS body
          FROM email_messages_proto m
          WHERE ${threads}`;
      }
      const addresses = inList(sql`e.key`, keys);
      if (addresses === null) return null;
      return sql`
        SELECT * FROM (
          SELECT
            'email' AS source,
            CASE
              WHEN m.outbound = 0 THEN m.from_address
              ELSE coalesce(m.to_address, t.counterparty)
            END AS key,
            m.received_at AS at,
            m.outbound AS outbound,
            m.provider_message_id AS ref,
            m.body AS body
          FROM email_messages_proto m
          LEFT JOIN email_threads_proto t ON t.thread_id = m.thread_id
        ) e
        WHERE ${addresses}`;
    },
  });
}

// ---------------------------------------------------------------------------
// The writers
// ---------------------------------------------------------------------------

function normalizeAddress(value: string | undefined): string {
  if (!value) return "";
  const match = value.match(/<([^>]+)>/u);
  return (match ? match[1] : value).trim().toLowerCase();
}

interface MirrorRow {
  providerMessageId: string;
  threadId: string;
  fromAddress: string;
  toAddress: string | null;
  outbound: boolean;
  receivedAt: Date;
  subject: string | null;
  body: string | null;
}

// `onConflictDoNothing` rather than an update: a re-walk must not clobber a
// `to_address` an earlier hydration paid a `getMessage` for, and must not
// overwrite the push writer's row with the list row's thinner copy.
function writeRows(db: DrizzleDb, rows: MirrorRow[]): void {
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    if (chunk.length === 0) continue;
    db.insert(emailMessagesProto).values(chunk).onConflictDoNothing().run();
  }
  const threads = rows
    .filter((row) => !row.outbound && row.fromAddress !== "")
    .map((row) => ({ threadId: row.threadId, counterparty: row.fromAddress }));
  for (let i = 0; i < threads.length; i += 100) {
    const chunk = threads.slice(i, i + 100);
    if (chunk.length === 0) continue;
    db.insert(emailThreadsProto).values(chunk).onConflictDoNothing().run();
  }
}

/**
 * How an outbound message finds the person it belongs to.
 *
 * - `thread`: the thread's inbound counterparty. Free, and blind to a thread
 *   Rome started that nobody answered.
 * - `message`: a `getMessage` per outbound row, read for its `to`.
 * - `both`: the thread where the thread knows, a `getMessage` only where it
 *   does not.
 */
export type EmailAttribution = "thread" | "message" | "both";

export interface BackfillOptions {
  /** The instance's own mailbox address, for deciding direction. */
  self: string;
  attribution?: EmailAttribution;
  /** The cloud route clamps to 100; a smaller value is for tests that want
   *  more page boundaries. */
  pageSize?: number;
}

/**
 * Walk the mailbox newest-first and mirror every message.
 *
 * The provider offers no sender filter, so there is nothing to narrow with —
 * the backfill is the whole mailbox or nothing.
 */
export async function backfillEmail(
  db: DrizzleDb,
  provider: MailProvider,
  options: BackfillOptions,
): Promise<number> {
  const self = normalizeAddress(options.self);
  const attribution = options.attribution ?? "thread";
  const pageSize = options.pageSize ?? 100;

  let pageToken: string | undefined;
  let mirrored = 0;
  do {
    const page = await provider.listMessages({ limit: pageSize, ascending: false, pageToken });
    writeRows(db, page.messages.map((item) => rowFromListItem(item, self)));
    mirrored += page.messages.length;
    pageToken = page.nextPageToken;
    if (page.messages.length === 0) break;
  } while (pageToken);

  if (attribution !== "thread") await hydrateOutbound(db, provider, attribution);
  return mirrored;
}

function rowFromListItem(item: RomeMailListItem, self: string): MirrorRow {
  const fromAddress = normalizeAddress(item.from);
  return {
    providerMessageId: item.providerMessageId,
    threadId: item.threadId,
    fromAddress,
    // The hole this prototype exists to measure: a list row has no `to`.
    toAddress: null,
    outbound: item.labels.includes("sent") || (self !== "" && fromAddress === self),
    receivedAt: new Date(item.receivedAt),
    subject: item.subject ?? null,
    body: (item.preview ?? "").trim() || null,
  };
}

// One `getMessage` per outbound row that still has no recipient. Under `both`
// the thread already answers for most of them, so only the unanswered threads
// are paid for.
async function hydrateOutbound(
  db: DrizzleDb,
  provider: MailProvider,
  attribution: "message" | "both",
): Promise<void> {
  const unattributed = db.all(sql`
    SELECT m.provider_message_id AS id
    FROM email_messages_proto m
    LEFT JOIN email_threads_proto t ON t.thread_id = m.thread_id
    WHERE m.outbound = 1
      AND m.to_address IS NULL
      ${attribution === "both" ? sql`AND t.counterparty IS NULL` : sql``}
  `) as Array<{ id: string }>;

  for (const { id } of unattributed) {
    const full = await provider.getMessage(id);
    const to = normalizeAddress(full.to?.[0]?.email);
    if (to === "") continue;
    db.run(sql`
      UPDATE email_messages_proto SET to_address = ${to} WHERE provider_message_id = ${id}`);
  }
}

/**
 * The writer that hangs off the HMAC-verified inbound push
 * (`EmailAdapter.ingestInbound`), taking the same `RomeMailEvent` the handler
 * gets. Idempotent on the provider message id, which is the id the push path
 * already dedupes on.
 */
export function ingestInboundEmail(db: DrizzleDb, event: RomeMailEvent, body?: string): void {
  writeRows(db, [
    {
      providerMessageId: event.providerMessageId,
      threadId: event.threadId,
      fromAddress: normalizeAddress(event.from?.[0]?.email),
      toAddress: normalizeAddress(event.to?.[0]?.email) || null,
      outbound: false,
      receivedAt: new Date(event.receivedAt),
      subject: event.subject ?? null,
      body: (body ?? event.preview ?? "").trim() || null,
    },
  ]);
}

// ---------------------------------------------------------------------------
// A fake MailProvider — the real interface, the real paging shape
// ---------------------------------------------------------------------------

/** One message as the fake mailbox holds it. Only the list row is ever handed
 *  out whole; `to` and `body` are behind `getMessage`, as they are for real. */
export interface FakeMail {
  providerMessageId: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  preview: string;
  receivedAt: Date;
  outbound: boolean;
}

/** The cloud route's hard ceiling on a page. */
export const CLOUD_PAGE_CAP = 100;

export class FakeMailProvider implements MailProvider {
  listCalls = 0;
  getMessageCalls = 0;

  constructor(
    private readonly mailbox: FakeMail[],
    private readonly self: string,
  ) {}

  calls(): { list: number; getMessage: number } {
    return { list: this.listCalls, getMessage: this.getMessageCalls };
  }

  reset(): void {
    this.listCalls = 0;
    this.getMessageCalls = 0;
  }

  async listMessages(params: ListMessagesParams = {}): Promise<ListMessagesResult> {
    this.listCalls += 1;
    const ordered = [...this.mailbox].sort((a, b) =>
      params.ascending
        ? a.receivedAt.getTime() - b.receivedAt.getTime()
        : b.receivedAt.getTime() - a.receivedAt.getTime(),
    );
    const limit = Math.min(params.limit ?? CLOUD_PAGE_CAP, CLOUD_PAGE_CAP);
    // The cursor is opaque to the caller, which is the whole point: a store
    // cannot reconstruct it from a `TimelineEntry`.
    const offset = params.pageToken ? Number(params.pageToken) : 0;
    const slice = ordered.slice(offset, offset + limit);
    const next = offset + limit;
    return {
      messages: slice.map((mail) => ({
        providerMessageId: mail.providerMessageId,
        threadId: mail.threadId,
        from: mail.from,
        subject: mail.subject,
        preview: mail.preview,
        receivedAt: mail.receivedAt.toISOString(),
        labels: mail.outbound ? ["sent"] : ["inbox"],
        // No `to`. No body. That is the list row.
      })),
      nextPageToken: next < ordered.length ? String(next) : undefined,
    };
  }

  async getMessage(messageId: string): Promise<RomeMailMessage> {
    this.getMessageCalls += 1;
    const mail = this.mailbox.find((m) => m.providerMessageId === messageId);
    if (!mail) throw new Error(`no such message: ${messageId}`);
    return {
      id: mail.providerMessageId,
      threadId: mail.threadId,
      from: [{ email: mail.from }],
      to: [{ email: mail.to }],
      subject: mail.subject,
      preview: mail.preview,
      receivedAt: mail.receivedAt.toISOString(),
      body: { markdown: mail.preview },
      attachments: [],
      hasAttachment: false,
      provider: "fake",
      providerMessageId: mail.providerMessageId,
      mailboxAddress: this.self,
      direction: mail.outbound ? "outbound" : "inbound",
      authentication: { authenticated: true, spam: false, blocked: false },
      labels: mail.outbound ? ["sent"] : ["inbox"],
    } as RomeMailMessage;
  }

  async provision(): Promise<ProvisionResult> {
    throw new Error("not part of the question");
  }
  async send(_input: SendMailInput): Promise<SendMailResult> {
    throw new Error("not part of the question");
  }
  async getAttachment(_m: string, _a: string): Promise<MailAttachmentDownload> {
    throw new Error("not part of the question");
  }
}
