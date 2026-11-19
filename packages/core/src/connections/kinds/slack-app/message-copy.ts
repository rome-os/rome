// The Slack app connection's own copy of the messages it hears: direct
// messages, and mentions of it in a group.
//
// The connection tells its mailbox a message was received only once the copy
// holds it, so the mailbox keeps whatever a crash or a stop interrupted and
// delivers it again. What the connection keeps is its own business: nothing
// outside connections/kinds/slack-app reads or writes the table, and nothing
// outside the connection can tell whether the copy exists.

import type { ChannelMessage } from "@rome-os/app-runtime";
import type Database from "better-sqlite3";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  lt,
  max,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import type { DrizzleDb } from "../../../db/index.js";
import { slackAppChanges, slackAppMessages, slackAppTimeline } from "../../../db/schema.js";
import { compareTs } from "./timeline-order.js";

/** One message of a chat's timeline as the copy holds it. */
export interface TimelineRow {
  ts: string;
  /** The message just before it: "" when it is the chat's first, null when
   *  the copy does not know. */
  prevTs: string | null;
  message: ChannelMessage;
}

/**
 * Messages the connection saw one after another in a chat's timeline, with
 * nothing between them it did not see. Newest first.
 */
export interface TimelineRun {
  /** Each with the ts of its last edit when a page Slack answered showed one. */
  messages: Array<{ ts: string; message: ChannelMessage; editedTs?: string }>;
  /** The message just before the oldest: "" when that is the chat's first
   *  message, null when unknown. */
  before: string | null;
  /** A message the copy holds that comes right after the newest. */
  after?: string;
}

/** One message as the connection keeps it. */
export interface KeptSlackMessage {
  teamId: string;
  /** Slack's event id, which names the delivery. */
  eventId: string;
  /** The conversation id: a direct message's, or a group's. */
  channelId: string;
  ts: string;
  threadTs?: string;
  userId: string;
  /** The text as Rome reads it. */
  text: string;
  /** The message as the connection hands it to Rome. */
  message: ChannelMessage;
}

/** Where the Slack app connection keeps its copy. */
export interface SlackMessageCopy {
  /** Keep `kept`, and answer false when its event was kept already. */
  keep(kept: KeptSlackMessage, at: Date): boolean;
  /** Note that the message of event `eventId` was first handed to Rome. */
  handedOver(teamId: string, eventId: string, at: Date): void;
  /** The messages kept for workspace `teamId` that Rome may not hold, oldest
   *  first: those never handed over, and those handed over within `windowMs`
   *  of the last hand-off, which a stop may have cut off before Rome recorded
   *  them. The window runs back from the last hand-off, not from now, so a
   *  long stop does not shrink it. */
  mayNotHold(teamId: string, windowMs: number): Array<{ eventId: string; message: ChannelMessage }>;
  /** Keep `run` in the timeline of chat `channelId`, linking each message to
   *  the one before it. A link the run shows wrong, because the run holds a
   *  message between its two ends, is forgotten. */
  /** Answers the run's messages as kept: without one deleted since, and
   *  with an edit the copy took that is newer than the run's text. */
  keepRun(teamId: string, channelId: string, run: TimelineRun): TimelineRun["messages"];
  /** The timeline message `ts` of chat `channelId`, if the copy holds it. */
  timelineRow(teamId: string, channelId: string, ts: string): TimelineRow | null;
  /** Up to `count` timeline messages of the chat older than `ts`, newest
   *  first. */
  timelineBefore(teamId: string, channelId: string, ts: string, count: number): TimelineRow[];
  /** The timeline message linked as coming right after `ts`, if any. */
  timelineAfter(teamId: string, channelId: string, ts: string): TimelineRow | null;
  /** Whether the copy holds a timeline message of the chat newer than `ts`. */
  holdsNewer(teamId: string, channelId: string, ts: string): boolean;
  /** Forget any link across `ts`: a timeline message the connection did not
   *  keep sits there, so the messages either side of it are not adjacent. */
  unlinkAcross(teamId: string, channelId: string, ts: string): void;
  /** Take a change Slack made to message `ts` of chat `channelId` at
   *  `changedTs`: its text now `text`, or deleted when null. A change older
   *  than one the copy took changes nothing, and answers false. A deleted
   *  timeline message's successor links to the one before it, as Slack's
   *  history now shows them. */
  change(
    teamId: string,
    channelId: string,
    ts: string,
    change: { changedTs: string; text: string | null },
  ): boolean;
  /** Whether message `ts` of chat `channelId` was deleted. */
  deleted(teamId: string, channelId: string, ts: string): boolean;
  /** Up to `limit` messages the copy holds for the workspace whose text holds
   *  `text`, ignoring case, in chat `channelId` when named, newest first. Both
   *  the messages heard and the timeline messages read count, each once. */
  search(
    teamId: string,
    input: { text: string; channelId?: string; limit: number },
  ): ChannelMessage[];
}

/** The copy in Rome's database. */
export class SlackMessageCopyRepository implements SlackMessageCopy {
  constructor(private readonly db: DrizzleDb) {}

  keep(kept: KeptSlackMessage, at: Date): boolean {
    const { raw: _raw, ...said } = kept.message;
    // A message deleted since is not kept again when Slack retries its event,
    // and one edited since is kept as edited.
    const changed = this.changeOf(this.db, kept.teamId, kept.channelId, kept.ts);
    if (changed && changed.text === null) return false;
    const text = changed?.text ?? kept.text;
    const message = changed ? { ...said, text } : said;
    const written = this.db
      .insert(slackAppMessages)
      .values({
        teamId: kept.teamId,
        eventId: kept.eventId,
        channelId: kept.channelId,
        ts: kept.ts,
        threadTs: kept.threadTs ?? null,
        userId: kept.userId,
        text,
        saidAt: message.timestamp,
        message,
        receivedAt: at,
        handedOverAt: null,
      })
      .onConflictDoNothing()
      .run();
    return written.changes > 0;
  }

  handedOver(teamId: string, eventId: string, at: Date): void {
    this.db
      .update(slackAppMessages)
      .set({ handedOverAt: at })
      // The first hand-off counts: handing a message over again on start
      // does not move the window `mayNotHold` measures from.
      .where(
        and(
          eq(slackAppMessages.teamId, teamId),
          eq(slackAppMessages.eventId, eventId),
          isNull(slackAppMessages.handedOverAt),
        ),
      )
      .run();
  }

  mayNotHold(
    teamId: string,
    windowMs: number,
  ): Array<{ eventId: string; message: ChannelMessage }> {
    const last = this.db
      .select({ at: max(slackAppMessages.handedOverAt) })
      .from(slackAppMessages)
      .where(eq(slackAppMessages.teamId, teamId))
      .get()?.at;
    const since = new Date((last ? last.getTime() : 0) - windowMs);
    return this.db
      .select({ eventId: slackAppMessages.eventId, message: slackAppMessages.message })
      .from(slackAppMessages)
      .where(
        and(
          eq(slackAppMessages.teamId, teamId),
          or(isNull(slackAppMessages.handedOverAt), gte(slackAppMessages.handedOverAt, since)),
        ),
      )
      .orderBy(asc(slackAppMessages.saidAt), asc(slackAppMessages.ts))
      .all()
      .map((row) => ({ eventId: row.eventId, message: revive(row.message) }));
  }

  keepRun(teamId: string, channelId: string, run: TimelineRun): TimelineRun["messages"] {
    let kept: TimelineRun["messages"] = [];
    const where = (ts: string) =>
      and(
        eq(slackAppTimeline.teamId, teamId),
        eq(slackAppTimeline.channelId, channelId),
        eq(slackAppTimeline.ts, ts),
      );
    this.db.transaction((tx) => {
      // A page read before a change, or a message heard again, is taken as
      // Slack shows it since: a deleted message is not there, and an edited
      // one reads as edited.
      // The newer of the page's version and the change the copy took wins:
      // a page read before an edit's event arrived can show the newer text.
      const messages = run.messages.flatMap((m) => {
        const changed = this.changeOf(tx, teamId, channelId, m.ts);
        if (changed?.text === null) return [];
        if (changed && compareTs(changed.changedTs, m.editedTs ?? m.ts) >= 0) {
          return [{ ...m, message: { ...m.message, text: changed.text } }];
        }
        if (m.editedTs !== undefined) {
          const change = { changedTs: m.editedTs, text: m.message.text };
          tx.insert(slackAppChanges)
            .values({ teamId, channelId, ts: m.ts, ...change })
            .onConflictDoUpdate({
              target: [slackAppChanges.teamId, slackAppChanges.channelId, slackAppChanges.ts],
              set: change,
            })
            .run();
        }
        return [m];
      });
      kept = messages;
      // A row the copy holds between the run's oldest message and the one it
      // says comes before shows that link wrong, as a page Slack answered
      // before a late event does.
      const oldestTs = messages.at(-1)?.ts;
      const before =
        run.before && oldestTs !== undefined
          ? tx
              .select({ ts: slackAppTimeline.ts })
              .from(slackAppTimeline)
              .where(
                and(
                  eq(slackAppTimeline.teamId, teamId),
                  eq(slackAppTimeline.channelId, channelId),
                  gt(slackAppTimeline.ts, run.before),
                  lt(slackAppTimeline.ts, oldestTs),
                ),
              )
              .all()
              .some(
                (row) =>
                  compareTs(row.ts, run.before as string) > 0 && compareTs(row.ts, oldestTs) < 0,
              )
            ? null
            : run.before
          : run.before;
      for (const [i, { ts, message }] of messages.entries()) {
        const { raw: _raw, ...kept } = message;
        const prevTs = i + 1 < messages.length ? messages[i + 1].ts : before;
        tx.insert(slackAppTimeline)
          .values({ teamId, channelId, ts, prevTs, saidAt: kept.timestamp, message: kept })
          .onConflictDoUpdate({
            target: [slackAppTimeline.teamId, slackAppTimeline.channelId, slackAppTimeline.ts],
            // A link the copy knew stays when this run does not know it.
            set: prevTs === null ? { message: kept } : { message: kept, prevTs },
          })
          .run();
      }
      const newest = messages[0]?.ts ?? run.before;
      if (run.after !== undefined && newest !== null) {
        tx.update(slackAppTimeline).set({ prevTs: newest }).where(where(run.after)).run();
      }
      if (messages.length === 0) return;
      // A message of this run between a row and the message it links to
      // shows that link wrong.
      const inRun = new Set(messages.map((m) => m.ts));
      const oldest = messages[messages.length - 1].ts;
      const candidates = tx
        .select({ ts: slackAppTimeline.ts, prevTs: slackAppTimeline.prevTs })
        .from(slackAppTimeline)
        .where(
          and(
            eq(slackAppTimeline.teamId, teamId),
            eq(slackAppTimeline.channelId, channelId),
            gt(slackAppTimeline.ts, oldest),
            isNotNull(slackAppTimeline.prevTs),
            lt(slackAppTimeline.prevTs, messages[0].ts),
          ),
        )
        .all();
      for (const row of candidates) {
        if (inRun.has(row.ts) || row.ts === run.after || row.prevTs === null) continue;
        const prev = row.prevTs;
        const between = messages.some(
          (m) => compareTs(m.ts, prev) > 0 && compareTs(m.ts, row.ts) < 0,
        );
        if (between) tx.update(slackAppTimeline).set({ prevTs: null }).where(where(row.ts)).run();
      }
    });
    return kept;
  }

  change(
    teamId: string,
    channelId: string,
    ts: string,
    { changedTs, text }: { changedTs: string; text: string | null },
  ): boolean {
    return this.db.transaction((tx) => {
      const held = this.changeOf(tx, teamId, channelId, ts);
      if (held && compareTs(held.changedTs, changedTs) >= 0) return false;
      tx.insert(slackAppChanges)
        .values({ teamId, channelId, ts, changedTs, text })
        .onConflictDoUpdate({
          target: [slackAppChanges.teamId, slackAppChanges.channelId, slackAppChanges.ts],
          set: { changedTs, text },
        })
        .run();
      const heard = and(
        eq(slackAppMessages.teamId, teamId),
        eq(slackAppMessages.channelId, channelId),
        eq(slackAppMessages.ts, ts),
      );
      const inChat = and(
        eq(slackAppTimeline.teamId, teamId),
        eq(slackAppTimeline.channelId, channelId),
      );
      const timeline = and(inChat, eq(slackAppTimeline.ts, ts));
      if (text !== null) {
        tx.update(slackAppMessages)
          .set({ text, message: sql`json_set(${slackAppMessages.message}, '$.text', ${text})` })
          .where(heard)
          .run();
        tx.update(slackAppTimeline)
          .set({ message: sql`json_set(${slackAppTimeline.message}, '$.text', ${text})` })
          .where(timeline)
          .run();
        return true;
      }
      const row = tx
        .select({ prevTs: slackAppTimeline.prevTs })
        .from(slackAppTimeline)
        .where(timeline)
        .get();
      if (row) {
        tx.update(slackAppTimeline)
          .set({ prevTs: row.prevTs })
          .where(and(inChat, eq(slackAppTimeline.prevTs, ts)))
          .run();
        tx.delete(slackAppTimeline).where(timeline).run();
      }
      tx.delete(slackAppMessages).where(heard).run();
      return true;
    });
  }

  deleted(teamId: string, channelId: string, ts: string): boolean {
    return this.changeOf(this.db, teamId, channelId, ts)?.text === null;
  }

  /** The newest change the copy took to message `ts`, if any. */
  private changeOf(
    db: Pick<DrizzleDb, "select">,
    teamId: string,
    channelId: string,
    ts: string,
  ): { changedTs: string; text: string | null } | undefined {
    return db
      .select({ changedTs: slackAppChanges.changedTs, text: slackAppChanges.text })
      .from(slackAppChanges)
      .where(
        and(
          eq(slackAppChanges.teamId, teamId),
          eq(slackAppChanges.channelId, channelId),
          eq(slackAppChanges.ts, ts),
        ),
      )
      .get();
  }

  timelineRow(teamId: string, channelId: string, ts: string): TimelineRow | null {
    const row = this.db
      .select()
      .from(slackAppTimeline)
      .where(
        and(
          eq(slackAppTimeline.teamId, teamId),
          eq(slackAppTimeline.channelId, channelId),
          eq(slackAppTimeline.ts, ts),
        ),
      )
      .get();
    return row ? timelineRowOf(row) : null;
  }

  timelineBefore(teamId: string, channelId: string, ts: string, count: number): TimelineRow[] {
    return this.db
      .select()
      .from(slackAppTimeline)
      .where(
        and(
          eq(slackAppTimeline.teamId, teamId),
          eq(slackAppTimeline.channelId, channelId),
          lt(slackAppTimeline.ts, ts),
        ),
      )
      .orderBy(desc(slackAppTimeline.ts))
      .limit(count)
      .all()
      .map(timelineRowOf);
  }

  timelineAfter(teamId: string, channelId: string, ts: string): TimelineRow | null {
    const row = this.db
      .select()
      .from(slackAppTimeline)
      .where(
        and(
          eq(slackAppTimeline.teamId, teamId),
          eq(slackAppTimeline.channelId, channelId),
          eq(slackAppTimeline.prevTs, ts),
        ),
      )
      .get();
    return row ? timelineRowOf(row) : null;
  }

  unlinkAcross(teamId: string, channelId: string, ts: string): void {
    const inChat = and(
      eq(slackAppTimeline.teamId, teamId),
      eq(slackAppTimeline.channelId, channelId),
    );
    this.db.transaction((tx) => {
      const across = tx
        .select({ ts: slackAppTimeline.ts, prevTs: slackAppTimeline.prevTs })
        .from(slackAppTimeline)
        .where(and(inChat, gt(slackAppTimeline.ts, ts), isNotNull(slackAppTimeline.prevTs)))
        .all()
        .filter((row) => compareTs(row.ts, ts) > 0 && compareTs(row.prevTs as string, ts) < 0);
      for (const row of across) {
        tx.update(slackAppTimeline)
          .set({ prevTs: null })
          .where(and(inChat, eq(slackAppTimeline.ts, row.ts)))
          .run();
      }
    });
  }

  holdsNewer(teamId: string, channelId: string, ts: string): boolean {
    const row = this.db
      .select({ ts: slackAppTimeline.ts })
      .from(slackAppTimeline)
      .where(
        and(
          eq(slackAppTimeline.teamId, teamId),
          eq(slackAppTimeline.channelId, channelId),
          gt(slackAppTimeline.ts, ts),
        ),
      )
      .limit(1)
      .get();
    return row !== undefined;
  }

  search(
    teamId: string,
    { text, channelId, limit }: { text: string; channelId?: string; limit: number },
  ): ChannelMessage[] {
    // SQLite's LIKE folds ASCII case only, so the copy is read newest first
    // and matched here, folding any script's case. Each table is read by one
    // statement, streamed until enough match, so a search sorts once however
    // far back it reads.
    const needle = phraseOf(text);
    const heard = this.newestMatching(
      limit,
      needle,
      this.db
        .select({
          message: slackAppMessages.message,
          ts: slackAppMessages.ts,
          text: slackAppMessages.text,
        })
        .from(slackAppMessages)
        .where(
          and(
            eq(slackAppMessages.teamId, teamId),
            channelId === undefined ? undefined : eq(slackAppMessages.channelId, channelId),
            // A message the timeline also holds is matched there, in the
            // newest text Slack showed: a page read since may hold an edit.
            notExists(
              this.db
                .select({ ts: slackAppTimeline.ts })
                .from(slackAppTimeline)
                .where(
                  and(
                    eq(slackAppTimeline.teamId, slackAppMessages.teamId),
                    eq(slackAppTimeline.channelId, slackAppMessages.channelId),
                    eq(slackAppTimeline.ts, slackAppMessages.ts),
                  ),
                ),
            ),
          ),
        )
        .orderBy(desc(slackAppMessages.saidAt), desc(slackAppMessages.ts)),
    );
    const read = this.newestMatching(
      limit,
      needle,
      this.db
        .select({
          message: slackAppTimeline.message,
          ts: slackAppTimeline.ts,
          text: sql<string | null>`json_extract(${slackAppTimeline.message}, '$.text')`,
        })
        .from(slackAppTimeline)
        .where(
          and(
            eq(slackAppTimeline.teamId, teamId),
            channelId === undefined ? undefined : eq(slackAppTimeline.channelId, channelId),
          ),
        )
        .orderBy(desc(slackAppTimeline.saidAt), desc(slackAppTimeline.ts)),
    );
    const found = new Map<string, ChannelMessage>();
    for (const row of [...heard, ...read].sort((a, b) => compareTs(b.ts, a.ts))) {
      const message = revive(row.message);
      const key = `${message.chatId}:${message.messageId}`;
      if (!found.has(key)) found.set(key, message);
    }
    return [...found.values()].slice(0, limit);
  }

  /** The first `limit` rows of `query`, which selects message, ts and text in
   *  that order, whose text holds `needle`. The rows are streamed, so reading
   *  stops once enough match. */
  private newestMatching(
    limit: number,
    needle: string,
    query: { toSQL(): { sql: string; params: unknown[] } },
  ): Array<{ message: unknown; ts: string }> {
    const { sql: statement, params } = query.toSQL();
    const client = (this.db as DrizzleDb & { $client: Database.Database }).$client;
    const matched: Array<{ message: unknown; ts: string }> = [];
    if (limit <= 0) return matched;
    for (const row of client
      .prepare(statement)
      .raw()
      .iterate(...params)) {
      const [message, ts, text] = row as [string, string, string | null];
      if (text === null || !folded(text).includes(needle)) continue;
      matched.push({ message: JSON.parse(message), ts });
      if (matched.length === limit) break;
    }
    return matched;
  }
}

/** `text` with its case folded in any script, its characters composed one
 *  way and each run of whitespace made one space, so `Équipe` matches
 *  `équipe` however each was typed, and a phrase matches across a line break. */
function folded(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/\s+/g, " ");
}

/** What a search looks for: its text folded, without the quotation marks an
 *  agent wraps a phrase in. A search matches its words in that order anyway. */
function phraseOf(text: string): string {
  return folded(text)
    .trim()
    .replace(/^["\u201c\u201d']+(.*?)["\u201c\u201d']+$/s, "$1")
    .trim();
}

function timelineRowOf(row: typeof slackAppTimeline.$inferSelect): TimelineRow {
  return { ts: row.ts, prevTs: row.prevTs, message: revive(row.message) };
}

/** A message read back from JSON, its time a Date again. */
function revive(stored: unknown): ChannelMessage {
  const message = stored as ChannelMessage & { timestamp: string | Date };
  return { ...message, timestamp: new Date(message.timestamp) };
}
