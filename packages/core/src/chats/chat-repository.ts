// Chats by key, over today's channel rows. Vocabulary: docs/domains/chats.md#chat.
//
// A chat is stored as one `rome_sessions` channel row per one of Rome's
// accounts in it: the row of the channel that account speaks through, at the
// chat's platform id. A group two of Rome's accounts are in is two rows, read
// here as one chat and written to both. Only a row its channel marks as a group
// or a channel joins another account's: a direct message is named by both its
// ends, and a platform such as Telegram gives a direct message the other
// account's id whichever of Rome's accounts it writes to, so the same id on two
// channels is two direct messages.
//
// Rome's accounts in a chat are its rows, less those marked as left, which stay
// to keep what was said through them. The `participants` column holds everyone
// else. A thread's row, which names a parent row, is no chat of its own and is
// never read here.

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

/** A chat row's `participants`: the chat's participants other than Rome's
 *  own accounts, and whether the row's own account has left the chat. */
export interface StoredChatMembers {
  others: Account[];
  left?: true;
}

/** Row thread types that one group shared by several of Rome's accounts has. */
const SHARED_THREAD_TYPES: ReadonlySet<string> = new Set(["group", "channel"]);

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

  /**
   * The chat at `key`, or null when Rome holds none there. A direct message is
   * read as the one `through` writes to, and a key with direct messages on
   * several of Rome's accounts throws when `through` is absent.
   */
  byKey(key: ChatKey, through?: Account): Chat | null {
    const rows = present(this.rowsOf(this.db, key, through));
    return rows.length === 0 ? null : this.toChat(key, rows);
  }

  /**
   * The chat at `key`, started through `via` when Rome holds none there yet.
   * When a group exists and `via` is not in it, `via` joins it. `kind`, `name`
   * and `seed` apply only to a row this call writes. Refuses a `via` that is
   * none of Rome's accounts on the key's platform.
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
      const rows = this.rowsOf(tx, key, via);
      const live = present(rows);
      const own = rows.find((row) => row.sourceChannel === channel);
      if (own && live.includes(own)) return this.toChat(key, live);
      if (live.length === 0 && own === undefined) {
        const chat = Chat.start(key, kind, via, name);
        this.insertRow(tx, chat, channel, {
          threadType: kind === "dm" ? "private" : "group",
          ...seed,
        });
        return chat;
      }
      if (live.length === 0) {
        // Every one of Rome's accounts in it had left, so it starts again.
        this.markLeft(tx, own!, false);
        return this.toChat(key, [
          { ...own!, participants: members(own!.participants?.others ?? [], false) },
        ]);
      }
      const chat = this.toChat(key, live);
      chat.setParticipants([...chat.participants, { account: via, romes: true }]);
      this.save(tx, chat, rows, { ...seed, threadType: live[0]!.sourceThreadType });
      return chat;
    });
  }

  /**
   * Load the chat at `key`, apply `change` to it, and store the result, all in
   * one transaction. `through` names which of Rome's accounts a direct message
   * is read through, as for `byKey`. A refusal from `change` stores nothing.
   * Throws when Rome holds no chat at `key`. An ended chat's rows go, with
   * their threads and messages.
   */
  update(key: ChatKey, change: (chat: Chat) => void, through?: Account): Chat {
    return this.db.transaction((tx) => {
      const rows = this.rowsOf(tx, key, through);
      const live = present(rows);
      if (live.length === 0) throw new Error(`No chat at ${key.platform}:${key.id}`);
      const chat = this.toChat(key, live);
      change(chat);
      this.save(tx, chat, rows, { threadType: live[0]!.sourceThreadType });
      return chat;
    });
  }

  /** Store `chat` over `rows`, every row its key reads, left ones included.
   *  `seed` is what a row written for one of Rome's accounts with none holds. */
  private save(tx: DrizzleTx, chat: Chat, rows: Row[], seed: ChatRowSeed): void {
    if (chat.ended) {
      this.deleteRows(tx, rows);
      return;
    }
    const others = chat.participants.filter((p) => !p.romes).map((p) => p.account);
    const romes = chat.participants.filter((p) => p.romes).map((p) => p.account);
    for (const row of rows) {
      const inChat = romes.some((account) =>
        sameAccount(account, this.accountOn(row.sourceChannel!)),
      );
      tx.update(romeSessions)
        .set({
          ...(chat.name === null ? {} : { name: chat.name, sourceThreadName: chat.name }),
          channelSettings: chat.replyRule,
          participants: members(others, !inChat),
        })
        .where(eq(romeSessions.id, row.id))
        .run();
    }
    for (const account of romes) {
      const channel = this.channelOf(chat.key.platform, account);
      if (rows.some((row) => row.sourceChannel === channel)) continue;
      this.insertRow(tx, chat, channel, seed);
    }
  }

  private markLeft(tx: DrizzleTx, row: Row, left: boolean): void {
    tx.update(romeSessions)
      .set({ participants: members(row.participants?.others ?? [], left) })
      .where(eq(romeSessions.id, row.id))
      .run();
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
        participants: members(others, false),
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

  /** The chat `rows` store. Every row is one of Rome's accounts in it. */
  private toChat(key: ChatKey, rows: Row[]): Chat {
    const others = rows.flatMap((row) => row.participants?.others ?? []);
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

  /**
   * The rows of the chat at `key`, left ones included: every shared group row
   * there, or the one direct message row of the channel `through` speaks
   * through. Absent `through`, a key with one direct message row reads it.
   * The id is matched alone and the platform checked here, since a channel no
   * record holds still stores rows under its own name.
   */
  private rowsOf(exec: Exec, key: ChatKey, through?: Account): Row[] {
    const rows = exec
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
    const shared = rows.filter((row) => SHARED_THREAD_TYPES.has(row.sourceThreadType ?? ""));
    const direct = rows.filter((row) => !shared.includes(row));
    if (through !== undefined) {
      const channel = this.channelOrNull(key.platform, through);
      const own = direct.find((row) => row.sourceChannel === channel);
      return own ? [own] : shared;
    }
    if (direct.length === 0) return shared;
    if (direct.length === 1 && shared.length === 0) return direct;
    throw new Error(
      `${key.platform}:${key.id} names a chat on several of Rome's accounts; name the account`,
    );
  }

  /** The channel Rome's `account` on `platform` speaks through. */
  private channelOf(platform: string, account: Account): string {
    const channel = this.channelOrNull(platform, account);
    if (channel === null) {
      throw new ChatRefusal(`${account.platform}:${account.id} is none of Rome's accounts`);
    }
    return channel;
  }

  /** A recorded channel of `account`, or the unrecorded channel the account
   *  stands in for by name, or null for none. */
  private channelOrNull(platform: string, account: Account): string | null {
    const candidates = [...this.channels.namesOn(platform), account.id];
    return (
      candidates.find(
        (name) =>
          this.channels.platformOfChannel(name) === platform &&
          sameAccount(this.accountOn(name), account),
      ) ?? null
    );
  }
}

/** The rows whose account is still in the chat. */
function present(rows: Row[]): Row[] {
  return rows.filter((row) => !row.participants?.left);
}

function members(others: Account[], left: boolean): StoredChatMembers | null {
  if (others.length === 0 && !left) return null;
  return left ? { others, left: true } : { others };
}
