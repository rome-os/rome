// Seeds chats, Rome's speakers in them and the lines said there, as Chats and
// Agents store them, for tests that read those tables. Vocabulary:
// docs/domains/chats.md.

import { and, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { chatMessages, chats, romeSessions } from "../db/schema/system.js";
import type { ChatKind } from "../chats/storage/chat.js";
import type { ChatRef } from "../chats/storage/place.js";

type SessionRow = typeof romeSessions.$inferInsert;

export interface SeedSpeaker
  extends Partial<Omit<SessionRow, "chatId" | "threadId" | "accountId" | "id">> {
  id: string;
  chat: ChatRef;
  /** The one of Rome's accounts the speaker speaks as. */
  accountId: string;
  /** The topic the speaker stands in, when it stands in one. */
  threadId?: string | null;
}

export interface SeedLine {
  /** The line's key in its chat. */
  id: string;
  chat: ChatRef;
  threadId?: string | null;
  /** The account that said it. */
  from: string | null;
  /** The agent that said it, set on exactly Rome's lines. */
  agent?: string | null;
  name?: string | null;
  text?: string;
  parts?: unknown[];
  at: Date;
}

/** A fixture over `db` that seeds chats, speakers and lines directly. */
export function speakerFixture(db: DrizzleDb) {
  return {
    /** The chat keyed `key` on `platform`, started when absent. */
    chat(platform: string, key: string, kind: ChatKind, name: string | null = null): ChatRef {
      db.insert(chats)
        .values({ key, platform, kind, name, startedAt: new Date(0) })
        .onConflictDoNothing()
        .run();
      const row = db
        .select({ id: chats.id })
        .from(chats)
        .where(and(eq(chats.platform, platform), eq(chats.key, key)))
        .get();
      if (!row) throw new Error(`Chat ${platform}:${key} was not stored`);
      return { platform, id: row.id };
    },

    /** A speaker of Rome's account `accountId` in `chat`. */
    speaker({ id, chat, accountId, threadId = null, ...row }: SeedSpeaker): string {
      const at = row.createdAt ?? new Date(0);
      db.insert(romeSessions)
        .values({
          name: id,
          type: "channel",
          ...row,
          id,
          chatId: chat.id,
          chatPlatform: chat.platform,
          threadId,
          accountId,
          createdAt: at,
          activityAt: row.activityAt ?? at,
        })
        .run();
      return id;
    },

    /** A line said in `chat`, or in its topic `threadId`, by its id. */
    say(line: SeedLine): number {
      const text = line.text ?? line.id;
      const [row] = db
        .insert(chatMessages)
        .values({
          key: line.id,
          chatId: line.chat.id,
          threadId: line.threadId ?? null,
          senderAccountId: line.from,
          senderAgent: line.agent ?? null,
          senderName: line.name ?? null,
          text,
          parts: JSON.stringify(line.parts ?? [{ type: "text", content: text }]),
          saidAt: line.at,
        })
        .returning({ id: chatMessages.id })
        .all();
      if (!row) throw new Error(`Line ${line.id} was not stored`);
      return row.id;
    },
  };
}
