// Chats by ref, over the `chats` table. Vocabulary: docs/domains/chats.md#chat.
//
// A chat's id is its adapter's and opaque here. Which of Rome's accounts stand
// in a chat is their sessions in Agents, so nothing here reads or writes
// `rome_sessions`. Ending a chat removes its messages with it; the sessions
// that stood in it are Agents' to remove.

import { asc, eq, sql, type SQL } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { chats } from "../db/schema/system.js";
import type { Chat, ChatKind } from "./chat.js";
import type { ChatRef } from "./place.js";

type Row = typeof chats.$inferSelect;

/** The ids of the chats on `platform`, as a subquery another read can test a
 *  chat id against (`chat_id IN …`), so it names no column of Chats'. */
export function chatIdsOn(platform: string): SQL {
  return sql`(SELECT ${chats.id} FROM ${chats} WHERE ${chats.platform} = ${platform})`;
}

export class ChatRepository {
  constructor(private readonly db: DrizzleDb) {}

  /**
   * The chat `ref` names, started with `kind` and `name` when Rome holds none
   * by that id yet. A chat already there is answered as it is: its kind never
   * changes, and its name changes only through {@link rename}. Safe to call
   * for every message.
   */
  start(ref: ChatRef, kind: ChatKind, name: string | null): Chat {
    this.db
      .insert(chats)
      .values({ id: ref.id, platform: ref.platform, kind, name, startedAt: new Date() })
      .onConflictDoNothing()
      .run();
    const chat = this.get(ref);
    if (!chat) throw new Error(`Chat ${ref.id} was not stored`);
    return chat;
  }

  /** The chat `ref` names, or null when Rome holds none by that id. */
  get(ref: ChatRef): Chat | null {
    const row = this.db.select().from(chats).where(eq(chats.id, ref.id)).get();
    return row && row.platform === ref.platform ? toChat(row) : null;
  }

  /** The chat Rome holds by id `id`, on whichever platform, or null. A chat's
   *  id is unique across platforms. */
  find(id: string): Chat | null {
    const row = this.db.select().from(chats).where(eq(chats.id, id)).get();
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
   *  by that id. */
  rename(ref: ChatRef, name: string): void {
    this.db.update(chats).set({ name }).where(eq(chats.id, ref.id)).run();
  }

  /** End the chat `ref` names: it goes, with every message said in it.
   *  Changes nothing when Rome holds no chat by that id. */
  end(ref: ChatRef): void {
    this.db.delete(chats).where(eq(chats.id, ref.id)).run();
  }
}

function toChat(row: Row): Chat {
  return {
    ref: { platform: row.platform, id: row.id },
    kind: row.kind === "group" ? "group" : "dm",
    name: row.name,
    startedAt: row.startedAt,
  };
}
