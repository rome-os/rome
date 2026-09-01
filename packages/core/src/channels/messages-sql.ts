// The SQL half of `Messages`: a store that lives in this database becomes one
// by describing its rows as timeline entries once, and this module scopes,
// orders, pages and — the part that is not just plumbing — groups the calls
// made against it.
//
// Grouping is the point. The People surface reads a whole directory at once:
// one `latest` and one `count` per row, all issued together. Served one query
// each, a directory of a thousand people is a thousand passes over the same
// mirror. Served here, it is one, the way the WhatsApp address book already
// answers concurrent `resolve` calls from a single shared load.

import { sql, type SQL } from "drizzle-orm";
import type { TimelineEntry } from "@rome/api-types/people";
import type { DrizzleDb } from "../db/index.js";
import type {
  ConversationRead,
  MessageAccount,
  MessageConversation,
  MessageRead,
  Messages,
} from "./messages.js";

/**
 * A store's rows as timeline entries: a SELECT producing exactly the columns
 * `source`, `key`, `at`, `outbound`, `ref`, `body`.
 *
 * - `source` is the channel an entry arrived on, and `key` the scope entry the
 *   row answers for — one of the strings the view was handed, which is an
 *   address of the account a message belongs to when the scope asks by account,
 *   and the id of the conversation it was said in when it asks by conversation.
 * - `at` is epoch seconds, `outbound` is 1 for something Rome said and 0 for
 *   something it was told, `body` is the line to render or NULL.
 * - `ref` must be unique across everything the store can put on one person's
 *   timeline. Ids unique only within a conversation (a WhatsApp message id, a
 *   LinkedIn message id) are qualified by the conversation.
 *
 * A row may repeat one message under several keys — a LinkedIn thread carrying
 * two member ids of the same person answers under both. The reads below fold
 * those together, so a view is free to attribute rather than choose.
 */
export type MessageViewSql = SQL;

/** One string a store is scoped by, on the channel that holds it — an address,
 *  or a conversation id. The pair rather than the string alone, since the pair
 *  is what names the thing: two channels are free to spell one the same way and
 *  mean two different people, or two different threads. */
export interface MessageScopeKey {
  channel: string;
  key: string;
}

/**
 * What a batch of calls asked a store for.
 *
 * `by` is the question, and it is the whole difference between the reads a
 * store answers: the same rows, scoped by who a message passed between or by
 * the thread it was said in. A batch asks one question — the queues below are
 * per question — so a view reads `by` once and scopes its rows to match.
 */
export interface MessageScope {
  by: "account" | "conversation";
  /** Every key the batch named, each once. Never empty: a request that can hold
   *  nothing is answered without reaching the view at all. */
  keys: readonly MessageScopeKey[];
}

export interface SqlMessagesOptions {
  /**
   * The channel this store serves, when it serves exactly one — a channel's
   * own mirror. Accounts on any other are out of its scope, however their
   * addresses read.
   *
   * Absent for a store that holds every channel's messages side by side and
   * keys them by the pair: Rome's own transcript, the sentinel's log. Such a
   * store is scoped by `(channel, key)` throughout, and its view is handed the
   * pairs rather than bare strings so it can say the same.
   */
  channel?: string;
  db: DrizzleDb;
  /**
   * The store's rows, scoped to what a batch of calls named.
   *
   * Null when the request can hold nothing, and the store then answers empty
   * without a query.
   */
  view(scope: MessageScope): MessageViewSql | null;
  /**
   * The view's `body` column mapped to the line to render, for a store whose
   * text is not stored as text — Rome's transcript keeps a JSON array of
   * blocks. Runs on the answered page rather than on the scope, so it can be
   * as expensive as the parse it wraps.
   */
  body?(raw: string | null): string | null;
}

/**
 * `Messages` over one SQL view.
 *
 * Every call — `read`, `count`, `latest`, `readConversation` — is one job on a
 * queue, and the jobs raised in a tick are answered by a single statement. What
 * differs between them is only the shape of the job:
 *
 * - `read` asks for a page and takes the entries.
 * - `latest` asks for a page of one and takes its head.
 * - `count` asks for no page at all and takes the length the statement reports
 *   alongside it.
 *
 * So the law messages.ts states holds by construction rather than by three
 * queries agreeing: the count is the length of the history the page walks,
 * because both are read off the same ranking of the same rows.
 *
 * A queue per question rather than one for all four, because a batch reaches
 * the view as a single scope: account jobs and conversation jobs pooled
 * together would ask one SELECT to answer two questions. The grouping that
 * matters is untouched — a directory read raises account jobs only, and those
 * still share one pass.
 */
export function sqlMessages(options: SqlMessagesOptions): Messages {
  const byAccount = batched<Job, JobResult>((jobs) => runBatch(options, "account", jobs));
  const byConversation = batched<Job, JobResult>((jobs) => runBatch(options, "conversation", jobs));

  const job = (accounts: readonly MessageAccount[], after: TimelineEntry | null, limit: number) =>
    byAccount({ keys: accountKeys(accounts, options.channel), after, limit });

  return {
    async read(request: MessageRead) {
      const limit = Math.max(1, Math.floor(request.limit));
      return (await job(request.accounts, request.after ?? null, limit)).entries;
    },

    async count(accounts) {
      return (await job(accounts, null, COUNT_ONLY)).total;
    },

    async latest(accounts) {
      return (await job(accounts, null, 1)).entries[0] ?? null;
    },

    async readConversation(request: ConversationRead) {
      const limit = Math.max(1, Math.floor(request.limit));
      const answered = await byConversation({
        keys: conversationKeys(request.conversation, options.channel),
        after: request.after ?? null,
        limit,
      });
      return answered.entries;
    },
  };
}

/**
 * Every address of every account the store serves, each pair once.
 *
 * `(channel, address)` throughout — an address on one channel must never
 * select a row another channel stores under the same string. A store bound to
 * one channel drops the accounts on every other here; a store that serves them
 * all keeps the channel beside each address and matches on both.
 */
function accountKeys(
  accounts: readonly MessageAccount[],
  channel: string | undefined,
): MessageScopeKey[] {
  const scope = new Map<string, MessageScopeKey>();
  for (const account of accounts) {
    if (channel !== undefined && account.channel !== channel) continue;
    for (const address of account.addresses) {
      scope.set(`${account.channel}\n${address}`, { channel: account.channel, key: address });
    }
  }
  return [...scope.values()];
}

/** The conversation as the batch names it, and nothing at all when the store
 *  serves another channel — the same subtraction {@link accountKeys} makes for
 *  an account, a conversation id being no more portable across channels than an
 *  address is. */
function conversationKeys(
  conversation: MessageConversation,
  channel: string | undefined,
): MessageScopeKey[] {
  if (channel !== undefined && conversation.channel !== channel) return [];
  return [{ channel: conversation.channel, key: conversation.id }];
}

/** Every key in a scope, each once — what a view on a single channel needs, the
 *  channel being its own. */
export function keysIn(scope: readonly MessageScopeKey[]): string[] {
  return [...new Set(scope.map((entry) => entry.key))];
}

/** One call, as the batch sees it. `limit` of {@link COUNT_ONLY} is a job that
 *  wants the length of a history and none of it. */
interface Job {
  keys: readonly MessageScopeKey[];
  after: TimelineEntry | null;
  limit: number;
}

interface JobResult {
  entries: TimelineEntry[];
  /** The length of the job's whole history — meaningful for a job with no
   *  cursor, which is every job `count` raises. */
  total: number;
}

const COUNT_ONLY = 0;

/** A history the store holds none of. Built per job rather than shared: the
 *  entries are the caller's array to do as it likes with. */
const nothing = (): JobResult => ({ entries: [], total: 0 });

/**
 * One statement for a whole batch.
 *
 * The jobs enter the query as two tables of their own — which keys each asked
 * about, and where each wants to resume and how much of the history it wants —
 * so the rows are scoped, ranked and cut per job inside a single pass rather
 * than once per job.
 */
async function runBatch(
  options: SqlMessagesOptions,
  by: MessageScope["by"],
  jobs: Job[],
): Promise<JobResult[]> {
  const asked = jobs.flatMap((job, index) => job.keys.map((entry) => ({ index, ...entry })));
  if (asked.length === 0) return jobs.map(nothing);

  const wanted = new Map(asked.map((entry) => [`${entry.channel}\n${entry.key}`, entry]));
  const rows = options.view({
    by,
    keys: [...wanted.values()].map(({ channel, key }) => ({ channel, key })),
  });
  if (rows === null) return jobs.map(nothing);

  const scope = sql.join(
    asked.map((entry) => sql`(${entry.index}, ${entry.channel}, ${entry.key})`),
    sql`, `,
  );
  const ask = sql.join(
    jobs.map((job, index) => askRow(index, job)),
    sql`, `,
  );

  const answered = (await options.db.all(sql`
    WITH scope(rq, source, held_key) AS (VALUES ${scope}),
    ask(rq, cap, has_cursor, c_at, c_outbound, c_source, c_ref) AS (VALUES ${ask}),
    -- One row per (job, message). DISTINCT because a view may attribute one
    -- message to several of a job's keys — a LinkedIn thread carrying two
    -- member ids of the same person — and a person's history shows a message
    -- once however many ways they are named on it.
    scoped AS (
      SELECT DISTINCT
        scope.rq AS rq,
        held.source AS source,
        held.at AS at,
        held.outbound AS outbound,
        held.ref AS ref,
        held.body AS body
      FROM (${rows}) held
      -- The pair, never the key alone: a store holding several channels side by
      -- side would otherwise hand one channel's message to a job that asked
      -- about the same string on another.
      JOIN scope ON scope.source = held.source AND scope.held_key = held.key
    ),
    -- Each job's own history, ranked and measured in one pass. One named
    -- window rather than two inline ones: SQLite shares a partition pass only
    -- between windows spelled the same way, and two spellings sort every job's
    -- history twice.
    --
    -- The frame is explicit because the window's ORDER BY would otherwise make
    -- count(*) a running total — the length of the history above each row
    -- rather than the length of the history.
    ranked AS (
      SELECT
        scoped.rq AS rq,
        scoped.source AS source,
        scoped.at AS at,
        scoped.outbound AS outbound,
        scoped.ref AS ref,
        scoped.body AS body,
        ask.cap AS cap,
        row_number() OVER w AS position,
        count(*) OVER w AS total
      FROM scoped
      JOIN ask ON ask.rq = scoped.rq
      WHERE ${AFTER_CURSOR}
      WINDOW w AS (
        PARTITION BY scoped.rq
        ORDER BY scoped.at DESC, scoped.outbound DESC, scoped.source ASC, scoped.ref ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
      )
    )
    -- Never fewer than one row per job: a job that asked for no page still has
    -- to be told how long the history it did not ask for is.
    SELECT rq, source, at, outbound, ref, body, position, total
    FROM ranked
    WHERE position <= max(cap, 1)
    ORDER BY rq ASC, position ASC
  `)) as Array<Record<string, unknown>>;

  const results = jobs.map(nothing);
  for (const row of answered) {
    const rq = Number(row.rq);
    const result = results[rq];
    const job = jobs[rq];
    if (!result || !job) continue;
    result.total = Number(row.total);
    // The head of a history is answered whether or not the job asked for a
    // page, so a job that only wanted the length discards the row it read it
    // off.
    if (Number(row.position) <= job.limit) result.entries.push(toEntry(row, options.body));
  }
  return results;
}

/** A job as a row of the `ask` table: how much of its history it wants, and
 *  the cursor it resumes from, spread across columns so the comparison below
 *  can be written once for the whole batch. */
function askRow(index: number, job: Job): SQL {
  const after = job.after;
  if (after === null) return sql`(${index}, ${job.limit}, 0, 0, 0, '', '')`;
  const outbound = after.direction === "outbound" ? 1 : 0;
  return sql`(${index}, ${job.limit}, 1, ${after.timestamp}, ${outbound}, ${after.source}, ${after.ref})`;
}

/**
 * The rows that fall strictly after a job's cursor, in the order the window's
 * ORDER BY imposes — which is `compareTimelineEntries` read as SQL.
 *
 * The whole tuple, not `at < c_at`: a second holds more than one entry, and
 * resuming from the bare timestamp drops the rest of that second.
 *
 * The two text comparisons ride SQLite's BINARY collation, which orders UTF-8
 * by byte and therefore by code point — the same answer `compareCodePoints`
 * gives, which is what makes a cursor mean one position on both ends.
 */
const AFTER_CURSOR = sql`
  ask.has_cursor = 0
  OR scoped.at < ask.c_at
  OR (scoped.at = ask.c_at
      AND (scoped.outbound < ask.c_outbound
           OR (scoped.outbound = ask.c_outbound
               AND (scoped.source > ask.c_source
                    OR (scoped.source = ask.c_source AND scoped.ref > ask.c_ref)))))`;

function toEntry(
  row: Record<string, unknown>,
  body?: (raw: string | null) => string | null,
): TimelineEntry {
  const raw = (row.body as string | null) ?? null;
  return {
    source: String(row.source),
    timestamp: Number(row.at),
    direction: Number(row.outbound) === 1 ? "outbound" : "inbound",
    ref: String(row.ref),
    body: body ? body(raw) : raw,
  };
}

/**
 * `run` over every call raised in one tick, each caller answered with the
 * result at its own position.
 *
 * A microtask rather than a timer, so "together" means what a caller means by
 * it: the calls of one `Promise.all` batch, and a call awaited before the next
 * is made does not. Nothing is held across a turn, so no answer is ever older
 * than the call that asked for it.
 */
function batched<J, R>(run: (jobs: J[]) => Promise<R[]>): (job: J) => Promise<R> {
  type Waiting = { job: J; settle: (result: R) => void; fail: (error: unknown) => void };
  let pending: Waiting[] | null = null;

  return (job) =>
    new Promise<R>((settle, fail) => {
      if (pending === null) {
        const batch: Waiting[] = [];
        pending = batch;
        queueMicrotask(() => {
          pending = null;
          run(batch.map((waiting) => waiting.job)).then(
            (results) =>
              batch.forEach((waiting, index) => {
                const result = results[index];
                if (result === undefined) waiting.fail(new Error("the batch answered no result"));
                else waiting.settle(result);
              }),
            (error) => {
              for (const waiting of batch) waiting.fail(error);
            },
          );
        });
      }
      pending.push({ job, settle, fail });
    });
}

/**
 * A whole scope as a WHERE clause: `(channel = … AND key IN (…))` per channel,
 * or'd together, and null when the scope is empty.
 *
 * What a store holding several channels side by side scopes itself with. The
 * pair rather than the key alone, for the reason the batch's join gives: two
 * channels may spell one the same way and mean two different things.
 */
export function scopePairs(
  scope: readonly MessageScopeKey[],
  channelColumn: SQL,
  keyColumn: SQL,
): SQL | null {
  const byChannel = new Map<string, string[]>();
  for (const { channel, key } of scope) {
    const keys = byChannel.get(channel);
    if (keys) keys.push(key);
    else byChannel.set(channel, [key]);
  }
  const clauses = [...byChannel]
    .map(([channel, keys]) => {
      const held = inList(keyColumn, keys);
      return held === null ? null : sql`(${channelColumn} = ${channel} AND ${held})`;
    })
    .filter((clause): clause is SQL => clause !== null);
  if (clauses.length === 0) return null;
  return sql`(${sql.join(clauses, sql` OR `)})`;
}

/** `column IN (…)` over `values`, or null when there is nothing to match —
 *  `IN ()` is not SQL, and a caller that emitted it would fail the whole read
 *  rather than answer the empty page an empty scope means. */
export function inList(column: SQL, values: readonly string[]): SQL | null {
  if (values.length === 0) return null;
  return sql`${column} IN (${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )})`;
}
