import type { RESTOptions } from "discord.js";
import type { WebSocket } from "ws";
import { DiscordAdapter } from "../../../channels/discord.js";
import { exemplar, loadCapture } from "./capture.js";
import textCapture from "./captures/discord-text.capture.json" with { type: "json" };
import {
  MessageStore,
  type MessageChange,
  PeerServer,
  type Peer,
  type PeerRequest,
  type Reply,
  type VisibleMessage,
} from "./peer.js";

export const DISCORD_TOKEN = "MTAwMDAwMDAwMDAwMDAwMDAx.fixture.fixture";
/** The guild text channel the capture was recorded in. */
const DISCORD_CHANNEL = "100000000000000003";
/** The one person the bot can open a DM with, and that DM. */
export const DISCORD_USER = "100000000000000002";
export const DISCORD_DM = "100000000000000004";
/** A thread a person started in the guild text channel, where the peer
 *  models the guild. */
export const DISCORD_THREAD = "100000000000000005";
export { DISCORD_CHANNEL };

const capture = loadCapture(textCapture);
const created = exemplar<WireMessage>(capture, "create");
const BOT = created.author;
/** A second bot, as a second of Rome's accounts in the guild. Synthetic. */
export const DISCORD_SECOND_BOT_ID = "100000000000000009";
export const DISCORD_SECOND_TOKEN = "MTAwMDAwMDAwMDAwMDAwMDA5.fixture.fixture";
const SECOND_BOT = { ...BOT, id: DISCORD_SECOND_BOT_ID, username: "Rome 2" };
/** Each bot the peer models, by its token. */
const BOTS = new Map<string, WireMessage["author"]>([
  [DISCORD_TOKEN, BOT],
  [DISCORD_SECOND_TOKEN, SECOND_BOT],
]);
const GUILD = String(
  exemplar<{ message_reference: { guild_id: string } }>(capture, "reply").message_reference
    .guild_id,
);
const API = "/api/v10";
/** The first second of 2015, from which Discord's ids count milliseconds. */
const DISCORD_EPOCH = 1420070400000n;
const TEXT_LIMIT = 2000;
const MESSAGE_TYPE_REPLY = 19;

interface WireMessage extends Record<string, unknown> {
  author: { id: string } & Record<string, unknown>;
}

interface WireChannel {
  id: string;
  type: number;
  guild_id?: string;
  recipients?: Array<Record<string, unknown>>;
  [field: string]: unknown;
}

const ALICE = { id: DISCORD_USER, username: "alice", discriminator: "0", avatar: null, bot: false };

/**
 * Discord's REST API and gateway behind a real discord.js client. Message
 * responses are built from ./captures/discord-text.capture.json; channel
 * lookups, DM creation, command registration and gateway frames are
 * synthetic.
 */
export class DiscordPeer implements Peer {
  readonly server = new PeerServer(
    (request) => this.route(request),
    (socket, path) => this.gateway(socket, path),
  );
  private readonly store = new MessageStore();
  private readonly timestamps = new Map<
    string,
    { timestamp: string; edited_timestamp: string | null }
  >();
  private readonly channels = new Map<string, WireChannel>([
    [
      DISCORD_CHANNEL,
      { id: DISCORD_CHANNEL, type: 0, guild_id: GUILD, name: "general", permission_overwrites: [] },
    ],
    [DISCORD_DM, { id: DISCORD_DM, type: 1, recipients: [ALICE] }],
  ]);
  private readonly dmByRecipient = new Map([[DISCORD_USER, DISCORD_DM]]);
  /** Each identified gateway session, and the bot it is. */
  private readonly sessions = new Map<WebSocket, WireMessage["author"]>();
  /** The bot that sent each of Rome's messages, where it was not the first. */
  private readonly authors = new Map<string, WireMessage["author"]>();
  private nextId = BigInt(String(created.id));
  private sequence = 0;

  /** With `guild`, the bot is in the guild, whose text channel has a thread
   *  a person started; the guild's gateway frame is synthetic. */
  static async start(options: { guild?: boolean } = {}): Promise<DiscordPeer> {
    const peer = new DiscordPeer(options.guild ?? false);
    await peer.server.start();
    return peer;
  }

  private constructor(private readonly inGuild: boolean) {
    if (inGuild)
      this.channels.set(DISCORD_THREAD, {
        id: DISCORD_THREAD,
        type: 11,
        guild_id: GUILD,
        parent_id: DISCORD_CHANNEL,
        name: "Plans",
        owner_id: DISCORD_USER,
        thread_metadata: {
          archived: false,
          auto_archive_duration: 1440,
          archive_timestamp: new Date().toISOString(),
          locked: false,
        },
      });
  }

  close(): Promise<void> {
    return this.server.close();
  }

  visible(channelId: string = DISCORD_DM): VisibleMessage[] {
    return this.store.visible(channelId);
  }

  changes(channelId: string = DISCORD_DM): MessageChange[] {
    return this.store.changes(channelId);
  }

  /** REST options that send discord.js to this peer. */
  restOptions(): Partial<RESTOptions> {
    return {
      api: `${this.server.url}/api`,
      // Native fetch and discord.js's undici request share the contract it needs.
      makeRequest: this.server.fetch as unknown as RESTOptions["makeRequest"],
    };
  }

  createAdapter(token = DISCORD_TOKEN): DiscordAdapter {
    return new DiscordAdapter({ botToken: token, rest: this.restOptions() });
  }

  /** A user's message, dispatched to every connected gateway session. In a
   *  guild channel it names the bot, as a guild message must to reach it. */
  emitMessage(
    text: string,
    channelId = DISCORD_DM,
    /** Whom a guild message names: the first bot, or every bot. */
    options: { mentionsEveryBot?: boolean } = {},
  ): VisibleMessage {
    if (!this.sessions.size) throw new Error("No discord.js gateway session is connected");
    // A person's message is said now, and Discord's id says when: discord.js
    // reads its time from the id, so it is minted from the clock.
    const message = this.store.add({
      id: String(((BigInt(Date.now()) - DISCORD_EPOCH) << 22n) | BigInt(this.sequence & 0xfff)),
      conversation: channelId,
      from: "user",
      text,
    });
    this.stamp(message.id);
    const wire = this.wire(message);
    const guild = this.channels.get(channelId)?.guild_id;
    const named = options.mentionsEveryBot ? [...BOTS.values()] : [BOT];
    // A DM is with the first bot alone; every bot is in the guild.
    this.dispatch(
      "MESSAGE_CREATE",
      guild
        ? {
            ...wire,
            guild_id: guild,
            content: `${named.map((bot) => `<@${bot.id}>`).join(" ")} ${text}`,
            mentions: named,
            member: memberOf(),
          }
        : wire,
      guild ? undefined : BOT,
    );
    return message;
  }

  private gateway(socket: WebSocket, path: string) {
    if (path !== "/gateway") {
      this.server.errors.push(`Unmodeled gateway path ${path}`);
      socket.close(4000);
      return;
    }
    socket.on("close", () => this.sessions.delete(socket));
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
    socket.on("message", (raw) => {
      let frame: { op: number; d: Record<string, unknown> };
      try {
        frame = JSON.parse(String(raw));
      } catch {
        this.server.errors.push(`Unmodeled gateway frame: ${String(raw).slice(0, 80)}`);
        return;
      }
      if (frame.op === 1) return socket.send(JSON.stringify({ op: 11, d: null }));
      if (frame.op === 3) return;
      if (frame.op === 2) {
        const bot = BOTS.get(String(frame.d.token));
        if (!bot) return socket.close(4004, "Authentication failed");
        this.sessions.set(socket, bot);
        this.dispatch(
          "READY",
          {
            v: 10,
            user: bot,
            guilds: this.inGuild ? [{ id: GUILD, unavailable: true }] : [],
            session_id: `fixture-session-${bot.id}`,
            resume_gateway_url: this.server.socketUrl("/gateway"),
            application: { id: bot.id, flags: 0 },
          },
          bot,
        );
        if (this.inGuild) this.dispatch("GUILD_CREATE", this.guild(), bot);
        return;
      }
      this.server.errors.push(`Unmodeled gateway opcode ${frame.op}`);
    });
  }

  /** The guild as its GUILD_CREATE frame spells it: its text channel, the
   *  thread in it, and the bot as a member. */
  private guild() {
    const now = new Date().toISOString();
    return {
      id: GUILD,
      name: "Fixture",
      unavailable: false,
      owner_id: DISCORD_USER,
      joined_at: now,
      large: false,
      member_count: 2,
      features: [],
      emojis: [],
      stickers: [],
      voice_states: [],
      presences: [],
      stage_instances: [],
      guild_scheduled_events: [],
      roles: [
        {
          id: GUILD,
          name: "@everyone",
          permissions: "1071698660929",
          position: 0,
          color: 0,
          hoist: false,
          managed: false,
          mentionable: false,
          flags: 0,
        },
      ],
      channels: [this.channels.get(DISCORD_CHANNEL)],
      threads: [this.channels.get(DISCORD_THREAD)],
      members: [...BOTS.values()].map((user) => ({
        user,
        roles: [],
        joined_at: now,
        deaf: false,
        mute: false,
        flags: 0,
      })),
    };
  }

  /** Send `data` to every session, or to bot `to`'s alone. */
  private dispatch(type: string, data: unknown, to?: WireMessage["author"]) {
    const frame = JSON.stringify({ op: 0, t: type, s: ++this.sequence, d: data });
    for (const [session, bot] of this.sessions) if (!to || bot.id === to.id) session.send(frame);
  }

  private route({ method, path, headers, body }: PeerRequest): Reply | undefined {
    if (!path.startsWith(API)) return undefined;
    const bot = BOTS.get((headers.get("authorization") ?? "").replace(/^Bot /, ""));
    if (!bot) throw new Error(`Discord request without a bot token: ${method} ${path}`);
    const route = `${method} ${path.slice(API.length)}`;

    if (route === "GET /gateway/bot")
      return synthetic({
        url: this.server.socketUrl("/gateway"),
        shards: 1,
        session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 },
      });
    if (route === "GET /users/@me") return synthetic(bot);
    if (route === `PUT /applications/${bot.id}/commands`) return synthetic(body);
    if (route === "POST /users/@me/channels") {
      // Strict: a DM with anyone else is unmodeled, so a wrong recipient fails.
      const channel = this.dmByRecipient.get(String(body.recipient_id));
      return channel ? synthetic(this.channels.get(channel)) : undefined;
    }

    const match = path.slice(API.length).match(/^\/channels\/(\d+)(\/messages(?:\/(\d+))?)?$/);
    if (!match) return undefined;
    const [, channelId, messages, messageId] = match;
    const channel = this.channels.get(channelId);
    // A user's id names no channel: Discord answers it as unknown, which is
    // how Rome tells a person's id from a channel's.
    if (!channel && method === "GET" && !messages && channelId === DISCORD_USER)
      return {
        status: 404,
        body: { code: 10003, message: "Unknown Channel" },
        source: "synthetic",
      };
    if (!channel) return undefined;
    if (!messages) return method === "GET" ? synthetic(channel) : undefined;

    if (method === "POST" && !messageId) return this.create(channel, body, bot);
    // Other requests on the whole collection are unmodeled.
    if (!messageId) return undefined;
    const message = this.store.get(messageId);
    if (!message || message.conversation !== channelId) {
      // Only a GET of a missing message is recorded; a PATCH reuses its body.
      if (method !== "GET" && method !== "PATCH") return undefined;
      const source = method === "GET" ? "capture" : "synthetic";
      return { status: 404, body: exemplar(capture, "get-missing"), source };
    }
    if (method === "GET") return { body: this.wire(message), source: "capture" };
    if (method === "PATCH") return this.edit(message, body);
    return undefined;
  }

  private create(
    channel: WireChannel,
    body: Record<string, unknown>,
    bot: WireMessage["author"] = BOT,
  ): Reply {
    const text = String(body.content ?? "");
    if (!text || text.length > TEXT_LIMIT) return invalidContent(text);
    const reference = (body.message_reference as { message_id?: string } | undefined)?.message_id;
    if (reference !== undefined && this.store.get(reference)?.conversation !== channel.id)
      return {
        status: 400,
        body: { code: 50035, message: "Invalid Form Body" },
        source: "synthetic",
      };
    const message = this.store.add({
      id: this.allocateId(),
      conversation: channel.id,
      from: "rome",
      text,
      ...(reference !== undefined ? { replyTo: reference } : {}),
    });
    this.stamp(message.id);
    if (bot.id !== BOT.id) this.authors.set(message.id, bot);
    return { body: this.wire(message), source: "capture", accepted: true };
  }

  private edit(message: VisibleMessage, body: Record<string, unknown>): Reply {
    if (message.from !== "rome")
      return {
        status: 403,
        body: { code: 50005, message: "Cannot edit a message authored by another user" },
        source: "synthetic",
      };
    const text = String(body.content ?? "");
    if (!text || text.length > TEXT_LIMIT) return invalidContent(text);
    this.store.edit(message.id, text);
    this.timestamps.get(message.id)!.edited_timestamp = new Date().toISOString();
    return { body: this.wire(message), source: "capture", accepted: true };
  }

  /** A stored message as Discord spells it, from the recorded messages. The
   *  message a reply points at carries no `referenced_message` of its own. */
  private wire(message: VisibleMessage, nested = false): WireMessage {
    const parent = message.replyTo ? this.store.get(message.replyTo) : undefined;
    const guild = this.channels.get(message.conversation)?.guild_id;
    return {
      ...structuredClone(created),
      id: message.id,
      channel_id: message.conversation,
      author: message.from === "rome" ? (this.authors.get(message.id) ?? BOT) : ALICE,
      content: message.text,
      ...this.timestamps.get(message.id),
      ...(parent
        ? {
            type: MESSAGE_TYPE_REPLY,
            message_reference: {
              type: 0,
              channel_id: message.conversation,
              message_id: parent.id,
              ...(guild ? { guild_id: guild } : {}),
            },
            ...(nested ? {} : { referenced_message: this.wire(parent, true) }),
          }
        : {}),
    };
  }

  private allocateId(): string {
    return String(this.nextId++);
  }

  private stamp(id: string) {
    this.timestamps.set(id, { timestamp: new Date().toISOString(), edited_timestamp: null });
  }
}

/** Alice as a member of the guild. */
function memberOf() {
  return { roles: [], joined_at: new Date().toISOString(), deaf: false, mute: false, flags: 0 };
}

function synthetic(body: unknown): Reply {
  return { body, source: "synthetic" };
}

// No capture covers a refused body yet. The codes are Discord's.
function invalidContent(text: string): Reply {
  if (!text)
    return {
      status: 400,
      body: { code: 50006, message: "Cannot send an empty message" },
      source: "synthetic",
    };
  return {
    status: 400,
    body: {
      code: 50035,
      message: "Invalid Form Body",
      errors: {
        content: {
          _errors: [{ code: "BASE_TYPE_MAX_LENGTH", message: "Must be 2000 or fewer in length." }],
        },
      },
    },
    source: "synthetic",
  };
}
