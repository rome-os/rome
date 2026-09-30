import { Client, REST } from "discord.js";
import { DiscordAdapter } from "../../../channels/discord.js";
import { ImFixtureServer, sendJson, type FixtureRequest } from "./server.js";
import type { WebSocket } from "ws";

export const DISCORD_BOT = "100000000000000001";
export const DISCORD_USER = "100000000000000002";
export const DISCORD_DM = "100000000000000003";
export const DISCORD_TOKEN = "MTAwMDAwMDAwMDAwMDAwMDAx.fixture.fixture";

interface WireMessage {
  id: string;
  channel_id: string;
  author: { id: string; username: string; discriminator: string; bot: boolean; avatar: null };
  content: string;
  timestamp: string;
  edited_timestamp: string | null;
  attachments: unknown[];
  embeds: unknown[];
  components: unknown[];
  mentions: unknown[];
  mention_roles: string[];
  mention_everyone: boolean;
  pinned: boolean;
  tts: boolean;
  type: number;
  flags: number;
  message_reference?: { type: number; channel_id: string; message_id: string; guild_id?: string };
  referenced_message?: WireMessage;
}

function user(id: string, bot = false) {
  return { id, username: bot ? "Rome" : "Alice", discriminator: "0001", bot, avatar: null };
}

export class DiscordApiFixture {
  readonly server: ImFixtureServer = new ImFixtureServer((request) => this.route(request));
  readonly messages = new Map<string, WireMessage>();
  readonly channels = new Map<string, Record<string, unknown>>([
    [DISCORD_DM, { id: DISCORD_DM, type: 1, recipients: [user(DISCORD_USER)] }],
  ]);
  readonly gatewayFrames: Array<{ op: number; d: unknown }> = [];
  private sequence = 0;
  private nextId = 100000000000000100n;

  constructor() {
    this.server.ws.on("connection", (peer) => {
      sendJson(peer, { op: 10, d: { heartbeat_interval: 60_000 } });
      peer.on("message", (raw) => {
        try {
          const frame = JSON.parse(raw.toString());
          this.gatewayFrames.push(frame);
          if (frame.op === 1) return sendJson(peer, { op: 11, d: null });
          if (frame.op === 2) {
            if (frame.d.token !== DISCORD_TOKEN) return peer.close(4004, "Authentication failed");
            this.dispatch(peer, "READY", {
              v: 10,
              user: user(DISCORD_BOT, true),
              guilds: [],
              session_id: "fixture-session",
              resume_gateway_url: this.server.gatewayUrl,
              application: { id: DISCORD_BOT, flags: 0 },
              shard: [0, 1],
            });
            return;
          }
          if (frame.op === 6) return this.dispatch(peer, "RESUMED", {});
          if (frame.op === 3) return;
          this.server.errors.push(`Unmodeled Discord gateway opcode ${frame.op}`);
        } catch (error) {
          this.server.errors.push(String(error));
        }
      });
    });
  }

  async start() {
    await this.server.start();
    return this;
  }
  async close() {
    await this.server.close();
  }

  createAdapter(config: Partial<ConstructorParameters<typeof DiscordAdapter>[0]> = {}) {
    return new DiscordAdapter({ botToken: DISCORD_TOKEN, ...config }, this.transport());
  }

  transport(): NonNullable<ConstructorParameters<typeof DiscordAdapter>[1]> {
    const rest: NonNullable<ConstructorParameters<typeof REST>[0]> = {
      api: `${this.server.url}/api`,
      // Native fetch and discord.js's bundled undici use equivalent runtime contracts.
      makeRequest: this.server.fetch as unknown as NonNullable<
        NonNullable<ConstructorParameters<typeof REST>[0]>["makeRequest"]
      >,
      timeout: 2_000,
    };
    return {
      createClient: (options) => new Client({ ...options, rest: { ...options.rest, ...rest } }),
      createRest: (options) => new REST({ ...options, ...rest }),
    };
  }

  emitMessage(content: string, channelId = DISCORD_DM, id?: string) {
    if (!this.server.ws.clients.size) throw new Error("Discord gateway has no connected SDK");
    const message = this.message(channelId, content, false, id);
    this.messages.set(message.id, message);
    for (const peer of this.server.ws.clients) this.dispatch(peer, "MESSAGE_CREATE", message);
    return message;
  }

  disconnect() {
    for (const peer of this.server.ws.clients) peer.close(4000, "Fixture reconnect");
  }

  private dispatch(peer: WebSocket, type: string, data: unknown) {
    sendJson(peer, { op: 0, t: type, s: ++this.sequence, d: data });
  }

  private message(
    channelId: string,
    content: string,
    bot: boolean,
    id = String(this.nextId++),
  ): WireMessage {
    return {
      id,
      channel_id: channelId,
      author: user(bot ? DISCORD_BOT : DISCORD_USER, bot),
      content,
      timestamp: new Date().toISOString(),
      edited_timestamp: null,
      attachments: [],
      embeds: [],
      components: [],
      mentions: [],
      mention_roles: [],
      mention_everyone: false,
      pinned: false,
      tts: false,
      type: 0,
      flags: 0,
    };
  }

  private route(request: FixtureRequest) {
    const { method, path, body, headers } = request;
    if (headers.get("authorization") !== `Bot ${DISCORD_TOKEN}`)
      return { status: 401, body: { message: "401: Unauthorized", code: 0 } };
    if (method === "GET" && path === "/api/v10/gateway/bot")
      return {
        body: {
          url: this.server.gatewayUrl,
          shards: 1,
          session_start_limit: {
            total: 1000,
            remaining: 1000,
            reset_after: 86400000,
            max_concurrency: 1,
          },
        },
      };
    if (method === "GET" && path === "/api/v10/users/@me") return { body: user(DISCORD_BOT, true) };
    if (method === "PUT" && path === `/api/v10/applications/${DISCORD_BOT}/commands`)
      return { body: [] };
    if (method === "POST" && path === "/api/v10/users/@me/channels")
      return { body: this.channels.get(DISCORD_DM) };
    const channelMatch = path.match(/^\/api\/v10\/channels\/([^/]+)$/);
    if (channelMatch && method === "GET")
      return this.channels.has(channelMatch[1])
        ? { body: this.channels.get(channelMatch[1]) }
        : { status: 404, body: { code: 10003, message: "Unknown Channel" } };
    const match = path.match(/^\/api\/v10\/channels\/([^/]+)\/messages(?:\/([^/]+))?$/);
    if (!match) return undefined;
    const [, channelId, messageId] = match;
    if (!this.channels.has(channelId))
      return { status: 404, body: { code: 10003, message: "Unknown Channel" } };
    if (method === "GET") {
      if (!messageId)
        return { body: [...this.messages.values()].filter((m) => m.channel_id === channelId) };
      return this.messages.get(messageId)?.channel_id === channelId
        ? { body: this.messages.get(messageId) }
        : { status: 404, body: { code: 10008, message: "Unknown Message" } };
    }
    if (String(body.content ?? "").length > 2000)
      return { status: 400, body: { code: 50035, message: "Invalid Form Body" } };
    if (method === "POST" && !messageId) {
      const message = this.message(channelId, String(body.content ?? ""), true);
      if (body.message_reference) {
        const reference = body.message_reference as { message_id: string };
        const parent = this.messages.get(reference.message_id);
        if (!parent || parent.channel_id !== channelId)
          throw new Error("Unmodeled Discord reply target");
        const guildId = this.channels.get(channelId)?.guild_id;
        message.type = 19;
        message.message_reference = {
          type: 0,
          channel_id: channelId,
          message_id: parent.id,
          ...(typeof guildId === "string" ? { guild_id: guildId } : {}),
        };
        message.referenced_message = structuredClone(parent);
      }
      message.attachments = request.files.map((file, index) => ({
        id: String(index),
        filename: file.name,
        size: file.bytes.length,
        url: `${this.server.url}/attachments/${message.id}/${index}`,
      }));
      this.messages.set(message.id, message);
      return { body: message, accepted: true };
    }
    if (method === "PATCH" && messageId) {
      const message = this.messages.get(messageId);
      if (!message || message.channel_id !== channelId)
        return { status: 404, body: { code: 10008, message: "Unknown Message" } };
      message.content = String(body.content ?? "");
      message.edited_timestamp = new Date().toISOString();
      return { body: message, accepted: true };
    }
    return undefined;
  }
}
