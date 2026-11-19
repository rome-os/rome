/**
 * A Discord chat's history read from Discord itself, through its REST API, so
 * it holds messages Rome never heard. A thread is a chat of its own on
 * Discord, read by its own id, and a message a thread was opened from names
 * that thread. Contract: `TalkHistory` (connections/types.ts).
 */

import type { Attachment, ChannelMessage, ChatId } from "@rome-os/app-runtime";
import type { TalkHistoryRead } from "../../types.js";

/** The first millisecond of 2015, from which Discord's ids count time. */
const DISCORD_EPOCH = 1420070400000n;
/** The most messages Discord answers in one request. */
const PAGE = 100;

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
const READ_TYPES = new Set([DEFAULT, THREAD_CREATED, REPLY, CHAT_INPUT_COMMAND, CONTEXT_MENU_COMMAND]);
/** A message reference that forwards rather than replies. */
const FORWARD = 1;

/** A Discord channel as its REST API spells it, in the fields read here. */
export interface WireChannel {
  id: string;
  type: number;
  name?: string | null;
  parent_id?: string | null;
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
}

/** What a read needs of Discord: a GET of a REST route. It rejects as
 *  discord.js does, with the HTTP `status` and Discord's `code` on the error. */
export type DiscordGet = (route: `/${string}`, query?: URLSearchParams) => Promise<unknown>;

export interface DiscordHistoryDeps {
  get: DiscordGet;
  /** Rome's bot on this account, so what it said reads as outbound. */
  botId: string | null;
  /** A message's text as an inbound message carries it, the bot's mention
   *  stripped. */
  textOf: (content: string) => string;
  /** The DM channel with the user an id names, where a chat id is a user's,
   *  as a send takes it. Rejects when the id names no user. */
  directChannelFor?: (userId: string) => Promise<string>;
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

/** Why the account may not read `chatId`, from Discord's refusal, or null
 *  when the failure says nothing about access. */
function notReadable(chatId: string, err: unknown): Error | null {
  const { status, code } = refusal(err);
  if (status === 403 || code === MISSING_ACCESS || code === MISSING_PERMISSIONS) {
    return new Error(
      `This Discord account may not read chat ${chatId}: the bot needs View Channel and Read Message History there`,
    );
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

/** The channel `chatId` names: the chat itself, or the DM with the user it
 *  names, as a send takes it. */
async function channelOf(deps: DiscordHistoryDeps, chatId: string): Promise<WireChannel> {
  try {
    return (await deps.get(`/channels/${chatId}`)) as WireChannel;
  } catch (err) {
    if (refusal(err).status !== 404 || !deps.directChannelFor) throw notReadable(chatId, err) ?? err;
    const direct = await deps.directChannelFor(chatId).catch(() => null);
    if (!direct) throw notReadable(chatId, err) ?? err;
    return asReadable(chatId, async () => (await deps.get(`/channels/${direct}`)) as WireChannel);
  }
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
  const channel = await channelOf(deps, chatId);
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
  while (found.length < read.limit) {
    const asked = Math.min(PAGE, read.limit - found.length);
    const query = new URLSearchParams({ limit: String(asked) });
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
    if (!last || page.length < asked || bounded.length < ordered.length) break;
    from = BigInt(last.id);
  }
  const page = found.slice(0, read.limit);
  return (forward ? page.reverse() : page).map((message) =>
    toChannelMessage(deps, channel, message),
  );
}

function toChannelMessage(
  deps: Pick<DiscordHistoryDeps, "botId" | "textOf">,
  channel: WireChannel,
  message: WireMessage,
): ChannelMessage {
  const isDm = channel.type === DM || channel.type === GROUP_DM;
  const parent = THREADS.has(channel.type) ? (channel.parent_id ?? null) : null;
  const reference = message.message_reference;
  const replyTo =
    message.type === REPLY && reference?.type !== FORWARD ? reference?.message_id : undefined;
  const openedThread =
    message.thread?.id ?? (message.type === THREAD_CREATED ? reference?.channel_id : undefined);
  return {
    channel: "discord",
    direction: message.author.id === deps.botId ? "outbound" : "inbound",
    messageId: message.id,
    chatId: message.channel_id as ChatId,
    ...(parent ? { parentChatId: parent as ChatId } : {}),
    senderId: message.author.id,
    senderDisplayName: message.member?.nick ?? message.author.global_name ?? message.author.username,
    senderUsername: message.author.username,
    text: deps.textOf(message.content),
    attachments: (message.attachments ?? []).map(toAttachment),
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

function toAttachment(attachment: NonNullable<WireMessage["attachments"]>[number]): Attachment {
  const mimeType = attachment.content_type;
  const fileName = attachment.filename ?? attachment.title;
  const kind = mimeType?.split("/")[0];
  const type =
    kind === "image" || kind === "video" || kind === "audio" ? kind : ("document" as const);
  return {
    type,
    url: attachment.url,
    ...(mimeType ? { mimeType } : {}),
    ...(fileName ? { fileName } : {}),
  };
}
