// The Slack app connection's own copy of the direct messages it hears.
//
// The connection tells its mailbox a message was received only once the copy
// holds it, so the mailbox keeps whatever a crash or a stop interrupted and
// delivers it again. What the connection keeps is its own business: nothing
// outside connections/kinds/slack-app reads or writes the table, and nothing
// outside the connection can tell whether the copy exists.

import type { ChannelMessage } from "@rome-os/app-runtime";
import { and, asc, eq, gte, isNull, or } from "drizzle-orm";
import type { DrizzleDb } from "../../../db/index.js";
import { slackAppMessages } from "../../../db/schema.js";

/** One direct message as the connection keeps it. */
export interface KeptSlackMessage {
  teamId: string;
  /** Slack's event id, which names the delivery. */
  eventId: string;
  /** The direct message's conversation id. */
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
  /** Note that the message of event `eventId` was handed to Rome. */
  handedOver(teamId: string, eventId: string, at: Date): void;
  /** The messages kept for workspace `teamId` that Rome may not hold, oldest
   *  first: those never handed over, and those handed over at or after
   *  `since`, which a stop may have cut off before Rome recorded them. */
  mayNotHold(teamId: string, since: Date): Array<{ eventId: string; message: ChannelMessage }>;
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
      .where(and(eq(slackAppMessages.teamId, teamId), eq(slackAppMessages.eventId, eventId)))
      .run();
  }

  mayNotHold(teamId: string, since: Date): Array<{ eventId: string; message: ChannelMessage }> {
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
}

/** A message read back from JSON, its time a Date again. */
function revive(stored: unknown): ChannelMessage {
  const message = stored as ChannelMessage & { timestamp: string | Date };
  return { ...message, timestamp: new Date(message.timestamp) };
}
