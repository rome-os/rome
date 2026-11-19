// The Slack app connection's own copy of the messages it hears: direct
// messages, and mentions of it in a group.
//
// The connection tells its mailbox a message was received only once the copy
// holds it, so the mailbox keeps whatever a crash or a stop interrupted and
// delivers it again. What the connection keeps is its own business: nothing
// outside connections/kinds/slack-app reads or writes the table, and nothing
// outside the connection can tell whether the copy exists.

import type { ChannelMessage } from "@rome-os/app-runtime";
import { and, asc, desc, eq, gt, gte, isNotNull, isNull, lt, max, or } from "drizzle-orm";
import type { DrizzleDb } from "../../../db/index.js";
import { slackAppMessages, slackAppTimeline } from "../../../db/schema.js";
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
  messages: Array<{ ts: string; message: ChannelMessage }>;
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
  keepRun(teamId: string, channelId: string, run: TimelineRun): void;
  /** The timeline message `ts` of chat `channelId`, if the copy holds it. */
  timelineRow(teamId: string, channelId: string, ts: string): TimelineRow | null;
  /** Up to `count` timeline messages of the chat older than `ts`, newest
   *  first. */
  timelineBefore(teamId: string, channelId: string, ts: string, count: number): TimelineRow[];
  /** The timeline message linked as coming right after `ts`, if any. */
  timelineAfter(teamId: string, channelId: string, ts: string): TimelineRow | null;
  /** Whether the copy holds a timeline message of the chat newer than `ts`. */
  holdsNewer(teamId: string, channelId: string, ts: string): boolean;
}

/** The copy in Rome's database. */
export class SlackMessageCopyRepository implements SlackMessageCopy {
  constructor(private readonly db: DrizzleDb) {}

  keep(kept: KeptSlackMessage, at: Date): boolean {
    const { raw: _raw, ...message } = kept.message;
    const written = this.db
      .insert(slackAppMessages)
      .values({
        teamId: kept.teamId,
        eventId: kept.eventId,
        channelId: kept.channelId,
        ts: kept.ts,
        threadTs: kept.threadTs ?? null,
        userId: kept.userId,
        text: kept.text,
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

  keepRun(teamId: string, channelId: string, run: TimelineRun): void {
    const { messages } = run;
    const where = (ts: string) =>
      and(
        eq(slackAppTimeline.teamId, teamId),
        eq(slackAppTimeline.channelId, channelId),
        eq(slackAppTimeline.ts, ts),
      );
    this.db.transaction((tx) => {
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
}

function timelineRowOf(row: typeof slackAppTimeline.$inferSelect): TimelineRow {
  return { ts: row.ts, prevTs: row.prevTs, message: revive(row.message) };
}

/** A message read back from JSON, its time a Date again. */
function revive(stored: unknown): ChannelMessage {
  const message = stored as ChannelMessage & { timestamp: string | Date };
  return { ...message, timestamp: new Date(message.timestamp) };
}
