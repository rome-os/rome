import type { RESTOptions } from "discord.js";
import type { WebSocket } from "ws";
import { DiscordAdapter } from "../../../channels/discord.js";
import { exemplar, loadCapture } from "./capture.js";
import textCapture from "./captures/discord-text.capture.json" with { type: "json" };
import {
  MessageStore,
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
const DISCORD_USER = "100000000000000002";
export const DISCORD_DM = "100000000000000004";

const capture = loadCapture(textCapture);
const created = exemplar<WireMessage>(capture, "create");
const BOT = created.author;
const GUILD = String(
  exemplar<{ message_reference: { guild_id: string } }>(capture, "reply").message_reference
    .guild_id,
);
const API = "/api/v10";
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
    [DISCORD_CHANNEL, { id: DISCORD_CHANNEL, type: 0, guild_id: GUILD }],
    [DISCORD_DM, { id: DISCORD_DM, type: 1, recipients: [ALICE] }],
  ]);
  private readonly dmByRecipient = new Map([[DISCORD_USER, DISCORD_DM]]);
  private readonly sessions = new Set<WebSocket>();
  private nextId = BigInt(String(created.id));
  private sequence = 0;

  static async start(): Promise<DiscordPeer> {
    const peer = new DiscordPeer();
    await peer.server.start();
    return peer;
  }

  close(): Promise<void> {
    return this.server.close();
  }

  visible(channelId: string = DISCORD_DM): VisibleMessage[] {
    return this.store.visible(channelId);
  }

  /** REST options that send discord.js to this peer. */
  restOptions(): Partial<RESTOptions> {
    return {
      api: `${this.server.url}/api`,
      // Native fetch and discord.js's undici request share the contract it needs.
      makeRequest: this.server.fetch as unknown as RESTOptions["makeRequest"],
    };
  }

  createAdapter(): DiscordAdapter {
    return new DiscordAdapter({ botToken: DISCORD_TOKEN, rest: this.restOptions() });
  }

  /** A user's message, dispatched to every connected gateway session. */
  emitMessage(text: string, channelId = DISCORD_DM): VisibleMessage {
    if (!this.sessions.size) throw new Error("No discord.js gateway session is connected");
    const message = this.store.add({
      id: this.allocateId(),
      conversation: channelId,
      from: "user",
      text,
    });
    this.stamp(message.id);
    this.dispatch("MESSAGE_CREATE", this.wire(message));
    return message;
  }

  private gateway(socket: WebSocket, path: string) {
    if (path !== "/gateway") {
      this.server.errors.push(`Unmodeled gateway path ${path}`);
      socket.close(4000);
      return;
    }
    this.sessions.add(socket);
    socket.on("close", () => this.sessions.delete(socket));
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as { op: number; d: Record<string, unknown> };
      if (frame.op === 1) return socket.send(JSON.stringify({ op: 11, d: null }));
      if (frame.op === 3) return;
      if (frame.op === 2) {
        if (frame.d.token !== DISCORD_TOKEN) return socket.close(4004, "Authentication failed");
        return this.dispatch("READY", {
          v: 10,
          user: BOT,
          guilds: [],
          session_id: "fixture-session",
          resume_gateway_url: this.server.socketUrl("/gateway"),
          application: { id: BOT.id, flags: 0 },
        });
      }
      this.server.errors.push(`Unmodeled gateway opcode ${frame.op}`);
    });
  }

  private dispatch(type: string, data: unknown) {
    const frame = JSON.stringify({ op: 0, t: type, s: ++this.sequence, d: data });
    for (const session of this.sessions) session.send(frame);
  }

  private route({ method, path, headers, body }: PeerRequest): Reply | undefined {
    if (!path.startsWith(API)) return undefined;
    if (headers.get("authorization") !== `Bot ${DISCORD_TOKEN}`)
      throw new Error(`Discord request without the bot token: ${method} ${path}`);
    const route = `${method} ${path.slice(API.length)}`;

    if (route === "GET /gateway/bot")
      return synthetic({
        url: this.server.socketUrl("/gateway"),
        shards: 1,
        session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 },
      });
    if (route === "GET /users/@me") return synthetic(BOT);
    if (route === `PUT /applications/${BOT.id}/commands`) return synthetic(body);
    if (route === "POST /users/@me/channels") {
      // Strict: a DM with anyone else is unmodeled, so a wrong recipient fails.
      const channel = this.dmByRecipient.get(String(body.recipient_id));
      return channel ? synthetic(this.channels.get(channel)) : undefined;
    }

    const match = path.slice(API.length).match(/^\/channels\/(\d+)(\/messages(?:\/(\d+))?)?$/);
    if (!match) return undefined;
    const [, channelId, messages, messageId] = match;
    const channel = this.channels.get(channelId);
    if (!channel) return undefined;
    if (!messages) return method === "GET" ? synthetic(channel) : undefined;

    if (method === "POST" && !messageId) return this.create(channel, body);
    const message = messageId ? this.store.get(messageId) : undefined;
    if (!message || message.conversation !== channelId) {
      return method === "GET" || method === "PATCH"
        ? { status: 404, body: exemplar(capture, "get-missing"), source: "capture" }
        : undefined;
    }
    if (method === "GET") return { body: this.wire(message), source: "capture" };
    if (method === "PATCH") return this.edit(message, body);
    return undefined;
  }

  private create(channel: WireChannel, body: Record<string, unknown>): Reply {
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

  /** A stored message as Discord spells it, from the recorded messages. */
  private wire(message: VisibleMessage): WireMessage {
    const parent = message.replyTo ? this.store.get(message.replyTo) : undefined;
    const guild = this.channels.get(message.conversation)?.guild_id;
    return {
      ...structuredClone(created),
      id: message.id,
      channel_id: message.conversation,
      author: message.from === "rome" ? BOT : ALICE,
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
            referenced_message: this.wire(parent),
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
