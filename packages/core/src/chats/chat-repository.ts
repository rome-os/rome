// Chats by key, over today's channel rows and no new storage. Vocabulary:
// docs/domains/chats.md#chat.
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
// Rome's accounts in a chat are its rows. Today's rows hold no one else, so a
// chat read here lists only Rome's accounts, and the other participants a
// change names are not kept. A thread's row, which names a parent row, is no
// chat of its own and is never read here.

import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { Account } from "@rome-os/app-runtime";
import type { DrizzleDb, DrizzleTx } from "../db/index.js";
import {
  romeAgentMessagePlatformIds,
  romeAgentMessages,
  romeAgentTraceBlocks,
  romeSessions,
  sessions,
} from "../db/schema/system.js";
import { channelChatId, isChannelConversation } from "../db/session-kind.js";
import { DEFAULT_WEBCHAT_PROJECT_NAME } from "../webchat/constants.js";
import { Chat, ChatRefusal, sameAccount, type ChatKind, type ReplyRule } from "./chat.js";
import type { ChatKey } from "./place.js";

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
   * several of Rome's accounts throws when `through` is absent. With
   * `joinUntyped`, the row of `through` stored with no type is read as one of
   * the group's rows, as it will be once its type is stored.
   */
  byKey(key: ChatKey, through?: Account, joinUntyped = false): Chat | null {
    const rows = this.rowsOf(this.db, key, through, joinUntyped);
    return rows.length === 0 ? null : this.toChat(key, rows);
  }

  /**
   * The chat at `key`, started through `via` when Rome holds none there yet.
   * When a group exists and `via` is not in it, `via` joins it, unless the row
   * `via` would write is a direct message or of no type, which starts a chat
   * of its own. `kind`, `name` and `seed` apply only to a row this call writes.
   * Refuses a `via` that is none of Rome's accounts on the key's platform.
   */
  startIfMissing(
    key: ChatKey,
    kind: ChatKind,
    via: Account,
    name: string | null,
    seed: ChatRowSeed = {},
  ): Chat {
    return this.write((tx) => {
      const channel = this.channelOf(key.platform, via);
      const rows = this.rowsOf(tx, key, via);
      if (rows.some((row) => row.sourceChannel === channel)) return this.toChat(key, rows);
      const threadType =
        "threadType" in seed ? (seed.threadType ?? null) : kind === "dm" ? "private" : "group";
      if (rows.length === 0 || !SHARED_THREAD_TYPES.has(threadType ?? "")) {
        const chat = Chat.start(key, kind, via, name);
        this.insertRow(tx, chat, channel, { ...seed, threadType });
        return chat;
      }
      const chat = this.toChat(key, rows);
      chat.setParticipants([...chat.participants, { account: via, romes: true }]);
      this.save(tx, chat, rows, { ...seed, threadType });
      return chat;
    });
  }

  /**
   * Load the chat at `key`, apply `change` to it, and store the result, all in
   * one transaction. `through` names which of Rome's accounts a direct message
   * is read through, as for `byKey`. A refusal from `change` stores nothing.
   * Throws when Rome holds no chat at `key`, and refuses a change today's rows
   * cannot hold: one of Rome's accounts leaving a chat that stays live, since
   * its row holds what was said through it. An ended chat's rows go, with
   * their threads and messages.
   */
  update(key: ChatKey, change: (chat: Chat) => void, through?: Account): Chat {
    return this.write((tx) => {
      const rows = this.rowsOf(tx, key, through);
      if (rows.length === 0) throw new Error(`No chat at ${key.platform}:${key.id}`);
      const chat = this.toChat(key, rows);
      change(chat);
      this.save(tx, chat, rows, { threadType: rows[0]!.sourceThreadType });
      return chat;
    });
  }

  /** Run `fn` in a transaction that takes the write lock before it reads.
   *  Rome's action workers write the same database on connections of their
   *  own, and a deferred transaction that reads first fails its first write
   *  once another connection has committed since that read. */
  private write<T>(fn: (tx: DrizzleTx) => T): T {
    return this.db.transaction(fn, { behavior: "immediate" });
  }

  /** Store `chat` over `rows`, every row its key reads. `seed` is what a row
   *  written for one of Rome's accounts with none holds. */
  private save(tx: DrizzleTx, chat: Chat, rows: Row[], seed: ChatRowSeed): void {
    if (chat.ended) {
      this.deleteRows(tx, rows);
      return;
    }
    const romes = chat.participants.filter((p) => p.romes).map((p) => p.account);
    const left = rows.filter(
      (row) => !romes.some((account) => sameAccount(account, this.accountOn(row.sourceChannel!))),
    );
    if (left.length > 0) {
      throw new ChatRefusal(
        `Rome's account on ${left[0]!.sourceChannel} cannot leave ${chat.key.platform}:${chat.key.id} while the chat goes on, until chats have storage of their own`,
      );
    }
    for (const row of rows) {
      tx.update(romeSessions)
        .set({
          ...(chat.name === null ? {} : { name: chat.name, sourceThreadName: chat.name }),
          channelSettings: withRoutingOf(row.channelSettings, chat.replyRule),
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

  private insertRow(tx: DrizzleTx, chat: Chat, channel: string, seed: ChatRowSeed): void {
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
        parentSessionId: null,
        createdAt: now,
        activityAt: now,
        lastSeenActivityAt: null,
      })
      .onConflictDoNothing({ target: romeSessions.id })
      .run();
  }

  /** Delete `rows`, the thread rows under them, and everything said in
   *  either, as deleting a dashboard chat does. The agent sessions that served
   *  them are completed, so a chat started again at the same address resumes
   *  none of the ended one's context. Live handles to those sessions are the
   *  caller's to close. */
  private deleteRows(tx: DrizzleTx, rows: Row[]): void {
    if (rows.length === 0) return;
    const chatIds = rows.map((row) => row.id);
    const all = [
      ...rows,
      ...tx.select().from(romeSessions).where(inArray(romeSessions.parentSessionId, chatIds)).all(),
    ];
    const ids = all.map((row) => row.id);
    const keys = all.flatMap((row) => {
      const key = `${row.sourceChannel}:${row.sourceThreadId}`;
      return [key, `sentinel:${key}`];
    });
    tx.update(sessions)
      .set({ status: "completed", lastActiveAt: new Date() })
      .where(
        and(
          eq(sessions.status, "active"),
          or(inArray(sessions.chatId, ids), inArray(sessions.channelThreadKey, keys)),
        ),
      )
      .run();
    tx.delete(romeAgentTraceBlocks).where(inArray(romeAgentTraceBlocks.sessionId, ids)).run();
    tx.delete(romeAgentMessages).where(inArray(romeAgentMessages.sessionId, ids)).run();
    tx.delete(romeAgentMessagePlatformIds)
      .where(inArray(romeAgentMessagePlatformIds.sessionId, ids))
      .run();
    tx.delete(romeSessions).where(inArray(romeSessions.id, ids)).run();
  }

  /** The chat `rows` store. Every row is one of Rome's accounts in it. */
  private toChat(key: ChatKey, rows: Row[]): Chat {
    const rule = rows
      .map((row) => row.channelSettings)
      .filter((settings): settings is ReplyRule => settings !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    // The newest row's routing marker is that row's, never the chat's.
    return Chat.restore({
      key,
      kind: rows.some((row) => row.sourceThreadType === "private") ? "dm" : "group",
      name: rows[0]!.sourceThreadName,
      participants: rows.map((row) => ({
        account: this.accountOn(row.sourceChannel!),
        romes: true,
      })),
      replyRule: rule === undefined ? null : withoutRouting(rule),
      ended: false,
    });
  }

  /**
   * The rows of the chat at `key`: every shared group row there, or the one
   * direct message row of the channel `through` speaks through. Absent
   * `through`, a key with one direct message row reads it. With `joinUntyped`,
   * the row of `through` stored with no type is read with the group's rows.
   */
  private rowsOf(exec: Exec, key: ChatKey, through?: Account, joinUntyped = false): Row[] {
    const rows = exec
      .select()
      .from(romeSessions)
      .where(
        and(
          isChannelConversation,
          inArray(romeSessions.sourceChannel, this.channelsOn(key.platform, through)),
          eq(romeSessions.sourceThreadId, key.id),
          isNull(romeSessions.parentSessionId),
        ),
      )
      .all();
    const shared = rows.filter((row) => SHARED_THREAD_TYPES.has(row.sourceThreadType ?? ""));
    const direct = rows.filter((row) => !shared.includes(row));
    if (through !== undefined) {
      const channel = this.channelOrNull(key.platform, through);
      const own = direct.find((row) => row.sourceChannel === channel);
      if (own && joinUntyped && own.sourceThreadType === null) return [...shared, own];
      return own ? [own] : shared;
    }
    if (direct.length === 0) return shared;
    if (direct.length === 1 && shared.length === 0) return direct;
    throw new Error(
      `${key.platform}:${key.id} names a chat on several of Rome's accounts; name the account`,
    );
  }

  /** Every channel a chat on `platform` may be stored under: the recorded
   *  ones, the one named after the platform, which rows stored before channels
   *  were recorded spell, and the unrecorded channel `through` stands in for. */
  private channelsOn(platform: string, through?: Account): string[] {
    const names = [...this.channels.namesOn(platform), platform];
    if (through !== undefined) names.push(through.id);
    return [...new Set(names)].filter((name) => this.channels.platformOfChannel(name) === platform);
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
    return (
      this.channelsOn(platform, account).find((name) =>
        sameAccount(this.accountOn(name), account),
      ) ?? null
    );
  }
}

/**
 * `rule` without its routing marker. A row's routing (`overrides.routing`)
 * pins the agent of the one of Rome's accounts the row is stored under, as the
 * row's `agent_name` does, so it is no part of the chat's rule.
 */
export function withoutRouting(rule: ReplyRule): ReplyRule {
  if (rule.overrides.routing === undefined) return rule;
  const { routing: _routing, ...overrides } = rule.overrides;
  return { ...rule, overrides };
}

/** `rule` with the routing marker of `stored`, the settings one row already
 *  holds, since that marker is its account's alone. */
export function withRoutingOf(stored: ReplyRule | null, rule: ReplyRule | null): ReplyRule | null {
  const routing = stored?.overrides.routing;
  if (routing === undefined) return rule;
  const base = rule ?? { ...stored!, overrides: {} };
  return { ...base, overrides: { ...base.overrides, routing } };
}
