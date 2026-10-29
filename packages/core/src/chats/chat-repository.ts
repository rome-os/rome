// Chats by key, over today's channel rows. Vocabulary: docs/domains/chats.md#chat.
//
// A chat is stored as one `rome_sessions` channel row per one of Rome's
// accounts in it: the row of the channel that account speaks through, at the
// chat's platform id. So a group two of Rome's accounts are in is two rows,
// read here as one chat and written to both. Rome's accounts in a chat are its
// rows, and the `participants` column holds everyone else. A thread's row,
// which names a parent row, is no chat of its own and is never read here.

import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Account } from "@rome-os/app-runtime";
import type { DrizzleDb, DrizzleTx } from "../db/index.js";
import {
  romeAgentMessagePlatformIds,
  romeAgentMessages,
  romeAgentTraceBlocks,
  romeSessions,
} from "../db/schema/system.js";
import { channelChatId, isChannelConversation } from "../db/session-kind.js";
import { DEFAULT_WEBCHAT_PROJECT_NAME } from "../webchat/constants.js";
import { Chat, ChatRefusal, sameAccount, type ChatKind, type ReplyRule } from "./chat.js";
import type { ChatKey } from "./place.js";

type Row = typeof romeSessions.$inferSelect;
type Exec = DrizzleDb | DrizzleTx;

/** What the repository asks about the channels of Rome's accounts. */
export interface ChatChannels {
  /** Every channel ever recorded on `platform`, released ones included. */
  namesOn(platform: string): string[];
  /** Rome's own account on channel `name`, or null while its record knows none. */
  accountOf(name: string): Account | null;
  platformOfChannel(name: string): string;
}

/**
 * What a new chat row holds beside the chat itself, until the storage moves:
 * the row's thread type as its channel spells it, the agent the row is bound
 * to, and the dashboard project its turns run in.
 */
export interface ChatRowSeed {
  threadType?: string | null;
  agentName?: string | null;
  projectName?: string;
  projectPath?: string | null;
}

export class ChatRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly channels: ChatChannels,
  ) {}

  /**
   * Rome's account that channel `name` speaks through. A channel whose record
   * names no account yet stands for one by its own name, the way rows stored
   * before accounts were recorded name it.
   */
  accountOn(name: string): Account {
    return (
      this.channels.accountOf(name) ?? {
        platform: this.channels.platformOfChannel(name),
        id: name,
      }
    );
  }

  /** The chat at `key`, or null when Rome holds none there. */
  byKey(key: ChatKey): Chat | null {
    const rows = this.rowsOf(this.db, key);
    return rows.length === 0 ? null : this.toChat(key, rows);
  }

  /**
   * The chat at `key`, started through `via` when Rome holds none there yet.
   * When the chat exists and `via` has no row in it, `via` joins it. `kind`,
   * `name` and `seed` apply only to a row this call writes. Refuses a `via`
   * that is none of Rome's accounts on the key's platform.
   */
  startIfMissing(
    key: ChatKey,
    kind: ChatKind,
    via: Account,
    name: string | null,
    seed: ChatRowSeed = {},
  ): Chat {
    return this.db.transaction((tx) => {
      const channel = this.channelOf(key.platform, via);
      const rows = this.rowsOf(tx, key);
      if (rows.some((row) => row.sourceChannel === channel)) return this.toChat(key, rows);
      const chat = rows.length === 0 ? Chat.start(key, kind, via, name) : this.toChat(key, rows);
      if (rows.length > 0) {
        chat.setParticipants([...chat.participants, { account: via, romes: true }]);
      }
      this.insertRow(tx, chat, channel, { threadType: kind === "dm" ? "private" : null, ...seed });
      return chat;
    });
  }

  /**
   * Load the chat at `key`, apply `change` to it, and store the result, all in
   * one transaction. A refusal from `change` stores nothing. Throws when Rome
   * holds no chat at `key`. An ended chat's rows go, with their threads and
   * messages.
   */
  update(key: ChatKey, change: (chat: Chat) => void): Chat {
    return this.db.transaction((tx) => {
      const rows = this.rowsOf(tx, key);
      if (rows.length === 0) throw new Error(`No chat at ${key.platform}:${key.id}`);
      const chat = this.toChat(key, rows);
      change(chat);
      this.save(tx, chat, rows);
      return chat;
    });
  }

  private save(tx: DrizzleTx, chat: Chat, rows: Row[]): void {
    if (chat.ended) {
      this.deleteRows(tx, rows);
      return;
    }
    const others = chat.participants.filter((p) => !p.romes).map((p) => p.account);
    const romes = chat.participants.filter((p) => p.romes).map((p) => p.account);
    const kept: Row[] = [];
    const left: Row[] = [];
    for (const row of rows) {
      (romes.some((account) => sameAccount(account, this.accountOn(row.sourceChannel!)))
        ? kept
        : left
      ).push(row);
    }
    // A row is one of Rome's accounts' copy of the chat, so an account that
    // left takes its copy with it and the rows of those still in it keep theirs.
    this.deleteRows(tx, left);
    for (const row of kept) {
      tx.update(romeSessions)
        .set({
          ...(chat.name === null ? {} : { name: chat.name, sourceThreadName: chat.name }),
          channelSettings: chat.replyRule,
          participants: others.length === 0 ? null : others,
        })
        .where(eq(romeSessions.id, row.id))
        .run();
    }
    for (const account of romes) {
      const channel = this.channelOf(chat.key.platform, account);
      if (kept.some((row) => row.sourceChannel === channel)) continue;
      this.insertRow(tx, chat, channel, {
        threadType: kept[0]?.sourceThreadType ?? (chat.kind === "dm" ? "private" : null),
      });
    }
  }

  private insertRow(tx: DrizzleTx, chat: Chat, channel: string, seed: ChatRowSeed): void {
    const others = chat.participants.filter((p) => !p.romes).map((p) => p.account);
    const now = new Date();
    tx.insert(romeSessions)
      .values({
        id: channelChatId(channel, chat.key.id),
        name: chat.name ?? `${channel}:${chat.key.id}`,
        personaId: null,
        projectName: seed.projectName ?? DEFAULT_WEBCHAT_PROJECT_NAME,
        projectPath: seed.projectPath ?? null,
        largeModelSelection: null,
        agentName: seed.agentName ?? null,
        type: "channel",
        sourceChannel: channel,
        sourceThreadId: chat.key.id,
        sourceThreadName: chat.name,
        sourceThreadType: seed.threadType ?? null,
        channelSettings: chat.replyRule,
        participants: others.length === 0 ? null : others,
        parentSessionId: null,
        createdAt: now,
        activityAt: now,
        lastSeenActivityAt: null,
      })
      .onConflictDoNothing({ target: romeSessions.id })
      .run();
  }

  /** Delete `rows`, the thread rows under them, and everything said in
   *  either, as deleting a dashboard chat does. */
  private deleteRows(tx: DrizzleTx, rows: Row[]): void {
    if (rows.length === 0) return;
    const chatIds = rows.map((row) => row.id);
    const ids = [
      ...chatIds,
      ...tx
        .select({ id: romeSessions.id })
        .from(romeSessions)
        .where(inArray(romeSessions.parentSessionId, chatIds))
        .all()
        .map((row) => row.id),
    ];
    tx.delete(romeAgentTraceBlocks).where(inArray(romeAgentTraceBlocks.sessionId, ids)).run();
    tx.delete(romeAgentMessages).where(inArray(romeAgentMessages.sessionId, ids)).run();
    tx.delete(romeAgentMessagePlatformIds)
      .where(inArray(romeAgentMessagePlatformIds.sessionId, ids))
      .run();
    tx.delete(romeSessions).where(inArray(romeSessions.id, ids)).run();
  }

  private toChat(key: ChatKey, rows: Row[]): Chat {
    const others = rows.flatMap((row) => row.participants ?? []);
    const rule = rows
      .map((row) => row.channelSettings)
      .filter((settings): settings is ReplyRule => settings !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return Chat.restore({
      key,
      kind: rows.some((row) => row.sourceThreadType === "private") ? "dm" : "group",
      name: rows[0]!.sourceThreadName,
      participants: [
        ...rows.map((row) => ({ account: this.accountOn(row.sourceChannel!), romes: true })),
        ...others.map((account) => ({ account, romes: false })),
      ],
      replyRule: rule ?? null,
      ended: false,
    });
  }

  // Matched on the platform id alone and filtered by platform here, since a
  // channel no record holds still stores rows under its own name.
  private rowsOf(exec: Exec, key: ChatKey): Row[] {
    return exec
      .select()
      .from(romeSessions)
      .where(
        and(
          isChannelConversation,
          eq(romeSessions.sourceThreadId, key.id),
          isNull(romeSessions.parentSessionId),
        ),
      )
      .all()
      .filter(
        (row) =>
          row.sourceChannel !== null &&
          this.channels.platformOfChannel(row.sourceChannel) === key.platform,
      );
  }

  /** The channel Rome's `account` on `platform` speaks through: a recorded
   *  one, or the unrecorded channel the account stands in for by name. */
  private channelOf(platform: string, account: Account): string {
    const candidates = [...this.channels.namesOn(platform), account.id];
    const channel = candidates.find(
      (name) =>
        this.channels.platformOfChannel(name) === platform &&
        sameAccount(this.accountOn(name), account),
    );
    if (channel === undefined) {
      throw new ChatRefusal(`${account.platform}:${account.id} is none of Rome's accounts`);
    }
    return channel;
  }
}
