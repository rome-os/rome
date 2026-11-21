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
import { slackAppMessages } from "../../../db/schema.js";

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
  /** Slack said the sender is a full member of this workspace when the
   *  message was heard: not a guest, a bot or a member of another one. */
  senderFullMember?: boolean;
}

/** A kept message to hand Rome again, with whether its sender was a full
 *  member of the workspace when it was heard, and when that was. */
export interface KeptForHandOver {
  eventId: string;
  message: ChannelMessage;
  senderFullMember?: true;
  /** When the copy kept the message, which is when Slack last named its
   *  sender's membership. */
  receivedAt: Date;
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
  mayNotHold(teamId: string, windowMs: number): Array<KeptForHandOver>;
}

/** The copy in Rome's database. */
export class SlackMessageCopyRepository implements SlackMessageCopy {
  constructor(private readonly db: DrizzleDb) {}

  keep(kept: KeptSlackMessage, at: Date): boolean {
    const { raw: _raw, ...said } = kept.message;
    const message = { ...said, ...(kept.senderFullMember ? { senderFullMember: true } : {}) };
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

  mayNotHold(teamId: string, windowMs: number): Array<KeptForHandOver> {
    const last = this.db
      .select({ at: max(slackAppMessages.handedOverAt) })
      .from(slackAppMessages)
      .where(eq(slackAppMessages.teamId, teamId))
      .get()?.at;
    const since = new Date((last ? last.getTime() : 0) - windowMs);
    return this.db
      .select({
        eventId: slackAppMessages.eventId,
        message: slackAppMessages.message,
        receivedAt: slackAppMessages.receivedAt,
      })
      .from(slackAppMessages)
      .where(
        and(
          eq(slackAppMessages.teamId, teamId),
          or(isNull(slackAppMessages.handedOverAt), gte(slackAppMessages.handedOverAt, since)),
        ),
      )
      .orderBy(asc(slackAppMessages.saidAt), asc(slackAppMessages.ts))
      .all()
      .map((row) => ({
        eventId: row.eventId,
        message: revive(row.message),
        receivedAt: row.receivedAt,
        ...((row.message as { senderFullMember?: boolean }).senderFullMember
          ? { senderFullMember: true as const }
          : {}),
      }));
  }
}

/** A message read back from JSON, its time a Date again. Whether its sender
 *  was a full member is a fact of its arrival, kept for its hand-over only,
 *  so no read answers it. */
function revive(stored: unknown): ChannelMessage {
  const {
    senderFullMember: _member,
    openToMembers: _open,
    ...message
  } = stored as ChannelMessage & { timestamp: string | Date; senderFullMember?: boolean };
  return { ...message, timestamp: new Date(message.timestamp) };
}
