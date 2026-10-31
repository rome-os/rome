// Chats by key, over the `chats` table. Vocabulary: docs/domains/chats.md#chat.
//
// Which of Rome's accounts stand in a chat is their sessions in Agents, so
// nothing here reads or writes `rome_sessions`. Ending a chat removes its
// messages with it; the sessions that stood in it are Agents' to remove.

import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { ChatId } from "@rome-os/app-runtime";
import type { DrizzleDb } from "../db/index.js";
import { chats } from "../db/schema/system.js";
import type { Chat, ChatKind } from "./chat.js";
import { chatKey, type ChatKey } from "./place.js";

type Row = typeof chats.$inferSelect;

export class ChatRepository {
  constructor(private readonly db: DrizzleDb) {}

  /**
   * The chat at `key`, started with `kind` and `name` when Rome holds none
   * there yet. A chat already there is answered as it is: its kind never
   * changes, and its name changes only through {@link rename}. Safe to call
   * for every message.
   */
  start(key: ChatKey, kind: ChatKind, name: string | null): Chat {
    this.db
      .insert(chats)
      .values({
        id: randomUUID(),
        platform: key.platform,
        platformChatId: key.id,
        kind,
        name,
        startedAt: new Date(),
      })
      .onConflictDoNothing({ target: [chats.platform, chats.platformChatId] })
      .run();
    const chat = this.byKey(key);
    if (!chat) throw new Error(`Chat ${key.platform}:${key.id} was not stored`);
    return chat;
  }

  /** The chat at `key`, or null when Rome holds none there. A direct message
   *  is found by its key, which names both ends. */
  byKey(key: ChatKey): Chat | null {
    const row = this.db
      .select()
      .from(chats)
      .where(and(eq(chats.platform, key.platform), eq(chats.platformChatId, key.id)))
      .get();
    return row ? toChat(row) : null;
  }

  /** Every chat on `platform`, oldest first. */
  list(platform: string): Chat[] {
    return this.db
      .select()
      .from(chats)
      .where(eq(chats.platform, platform))
      .orderBy(asc(chats.startedAt), asc(chats.id))
      .all()
      .map(toChat);
  }

  /** Take `name` as the chat's name. Changes nothing when Rome holds no chat
   *  at `key`. */
  rename(key: ChatKey, name: string): void {
    this.db
      .update(chats)
      .set({ name })
      .where(and(eq(chats.platform, key.platform), eq(chats.platformChatId, key.id)))
      .run();
  }

  /** End the chat at `key`: it goes, with every message said in it. Changes
   *  nothing when Rome holds no chat there. */
  end(key: ChatKey): void {
    this.db
      .delete(chats)
      .where(and(eq(chats.platform, key.platform), eq(chats.platformChatId, key.id)))
      .run();
  }
}

function toChat(row: Row): Chat {
  return {
    id: row.id,
    key: chatKey(row.platform, row.platformChatId as ChatId),
    kind: row.kind === "group" ? "group" : "dm",
    name: row.name,
    startedAt: row.startedAt,
  };
}
