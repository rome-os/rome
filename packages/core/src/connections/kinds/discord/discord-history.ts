/**
 * A Discord chat's history read from Discord itself, through its REST API, so
 * it holds messages Rome never heard. A thread is a chat of its own on
 * Discord, read by its own id, and a message a thread was opened from names
 * that thread. A message read here is described as the same message heard
 * live is (`DiscordAdapter.dispatchMessage`), so a reader can tell the two
 * are one. Contract: `TalkHistory` (connections/types.ts).
 */

import type { ChannelMessage, ChatId } from "@rome-os/app-runtime";
import type { TalkHistoryRead } from "../../types.js";
import { discordAttachment } from "./discord-attachment.js";

/** The first millisecond of 2015, from which Discord's ids count time. */
const DISCORD_EPOCH = 1420070400000n;
/** The most messages Discord answers in one request. */
const PAGE = 100;
/** The most requests one read makes beyond the pages its limit needs, so a
 *  chat full of messages no read answers (joins, pins) cannot hold it. */
const SPARE_PAGES = 5;
/** What a Discord id looks like: a snowflake, digits only. */
const SNOWFLAKE = /^\d{1,20}$/;

/** Discord's channel types this read tells apart. */
const DM = 1;
const GROUP_DM = 3;
const THREADS = new Set([10, 11, 12]);
/** Message types a read answers: said by someone, or a thread opened. */
const DEFAULT = 0;
const THREAD_CREATED = 18;
const REPLY = 19;
const CHAT_INPUT_COMMAND = 20;
const CONTEXT_MENU_COMMAND = 23;
const READ_TYPES = new Set([
  DEFAULT,
  THREAD_CREATED,
  REPLY,
  CHAT_INPUT_COMMAND,
  CONTEXT_MENU_COMMAND,
]);
/** A message reference that forwards rather than replies. */
const FORWARD = 1;
/** The flag on a message a thread was opened from; the thread's id is the
 *  message's own. */
const HAS_THREAD = 1 << 5;

/** A Discord channel as its REST API spells it, in the fields read here. */
export interface WireChannel {
  id: string;
  type: number;
  name?: string | null;
  parent_id?: string | null;
  guild_id?: string;
  permission_overwrites?: Array<{ id: string; type: number; allow: string; deny: string }>;
}

/** A Discord message as its REST API spells it, in the fields read here. */
export interface WireMessage {
  id: string;
  type: number;
  channel_id: string;
  content: string;
  timestamp: string;
  author: { id: string; username: string; global_name?: string | null };
  member?: { nick?: string | null };
  attachments?: Array<{
    url: string;
    filename?: string;
    title?: string;
    content_type?: string;
  }>;
  message_reference?: { type?: number; message_id?: string; channel_id?: string };
  thread?: { id: string };
  flags?: number;
}

/** What a read needs of Discord: a GET of a REST route. It rejects as
 *  discord.js does, with the HTTP `status` and Discord's `code` on the error. */
export type DiscordGet = (route: `/${string}`, query?: URLSearchParams) => Promise<unknown>;

export interface DiscordHistoryDeps {
  get: DiscordGet;
  /** Rome's bot on this account, so what it said reads as outbound. */
  botId: string | null;
  /** A message's text as an inbound message carries it, the bot's mention
   *  stripped, in the guild the chat is in, if any. */
  textOf: (content: string, guildId?: string) => string;
  /** Whether the bot holds Read Message History in a guild chat, given the
   *  chat as Discord just answered it, or null where that cannot be told.
   *  Discord answers a bot without it an empty history, not a refusal, so a
   *  read asks first. */
  readsHistoryIn?: (chat: WireChannel) => Promise<boolean | null>;
  /** A guild member's nickname there, where known. Discord's REST history
   *  carries no member, which a message heard live does. */
  nicknameOf?: (guildId: string, userId: string) => string | undefined;
}

/** The lowest Discord id of a message said at `ms` or later. */
function idAt(ms: number): bigint {
  return (BigInt(ms) - DISCORD_EPOCH) << 22n;
}

/** The Discord error a refused request rejects with, as discord.js gives it. */
function refusal(err: unknown): { status?: number; code?: number } {
  if (typeof err !== "object" || err === null) return {};
  const { status, code } = err as { status?: unknown; code?: unknown };
  return {
    ...(typeof status === "number" ? { status } : {}),
    ...(typeof code === "number" ? { code } : {}),
  };
}

/** Discord's codes for a channel the bot cannot see or read. */
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;
const UNKNOWN_CHANNEL = 10003;

function mayNotRead(chatId: string): Error {
  return new Error(
    `This Discord account may not read chat ${chatId}: the bot needs View Channel and Read Message History there`,
  );
}

/** Why the account may not read `chatId`, from Discord's refusal, or null
 *  when the failure says nothing about access. */
function notReadable(chatId: string, err: unknown): Error | null {
  const { status, code } = refusal(err);
  if (status === 403 || code === MISSING_ACCESS || code === MISSING_PERMISSIONS) {
    return mayNotRead(chatId);
  }
  if (status === 404 || code === UNKNOWN_CHANNEL) {
    return new Error(`This Discord account sees no chat ${chatId}`);
  }
  return null;
}

async function asReadable<T>(chatId: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw notReadable(chatId, err) ?? err;
  }
}

/** The channel `chatId` names. A read takes a chat's own id only, never a
 *  user's: opening a DM to read it would be a write. */
async function channelOf(deps: DiscordHistoryDeps, chatId: string): Promise<WireChannel> {
  return asReadable(chatId, async () => (await deps.get(`/channels/${chatId}`)) as WireChannel);
}

/**
 * The messages of `chatId` within `read`'s bounds, newest first, at most
 * `read.limit`. Older than a message, or with no id bound, it reads back from
 * the upper bound. Newer than a message, it reads forward from it, so the page
 * is the messages right after it.
 */
export async function readDiscordHistory(
  deps: DiscordHistoryDeps,
  chatId: string,
  read: TalkHistoryRead,
): Promise<ChannelMessage[]> {
  for (const [field, id] of [
    ["chatId", chatId],
    ["olderThan", read.olderThan],
    ["newerThan", read.newerThan],
  ] as const) {
    if (id !== undefined && !SNOWFLAKE.test(id)) {
      throw new Error(`${field} "${id}" is no Discord id: a Discord id is digits only`);
    }
  }
  const channel = await channelOf(deps, chatId);
  const isDm = channel.type === DM || channel.type === GROUP_DM;
  if (!isDm && deps.readsHistoryIn) {
    const reads = await deps.readsHistoryIn(channel);
    // Discord answers no messages, not a refusal, where the bot may not read
    // the history, so a read that cannot tell does not guess.
    if (reads === false) throw mayNotRead(chatId);
    if (reads === null) {
      throw new Error(
        `Cannot tell yet whether this Discord account may read chat ${chatId}; try again shortly`,
      );
    }
  }
  // Bounds as Discord ids, both exclusive.
  const lowers = [
    read.newerThan === undefined ? null : BigInt(read.newerThan),
    read.since === undefined ? null : idAt(read.since.getTime()) - 1n,
  ].filter((bound) => bound !== null);
  const uppers = [
    read.olderThan === undefined ? null : BigInt(read.olderThan),
    read.until === undefined ? null : idAt(read.until.getTime() + 1),
  ].filter((bound) => bound !== null);
  const lower = lowers.length ? lowers.reduce((a, b) => (a > b ? a : b)) : null;
  const upper = uppers.length ? uppers.reduce((a, b) => (a < b ? a : b)) : null;
  const inside = (id: bigint) => (lower === null || id > lower) && (upper === null || id < upper);
  const forward = read.newerThan !== undefined;

  const found: WireMessage[] = [];
  let from: bigint | null = forward ? lower : upper;
  const pages = Math.ceil(read.limit / PAGE) + SPARE_PAGES;
  // Whether the read reached the end of the history or one of its bounds.
  let ended = false;
  for (let request = 0; found.length < read.limit && request < pages; request++) {
    // A whole page each time: messages no read answers are dropped after it.
    const query = new URLSearchParams({ limit: String(PAGE) });
    if (from !== null) query.set(forward ? "after" : "before", String(from));
    const page = (await asReadable(chatId, () =>
      deps.get(`/channels/${channel.id}/messages`, query),
    )) as WireMessage[];
    // Discord answers newest first; sorting here does not lean on it.
    const ordered = [...page].sort((a, b) => {
      const order = BigInt(a.id) < BigInt(b.id) ? -1 : 1;
      return forward ? order : -order;
    });
    const bounded = ordered.filter((message) => inside(BigInt(message.id)));
    found.push(...bounded.filter((message) => READ_TYPES.has(message.type)));
    const last = ordered.at(-1);
    if (!last || page.length < PAGE || bounded.length < ordered.length) {
      ended = true;
      break;
    }
    from = BigInt(last.id);
  }
  // A short page reads as the end of the history, so a read the page cap cut
  // short says where to read on rather than pass for one.
  if (!ended && found.length < read.limit) {
    const resume = `${forward ? "newerThan" : "olderThan"}=${from}`;
    const before = found.length
      ? ` The ${found.length} messages read before that point are read with limit ${found.length}.`
      : "";
    throw new Error(
      `Stopped after ${pages} pages of messages no read answers, such as joins and pins, in Discord chat ${chatId}. Read on with ${resume}.${before}`,
    );
  }
  const page = found.slice(0, read.limit);
  return (forward ? page.reverse() : page).map((message) =>
    toChannelMessage(deps, channel, message),
  );
}

function toChannelMessage(
  deps: Pick<DiscordHistoryDeps, "botId" | "textOf" | "nicknameOf">,
  channel: WireChannel,
  message: WireMessage,
): ChannelMessage {
  const isDm = channel.type === DM || channel.type === GROUP_DM;
  const parent = THREADS.has(channel.type) ? (channel.parent_id ?? null) : null;
  const reference = message.message_reference;
  const replyTo =
    message.type === REPLY && reference?.type !== FORWARD ? reference?.message_id : undefined;
  const openedThread =
    message.thread?.id ??
    (message.type === THREAD_CREATED ? reference?.channel_id : undefined) ??
    ((message.flags ?? 0) & HAS_THREAD ? message.id : undefined);
  return {
    channel: "discord",
    direction: message.author.id === deps.botId ? "outbound" : "inbound",
    messageId: message.id,
    chatId: message.channel_id as ChatId,
    ...(parent ? { parentChatId: parent as ChatId } : {}),
    senderId: message.author.id,
    senderDisplayName:
      message.member?.nick ??
      (channel.guild_id ? deps.nicknameOf?.(channel.guild_id, message.author.id) : undefined) ??
      message.author.global_name ??
      message.author.username,
    senderUsername: message.author.username,
    // A thread-created message's content is the thread's name, said by no one.
    text:
      message.type === THREAD_CREATED
        ? `started thread "${message.content}"`
        : deps.textOf(message.content, channel.guild_id),
    attachments: (message.attachments ?? []).map((attachment) =>
      discordAttachment({
        url: attachment.url,
        name: attachment.filename,
        title: attachment.title,
        contentType: attachment.content_type,
      }),
    ),
    timestamp: new Date(message.timestamp),
    ...(replyTo ? { replyTo: { messageId: replyTo } } : {}),
    thread: {
      kind: isDm ? "dm" : parent ? "topic" : "group",
      ...(!isDm && channel.name ? { name: channel.name } : {}),
    },
    ...(openedThread ? { openedThread: openedThread as ChatId } : {}),
    raw: message,
  };
}
