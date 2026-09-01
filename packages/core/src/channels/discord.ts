import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  MessageReferenceType,
  MessageType,
  AttachmentBuilder,
  REST,
  RESTEvents,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  type Message,
  type TextChannel,
  type DMChannel,
  type NewsChannel,
  type ThreadChannel,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
} from "discord.js";
import type { APIRequest, RateLimitData, RequestMethod, ResponseLike } from "discord.js";
import { isCoreMainAgentId } from "../apps/artifact-id.js";
import {
  filterChannelApiResponseHeaders,
  isProtectedChannelApiRequestHeader,
  type ChannelApiRequest,
  type ChannelApiResult,
} from "./api-request.js";
import type { ProviderAdapter } from "./adapter.js";
import type {
  ConversationDescriptor,
  ConversationId,
  ConversationSettingsControl,
  ConversationSettingsSnapshot,
} from "@rome-os/app-runtime";
import type {
  NormalizedMessage,
  Attachment,
  OutgoingMessage,
  OutgoingAttachment,
} from "./types.js";
import { createLogger } from "../logger.js";
import { saveUrlAttachments } from "./attachment-files.js";
import { createReadStream } from "node:fs";
import { basename, extname } from "node:path";
import {
  DISCORD_API_VERSION,
  DISCORD_BROKER_RESPONSE_LIMIT_BYTES,
  normalizeDiscordEndpoint,
} from "@rome/api-types/discord-broker";
import { preserveMentionOnlyText } from "./mention-only.js";

interface DiscordRestMessage {
  id: string;
  content: string;
  author: { id: string; username: string; global_name?: string | null; bot?: boolean };
  timestamp: string;
  attachments: { filename: string; title?: string; url: string; content_type?: string }[];
}

/**
 * The human-readable attachment name as the uploader saw it. Discord sanitizes
 * filenames that contain non-ASCII characters (e.g. "腾讯会议录制转写文件.txt"
 * becomes "580f8fdeeb994c86.txt") and preserves the original — minus extension —
 * in the `title` field. Reconstruct the display name from `title` + the cleaned
 * extension; fall back to `filename` when no title is present.
 */
function discordAttachmentName(filename: string, title?: string | null): string {
  if (!title) return filename;
  const ext = extname(filename);
  return ext && !title.toLowerCase().endsWith(ext.toLowerCase()) ? `${title}${ext}` : title;
}

interface DiscordRestChannel {
  id: string;
  name?: string;
  /** 0=GUILD_TEXT, 5=GUILD_ANNOUNCEMENT, 11=PUBLIC_THREAD, 12=PRIVATE_THREAD */
  type: number;
}

interface DiscordRestGuild {
  id: string;
  name: string;
}

const HISTORY_CHANNEL_TYPES = new Set([0, 5, 11, 12]);

function timestampToSnowflake(timestampMs: number): string {
  const discordEpoch = 1420070400000n;
  return ((BigInt(Math.floor(timestampMs)) - discordEpoch) << 22n).toString();
}

/** Strips the bot mention from prose while preserving a mention-only message. */
export function normalizeDiscordMessageText(
  content: string,
  bot: { id: string; displayName: string } | null,
  mentionedBot: boolean,
): string {
  const text = bot ? content.replace(new RegExp(`<@!?${bot.id}>`, "g"), "").trim() : content;
  return preserveMentionOnlyText(text, bot !== null && mentionedBot, bot?.displayName);
}

function restMessageToNormalized(
  msg: DiscordRestMessage,
  guildName: string,
  channelId: string,
  channelName: string,
): NormalizedMessage {
  const attachments: Attachment[] = msg.attachments.map((a) => {
    const mime = a.content_type;
    const fileName = discordAttachmentName(a.filename, a.title);
    if (mime?.startsWith("image/")) return { type: "image", url: a.url, fileName };
    if (mime?.startsWith("video/")) return { type: "video", url: a.url, mimeType: mime, fileName };
    if (mime?.startsWith("audio/")) return { type: "audio", url: a.url, mimeType: mime, fileName };
    return { type: "document", url: a.url, mimeType: mime ?? undefined, fileName };
  });

  return {
    id: msg.id,
    channel: "discord",
    channelUserId: msg.author.id,
    displayName: msg.author.global_name ?? msg.author.username,
    threadId: channelId,
    threadName: `${guildName}/#${channelName}`,
    threadType: "group",
    timestamp: new Date(msg.timestamp),
    text: msg.content,
    attachments,
    rawEvent: msg,
  };
}

const log = createLogger("discord");

type SendableChannel = TextChannel | DMChannel | NewsChannel | ThreadChannel;

interface DiscordChannelConfig {
  channelName?: string;
  mode?: "allow" | "ignore";
  requireMention?: boolean;
  allowBots?: "none" | "mentions" | "all";
  ignoreNoMention?: boolean;
  autoThread?: boolean;
  /**
   * Name of the agent to route messages from this channel to on the trusted
   * path. When unset (default), messages go to the main agent — the historical
   * behaviour. When set, the inbox message handler invokes the named agent
   * instead, falling back to "main" with a warning if the agent is no longer
   * loaded (e.g. its app was uninstalled). Untrusted messages still go through
   * sentinel regardless of this setting.
   */
  agentName?: string;
  updatedAt?: string;
  updatedBy?: string;
}

/**
 * Return the referenced message only for an actual Discord reply.
 *
 * `message.reference` is generic attribution also used by forwards, crossposts,
 * pins, and thread starter messages, so its presence alone does not mean the
 * user replied to another message.
 */
export function resolveDiscordReplyToMessageId(
  message: Pick<Message, "type" | "reference">,
): string | undefined {
  if (message.type !== MessageType.Reply) return undefined;
  if (message.reference?.type === MessageReferenceType.Forward) return undefined;
  return message.reference?.messageId;
}

function isThreadType(type: ChannelType): boolean {
  return (
    type === ChannelType.PublicThread ||
    type === ChannelType.PrivateThread ||
    type === ChannelType.AnnouncementThread
  );
}

function buildSlashCommands() {
  const channel = new SlashCommandBuilder()
    .setName("channel")
    .setDescription("Configure Rome Bot behavior for this channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addSubcommand((sub) =>
      sub.setName("ignore").setDescription("Permanently silence the bot in this channel"),
    )
    .addSubcommand((sub) =>
      sub.setName("allow").setDescription("Restore bot responses in this channel (clear ignore)"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("mention")
        .setDescription("Toggle @mention requirement")
        .addStringOption((opt) =>
          opt
            .setName("setting")
            .setDescription("on = require @mention (default), off = respond freely")
            .setRequired(true)
            .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" }),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("bots")
        .setDescription("Control how the bot handles messages from other bots")
        .addStringOption((opt) =>
          opt
            .setName("mode")
            .setDescription(
              "none = ignore bots, mentions = only if bot is @mentioned, all = always",
            )
            .setRequired(true)
            .addChoices(
              { name: "none", value: "none" },
              { name: "mentions", value: "mentions" },
              { name: "all", value: "all" },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("quiet")
        .setDescription("Toggle quiet mode: ignore messages that @mention others")
        .addStringOption((opt) =>
          opt
            .setName("setting")
            .setDescription(
              "on = stay silent when others are @mentioned (default), off = always respond",
            )
            .setRequired(true)
            .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" }),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("thread")
        .setDescription("Toggle auto-thread for bot replies")
        .addStringOption((opt) =>
          opt
            .setName("setting")
            .setDescription("on = reply in a thread (default), off = reply inline")
            .setRequired(true)
            .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" }),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("agent")
        .setDescription("Route this channel to a specific agent (default = main)")
        .addSubcommand((sub) =>
          sub
            .setName("set")
            .setDescription("Bind this channel to the named agent")
            .addStringOption((opt) =>
              opt
                .setName("name")
                .setDescription("Agent name (e.g. main, or an agent shipped by an installed app)")
                .setRequired(true)
                // Enables Discord's typeahead UI: as the guardian types, the
                // client calls our autocomplete handler (see the
                // `interactionCreate` listener) and renders the choices we
                // return. They can still hit Tab/Enter on a custom value if
                // they really want — the slash handler still validates the
                // final string against the catalog.
                .setAutocomplete(true),
            ),
        )
        .addSubcommand((sub) =>
          sub.setName("clear").setDescription("Stop routing to a custom agent — fall back to main"),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("reset").setDescription("Clear all overrides for this channel, restore defaults"),
    )
    .addSubcommand((sub) =>
      sub.setName("status").setDescription("Show current configuration for this channel"),
    );

  const bot = new SlashCommandBuilder()
    .setName("bot")
    .setDescription("Global Rome Bot status and management")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addSubcommand((sub) => sub.setName("status").setDescription("Show all channel overrides"));

  const help = new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show available Rome Bot commands");

  return [channel.toJSON(), bot.toJSON(), help.toJSON()];
}

/** A guild channel as surfaced to callers resolving a "#name" → snowflake. */
export interface GuildChannelInfo {
  id: string;
  name: string;
  guildId: string;
  guildName: string;
  type: "text" | "news" | "thread" | "forum";
  parentId?: string;
}

/**
 * Narrow structural view of {@link DiscordAdapter} for cross-module callers
 * (e.g. `worker-rpc.ts`) that hold a generic `ProviderAdapter` and need the
 * Discord-specific methods. Keeping the surface in one exported interface lets
 * TypeScript catch signature drift at those call sites instead of letting a
 * hand-written structural cast silently rot.
 */
export interface DiscordAdapterLike {
  listGuildChannels(): GuildChannelInfo[];
  executeApiRequest(request: ChannelApiRequest): Promise<ChannelApiResult>;
}

export class DiscordAdapter implements ProviderAdapter {
  readonly channelName = "discord";
  private client: Client;
  private handler?: (msg: NormalizedMessage) => Promise<void>;
  private conversationSettings?: ConversationSettingsControl & {
    observe?(descriptor: ConversationDescriptor): void;
  };
  private connectionId?: string;
  private slashCommandsRegistered = false;
  private maxMessagesPerChannel: number;
  /**
   * Returns the names of all agents currently loaded in the catalog. Used by
   * `/channel agent set <name>` to validate the guardian's input and reject
   * typos with a helpful list. Optional: when omitted, the validation step is
   * skipped (the message handler still falls back to main if the agent
   * disappears later).
   */
  private listAgents?: () => string[];
  private isGuardian?: (channelUserId: string) => Promise<boolean>;

  /**
   * Reports terminal gateway faults so the grant-epoch lifecycle can react:
   *   - `kind: "credential"` — the token was refused (login TokenInvalid /
   *     DisallowedIntents, or a live `invalidated` session revocation).
   *   - `kind: "transport"` — a terminal gateway/websocket error.
   * discord.js owns transient reconnection internally, so only terminal outcomes
   * reach this. When unset, the adapter only logs the fault.
   */
  private onGatewayFault?: (fault: { kind: "credential" | "transport"; cause: unknown }) => void;
  /** One rate-limit manager per Connection grant epoch. */
  private readonly rest: REST;
  /** Broker requests that must not survive this credential-owning epoch. */
  private readonly activeApiRequestControllers = new Set<AbortController>();

  constructor(config: {
    botToken: string;
    connectionId?: string;
    conversationSettings?: ConversationSettingsControl & {
      observe?(descriptor: ConversationDescriptor): void;
    };
    maxMessagesPerChannel?: number;
    listAgents?: () => string[];
    isGuardian?: (channelUserId: string) => Promise<boolean>;
    onGatewayFault?: (fault: { kind: "credential" | "transport"; cause: unknown }) => void;
  }) {
    this.connectionId = config.connectionId;
    this.conversationSettings = config.conversationSettings;
    this.maxMessagesPerChannel = config.maxMessagesPerChannel ?? 100;
    this.listAgents = config.listAgents;
    this.isGuardian = config.isGuardian;
    this.onGatewayFault = config.onGatewayFault;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
    this._botToken = config.botToken;
    this.rest = new REST({
      version: DISCORD_API_VERSION,
      userAgentAppendix: "Rome Discord broker/1",
    }).setToken(config.botToken);
  }

  private _botToken: string;

  /**
   * Enumerate text-capable channels across all guilds the bot is in, so an
   * caller (via Talk's `directory` feature) can resolve a
   * human-supplied channel name like "#pm-bot" to the snowflake ID that
   * channel-config writes require. Returns text/news channels and threads;
   * voice/category channels are filtered out. Quiet on uninitialized clients —
   * returns an empty array so the caller can surface a clean "no guilds" UX.
   */
  listGuildChannels(): GuildChannelInfo[] {
    if (!this.client.isReady()) return [];
    const out: GuildChannelInfo[] = [];
    for (const guild of this.client.guilds.cache.values()) {
      for (const channel of guild.channels.cache.values()) {
        let kind: "text" | "news" | "thread" | "forum" | null = null;
        if (channel.type === ChannelType.GuildText) kind = "text";
        else if (channel.type === ChannelType.GuildAnnouncement) kind = "news";
        else if (channel.type === ChannelType.GuildForum) kind = "forum";
        else if (isThreadType(channel.type)) kind = "thread";
        if (!kind) continue;
        out.push({
          id: channel.id,
          name: channel.name,
          guildId: guild.id,
          guildName: guild.name,
          type: kind,
          parentId:
            "parentId" in channel && typeof channel.parentId === "string"
              ? channel.parentId
              : undefined,
        });
      }
    }
    return out;
  }

  /** Execute a provider-relative request through the epoch-owned discord.js
   * REST manager. This boundary pins the path to Discord API v10, rejects
   * caller-owned auth headers, and returns only serializable safe response data. */
  async executeApiRequest(request: ChannelApiRequest): Promise<ChannelApiResult> {
    const path = normalizeDiscordEndpoint(request.path);
    for (const name of Object.keys(request.headers)) {
      if (isProtectedChannelApiRequestHeader(name)) {
        throw new Error(`header ${name} is owned by the channel provider`);
      }
    }
    const controller = new AbortController();
    let deadlineExceeded = false;
    let capturedResponse: ResponseLike | null = null;
    let rateLimit: RateLimitData | null = null;
    const routeData = (
      REST as unknown as {
        generateRouteData(endpoint: string, method: string): { bucketRoute: string };
      }
    ).generateRouteData(path, request.method);

    const onResponse = (apiRequest: APIRequest, response: ResponseLike): void => {
      if (apiRequest.data.signal === controller.signal) capturedResponse = response;
    };
    const onRateLimited = (data: RateLimitData): void => {
      if (data.method.toUpperCase() === request.method && data.route === routeData.bucketRoute) {
        rateLimit = data;
      }
    };
    this.rest.on(RESTEvents.Response, onResponse);
    this.rest.on(RESTEvents.RateLimited, onRateLimited);
    this.activeApiRequestControllers.add(controller);

    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error("Discord API request aborted")),
        { once: true },
      );
    });
    const timer = setTimeout(() => {
      deadlineExceeded = true;
      controller.abort();
    }, request.timeoutMs);
    timer.unref?.();
    try {
      const queuedRequest = this.rest.queueRequest({
        fullRoute: path as `/${string}`,
        method: request.method as RequestMethod,
        query: new URLSearchParams(request.query),
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
      // discord.js does not observe AbortSignal while sleeping for a known
      // bucket reset. Race its queued request against Core's authoritative
      // deadline, while observing the eventual rejection from the aborted
      // background request so it cannot become unhandled.
      void queuedRequest.catch(() => undefined);
      const response = await Promise.race([queuedRequest, aborted]);
      return await this.projectDiscordResponse(response);
    } catch {
      // A deadline or epoch teardown wins over any Response event emitted by an
      // intermediate discord.js attempt (for example, a 429 it plans to retry).
      if (controller.signal.aborted) {
        if (!deadlineExceeded) {
          return {
            error: {
              type: "network",
              message: "Discord connection changed before the request completed.",
            },
          };
        }
        const observedRateLimit = rateLimit as RateLimitData | null;
        if (observedRateLimit) {
          return {
            error: {
              type: "rate_limit",
              message: "Discord's rate-limit wait exceeded the request deadline.",
              retryAfterMs: Math.max(0, Math.ceil(observedRateLimit.retryAfter)),
            },
          };
        }
        return {
          error: {
            type: "timeout",
            message: "Discord request exceeded the request deadline.",
          },
        };
      }
      // discord.js parses and throws for non-2xx responses. Its Response event
      // gives us a clone first, preserving status, safe headers, and the raw
      // Discord error payload without serializing the thrown request object.
      if (capturedResponse) {
        const projected = await this.projectDiscordResponse(capturedResponse);
        if (projected.response?.status === 401) {
          this.onGatewayFault?.({
            kind: "credential",
            cause: new Error("Discord REST API rejected the bot credential"),
          });
        }
        return projected;
      }
      return {
        error: {
          type: "network",
          message: "Discord request failed before a response was received.",
        },
      };
    } finally {
      clearTimeout(timer);
      this.activeApiRequestControllers.delete(controller);
      controller.abort();
      this.rest.off(RESTEvents.Response, onResponse);
      this.rest.off(RESTEvents.RateLimited, onRateLimited);
    }
  }

  private async projectDiscordResponse(response: ResponseLike): Promise<ChannelApiResult> {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > DISCORD_BROKER_RESPONSE_LIMIT_BYTES) {
      return {
        error: {
          type: "response_too_large",
          message: "Discord response exceeded the 16 MiB broker limit.",
        },
      };
    }

    const text = new TextDecoder().decode(bytes);
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    return {
      response: {
        status: response.status,
        headers: filterChannelApiResponseHeaders(response.headers.entries()),
        body,
      },
    };
  }

  private descriptor(
    channelId: string,
    displayName?: string,
    parentId?: string | null,
    containerName?: string,
  ): ConversationDescriptor {
    if (!this.connectionId) throw new Error("Discord connection id is unavailable");
    const ref = { connectionId: this.connectionId, conversationId: channelId as ConversationId };
    return {
      ref,
      service: "discord",
      kind: parentId ? "topic" : "channel",
      displayName: displayName ?? channelId,
      containerName,
      ...(parentId
        ? {
            parent: {
              connectionId: this.connectionId,
              conversationId: parentId as ConversationId,
            },
          }
        : {}),
    };
  }

  private async settingsForMessage(message: Message): Promise<ConversationSettingsSnapshot | null> {
    if (!this.conversationSettings) return null;
    const parentId =
      message.channel && "isThread" in message.channel && message.channel.isThread()
        ? message.channel.parentId
        : null;
    const displayName = "name" in message.channel ? (message.channel.name ?? undefined) : undefined;
    const containerName = message.guild?.name;
    const descriptor = this.descriptor(message.channelId, displayName, parentId, containerName);
    this.conversationSettings.observe?.(descriptor);
    return this.conversationSettings.get(descriptor.ref);
  }

  private legacyConfig(snapshot: ConversationSettingsSnapshot | null): DiscordChannelConfig {
    if (!snapshot) return {};
    return {
      mode: snapshot.effective.enabled ? "allow" : "ignore",
      requireMention: snapshot.effective.activation.mode === "mention",
      allowBots:
        snapshot.effective.activation.botMessages === "ignore"
          ? "none"
          : snapshot.effective.activation.botMessages,
      ignoreNoMention: snapshot.effective.activation.whenOthersMentioned === "ignore",
      autoThread: snapshot.effective.replies.placement === "thread",
      agentName: snapshot.effective.routing.agentName ?? undefined,
      updatedAt: snapshot.updatedAt,
      updatedBy: snapshot.updatedBy?.displayName ?? snapshot.updatedBy?.id,
    };
  }

  async start(): Promise<void> {
    this.client.on("error", (err) => {
      log.error("discord client error", { error: err.message, stack: err.stack });
      // A live gateway error after login is a terminal transport failure — the
      // registry answers with backoff + rebuild, never a grant change.
      this.onGatewayFault?.({ kind: "transport", cause: err });
    });

    this.client.on("shardError", (err) => {
      log.error("discord shard error", { error: err.message, stack: err.stack });
      this.onGatewayFault?.({ kind: "transport", cause: err });
    });

    // `invalidated` fires when Discord revokes the session (e.g. the bot token
    // was reset in the Developer Portal) — a refused credential, not transport.
    this.client.on("invalidated", () => {
      log.warn("discord session invalidated (token revoked)");
      this.onGatewayFault?.({
        kind: "credential",
        cause: new Error("discord session invalidated"),
      });
    });

    this.client.on("warn", (info) => {
      log.warn("discord client warning", { info });
    });

    this.client.on("ready", async (client) => {
      log.info("discord client ready", {
        username: client.user.tag,
        guildCount: client.guilds.cache.size,
        guilds: client.guilds.cache.map((g) => g.name),
      });

      // Register slash commands globally.
      if (!this.slashCommandsRegistered) {
        this.slashCommandsRegistered = true;
        try {
          const commands = buildSlashCommands();
          await this.rest.put(Routes.applicationCommands(client.user.id), { body: commands });
          log.info("slash commands registered", { count: commands.length });
        } catch (err) {
          this.slashCommandsRegistered = false; // allow retry on next ready
          log.warn("failed to register slash commands", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });

    this.client.on("interactionCreate", async (interaction) => {
      if (interaction.isAutocomplete()) {
        await this.handleAutocomplete(interaction);
        return;
      }
      if (!interaction.isChatInputCommand()) return;
      await this.handleSlashCommand(interaction);
    });

    this.client.on("messageCreate", async (message: Message) => {
      if (!this.handler) return;

      // ── Layer 1: Hard filter ──────────────────────────────────────────────
      if (!message.author) return;
      if (message.system) return;
      // Self-messages: check after we know the client is ready
      if (this.client.user && message.author.id === this.client.user.id) return;

      const isDm =
        message.channel.type === ChannelType.DM || message.channel.type === ChannelType.GroupDM;

      const isThread = isThreadType(message.channel.type);

      const cfg = this.legacyConfig(await this.settingsForMessage(message));

      // ── Layer 2: Bot filter ───────────────────────────────────────────────
      if (message.author.bot) {
        const allowBots = cfg?.allowBots ?? "none";
        if (allowBots === "none") {
          log.debug("ignoring bot message (allowBots=none)", { from: message.author.id });
          return;
        }
        if (allowBots === "mentions") {
          const botId = this.client.user?.id;
          if (!botId || !message.mentions.users.has(botId)) {
            log.debug("ignoring bot message not mentioning us (allowBots=mentions)", {
              from: message.author.id,
            });
            return;
          }
        }
        // allowBots === "all" → fall through
      }

      // ── Layer 3: Intent recognition ───────────────────────────────────────
      const ignoreNoMention = cfg?.ignoreNoMention ?? true;
      if (!isDm && ignoreNoMention && message.mentions.users.size > 0) {
        const botId = this.client.user?.id;
        if (!botId || !message.mentions.users.has(botId)) {
          log.debug("ignoring message that @mentions others but not bot", {
            from: message.author.id,
            channelId: message.channelId,
          });
          return;
        }
      }

      // ── DM shortcut: always respond ───────────────────────────────────────
      if (isDm) {
        await this.dispatchMessage(message, isDm, isThread);
        return;
      }

      // ── Layer 4: Channel permission ───────────────────────────────────────
      if (cfg?.mode === "ignore") {
        log.debug("ignoring message in channel with mode=ignore", {
          channelId: message.channelId,
        });
        return;
      }

      // ── Layer 5: Mention check ────────────────────────────────────────────
      // Threads the bot itself started (e.g. auto-thread replies) are treated
      // as ongoing conversations and skip the mention requirement. Threads
      // created by other users still need an @mention or a reply-to-bot.
      const botId = this.client.user?.id;
      const isOwnThread =
        isThread &&
        !!botId &&
        "ownerId" in message.channel &&
        (message.channel as ThreadChannel).ownerId === botId;

      const requireMention = cfg?.requireMention ?? true;
      if (requireMention && !isOwnThread) {
        const botMentioned = botId ? message.mentions.users.has(botId) : false;

        let replyToBot = false;
        if (!botMentioned && message.reference?.messageId) {
          try {
            const refMsg = await message.channel.messages.fetch(message.reference.messageId);
            replyToBot = refMsg.author.id === botId;
          } catch {
            // can't fetch reference — skip
          }
        }

        if (!botMentioned && !replyToBot) {
          log.debug("ignoring guild message not directed at bot", {
            from: message.author.id,
            channelId: message.channelId,
            isThread,
          });
          return;
        }
      }

      await this.dispatchMessage(message, isDm, isThread);
    });

    await this.client.login(this._botToken);
    log.info("bot logged in", { username: this.client.user?.tag });
  }

  private async dispatchMessage(message: Message, isDm: boolean, isThread: boolean): Promise<void> {
    if (!this.handler) return;

    const bot = this.client.user;
    const text = normalizeDiscordMessageText(
      message.content,
      bot,
      bot ? message.mentions.users.has(bot.id) : false,
    );

    let threadName: string | undefined;
    if (!isDm && "name" in message.channel) {
      threadName = message.channel.name ?? undefined;
    }

    const parentId =
      isThread && message.channel.isThread() ? (message.channel.parentId ?? null) : null;
    const replyToMessageId = resolveDiscordReplyToMessageId(message);

    const msg: NormalizedMessage = {
      id: message.id,
      channel: "discord",
      channelUserId: message.author.id,
      displayName:
        message.member?.displayName ?? message.author.displayName ?? message.author.username,
      threadId: message.channelId,
      parentThreadId: parentId ?? undefined,
      threadName,
      threadType: isDm ? "private" : "group",
      timestamp: message.createdAt,
      text,
      attachments: this.extractAttachments(message),
      replyTo: replyToMessageId ? { messageId: replyToMessageId } : undefined,
      rawEvent: message,
    };

    log.info("message received", {
      from: msg.channelUserId,
      threadId: msg.threadId,
      threadType: msg.threadType,
      isDm,
      isThread,
    });

    try {
      await this.handler!(msg);
    } catch (err) {
      log.error("message handler error", {
        messageId: msg.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    try {
      if (this.isGuardian && !(await this.isGuardian(interaction.user.id))) {
        await interaction.editReply({
          content: "Only the linked guardian can configure this Discord conversation.",
        });
        return;
      }
      const cmd = interaction.commandName;
      const subGroup = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand(false);

      if (cmd === "help") {
        await interaction.editReply({
          content: [
            "**Rome Bot Commands**",
            "",
            "Channel configuration (run inside the target channel):",
            "  `/channel ignore` — silence the bot in this channel",
            "  `/channel allow` — restore bot responses (clear ignore)",
            "  `/channel mention off|on` — disable/enable @mention requirement",
            "  `/channel bots none|mentions|all` — how to handle messages from other bots",
            "  `/channel quiet on|off` — stay silent when others are @mentioned",
            "  `/channel thread off|on` — disable/enable auto-thread for replies",
            "  `/channel agent set <name>` — route this channel to a specific agent (default main)",
            "  `/channel agent clear` — clear the agent binding for this channel",
            "  `/channel reset` — clear all overrides for this channel",
            "  `/channel status` — show current channel configuration",
            "",
            "Global overview:",
            "  `/bot status` — list all channel overrides",
            "",
            "Tip: you can also tell the bot what you want in plain language",
          ].join("\n"),
        });
        return;
      }

      if (cmd === "bot" && sub === "status") {
        const entries =
          this.conversationSettings && this.connectionId
            ? (
                await this.conversationSettings.list({
                  connectionId: this.connectionId,
                  limit: 100,
                })
              ).items.filter((item) => Object.keys(item.snapshot.overrides).length > 0)
            : [];
        await interaction.editReply({
          content:
            entries.length === 0
              ? "**Rome Bot Status**\n\nAll conversations use defaults."
              : `**Rome Bot Status**\n\n${entries.length} conversation(s) have explicit overrides. Manage them in Settings → Channels.`,
        });
        return;
      }

      if (cmd === "channel") {
        const channelId = interaction.channelId;
        const parentId =
          interaction.channel && "isThread" in interaction.channel && interaction.channel.isThread()
            ? (interaction.channel.parentId ?? null)
            : null;
        const channelName =
          interaction.channel && "name" in interaction.channel
            ? (interaction.channel.name as string)
            : undefined;
        const mention = `${channelName ? `#${channelName}` : `<#${channelId}>`}`;

        if (sub === "status") {
          const snapshot = await this.getConversationSettings(
            channelId,
            channelName,
            parentId,
            interaction.guild?.name,
          );
          const cfg = this.legacyConfig(snapshot);
          const agentLine = `agent: ${cfg.agentName ?? "main"}${
            snapshot?.inheritedFrom ? " (inherited)" : ""
          }`;
          const lines = [
            `mode: ${cfg.mode}`,
            `requireMention: ${cfg.requireMention}`,
            `allowBots: ${cfg.allowBots}`,
            `ignoreNoMention: ${cfg.ignoreNoMention}`,
            `autoThread: ${cfg.autoThread}`,
            agentLine,
          ];
          const updatedInfo = cfg.updatedAt
            ? `\nLast updated: ${cfg.updatedAt.slice(0, 10)} by ${cfg.updatedBy ?? "unknown"}`
            : "";
          await interaction.editReply({
            content: `**${mention} configuration**\n\n${lines.join("\n")}${updatedInfo}`,
          });
          return;
        }

        if (parentId) {
          await interaction.editReply({
            content: `This thread follows the settings for parent <#${parentId}>. Run the command in the parent channel to change them.`,
          });
          return;
        }

        if (sub === "reset") {
          await this.updateChannelConfig(
            channelId,
            null,
            channelName,
            parentId,
            interaction.guild?.name,
          );
          await interaction.editReply({
            content: `✓ ${mention} configuration cleared\nRestored all defaults (require @mention, ignore other bots, auto-thread on)`,
          });
          return;
        }

        const now = new Date().toISOString();
        const audit = { channelName, updatedAt: now, updatedBy: "slash" };

        if (sub === "ignore") {
          await this.updateChannelConfig(channelId, { mode: "ignore", ...audit });
          await interaction.editReply({
            content: `✓ ${mention} is now ignored\nThe bot will not respond here, even if @mentioned\nUse \`/channel allow\` to undo`,
          });
          return;
        }

        if (sub === "allow") {
          // Clear mode; if nothing meaningful remains the record is auto-deleted
          await this.updateChannelConfig(channelId, { mode: undefined, ...audit });
          await interaction.editReply({
            content: `✓ ${mention} ignore cleared — bot will respond again`,
          });
          return;
        }

        if (sub === "mention") {
          const setting = interaction.options.getString("setting", true);
          // "on" restores default → remove the override
          await this.updateChannelConfig(channelId, {
            requireMention: setting === "off" ? false : undefined,
            ...audit,
          });
          const msg =
            setting === "off"
              ? `✓ ${mention} @mention requirement disabled\nThe bot will respond to all messages here\n⚠ Use with caution in high-traffic channels`
              : `✓ ${mention} @mention requirement enabled (default restored)`;
          await interaction.editReply({ content: msg });
          return;
        }

        if (sub === "bots") {
          const mode = interaction.options.getString("mode", true) as "none" | "mentions" | "all";
          // "none" is the default → remove the override
          await this.updateChannelConfig(channelId, {
            allowBots: mode === "none" ? undefined : mode,
            ...audit,
          });
          await interaction.editReply({
            content: `✓ ${mention} bot filter set to "${mode}"`,
          });
          return;
        }

        if (sub === "quiet") {
          const setting = interaction.options.getString("setting", true);
          // "on" is the default → remove the override
          await this.updateChannelConfig(channelId, {
            ignoreNoMention: setting === "off" ? false : undefined,
            ...audit,
          });
          const msg =
            setting === "off"
              ? `✓ ${mention} quiet mode disabled\nThe bot will respond even when others are @mentioned\n⚠ Not recommended in multi-user channels`
              : `✓ ${mention} quiet mode enabled (stays silent when others are @mentioned)`;
          await interaction.editReply({ content: msg });
          return;
        }

        if (sub === "thread") {
          const setting = interaction.options.getString("setting", true);
          // "on" is the default → remove the override
          await this.updateChannelConfig(channelId, {
            autoThread: setting === "off" ? false : undefined,
            ...audit,
          });
          const msg =
            setting === "off"
              ? `✓ ${mention} auto-thread disabled\nThe bot will reply directly in the channel`
              : `✓ ${mention} auto-thread enabled (default restored)`;
          await interaction.editReply({ content: msg });
          return;
        }

        if (subGroup === "agent") {
          if (sub === "clear") {
            await this.updateChannelConfig(channelId, { agentName: undefined, ...audit });
            await interaction.editReply({
              content: `✓ ${mention} agent binding removed — messages now route to main`,
            });
            return;
          }

          if (sub === "set") {
            const name = interaction.options.getString("name", true).trim();
            if (!name) {
              await interaction.editReply({
                content: `Agent name is required. Try \`/channel agent clear\` to remove the binding.`,
              });
              return;
            }
            // "main" is the default — treat `set main` as a clear so we don't
            // store a redundant named binding.
            if (isCoreMainAgentId(name)) {
              await this.updateChannelConfig(channelId, { agentName: undefined, ...audit });
              await interaction.editReply({
                content: `✓ ${mention} binding removed — messages now route to main`,
              });
              return;
            }
            const available = this.listAgents?.();
            if (available && !available.includes(name)) {
              const sample = available.slice(0, 20).sort().join(", ");
              await interaction.editReply({
                content:
                  `✗ Agent \`${name}\` is not loaded.\n` +
                  `Available agents: ${sample || "(none)"}`,
              });
              return;
            }
            await this.updateChannelConfig(channelId, { agentName: name, ...audit });
            await interaction.editReply({
              content:
                `✓ ${mention} now routes to agent \`${name}\`\n` +
                `Use \`/channel agent clear\` to undo.`,
            });
            return;
          }
        }
      }

      await interaction.editReply({ content: "Unknown command" });
    } catch (err) {
      log.error("slash command error", {
        command: interaction.commandName,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        await interaction.editReply({
          content: "An error occurred while executing the command, please try again",
        });
      } catch {
        // ignore follow-up error
      }
    }
  }

  /**
   * Discord typeahead for slash-command string options that have
   * `.setAutocomplete(true)`. Currently only `/channel agent set <name>` opts
   * in: as the guardian types, we return the catalog of loaded agent names
   * filtered by what's already in the input. Returning the full list when the
   * input is empty doubles as a discovery affordance.
   *
   * Failures (Discord ack timeout, listAgents throwing) are swallowed — the
   * worst case is the user sees no suggestions and falls back to typing the
   * name themselves, which the slash handler still validates.
   */
  private async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    try {
      if (interaction.commandName !== "channel") return;
      const subGroup = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand(false);
      const focused = interaction.options.getFocused(true);
      if (subGroup !== "agent" || sub !== "set" || focused.name !== "name") return;

      const all = this.listAgents?.() ?? [];
      // Hide "main" from typeahead — it's the default; if the guardian wants
      // to clear the binding they have `/channel agent clear` for that.
      const candidates = all.filter((name) => !isCoreMainAgentId(name));

      const query = focused.value?.toString().toLowerCase() ?? "";
      const matches = (
        query ? candidates.filter((name) => name.toLowerCase().includes(query)) : candidates
      ).slice(0, 25); // Discord caps autocomplete responses at 25 choices.

      await interaction.respond(matches.map((name) => ({ name, value: name })));
    } catch (err) {
      log.warn("autocomplete handler failed", {
        command: interaction.commandName,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        await interaction.respond([]);
      } catch {
        // ignore — interaction may already be acknowledged/expired
      }
    }
  }

  /**
   * Merge a patch into the channel's DB-fresh config and write back.
   * - null → delete the channel's config entirely (used by /channel reset)
   * - patch → merged with the current DB state; undefined values remove the key;
   *   if no real config keys remain after merge the record is auto-deleted
   */
  private async updateChannelConfig(
    channelId: string,
    patch: Partial<DiscordChannelConfig> | null,
    channelName?: string,
    parentId?: string | null,
    containerName?: string,
  ): Promise<void> {
    if (!this.conversationSettings) return;
    const snapshot = await this.getConversationSettings(
      channelId,
      channelName,
      parentId,
      containerName,
    );
    if (!snapshot) return;
    if (patch === null) {
      await this.conversationSettings.reset({
        ref: snapshot.conversation.ref,
        actor: { kind: "guardian", id: "discord-slash" },
      });
      return;
    }

    const set: import("@rome-os/app-runtime").PartialConversationSettings = {};
    const clear: import("@rome-os/app-runtime").ConversationSettingField[] = [];
    const owns = (key: keyof DiscordChannelConfig) => Object.hasOwn(patch, key);
    if (owns("mode")) {
      if (patch.mode === "ignore") set.enabled = false;
      else clear.push("enabled");
    }
    if (owns("requireMention")) {
      if (patch.requireMention === false) (set.activation ??= {}).mode = "all";
      else clear.push("activation.mode");
    }
    if (owns("allowBots")) {
      if (patch.allowBots && patch.allowBots !== "none") {
        (set.activation ??= {}).botMessages = patch.allowBots;
      } else clear.push("activation.botMessages");
    }
    if (owns("ignoreNoMention")) {
      if (patch.ignoreNoMention === false) {
        (set.activation ??= {}).whenOthersMentioned = "respond";
      } else clear.push("activation.whenOthersMentioned");
    }
    if (owns("autoThread")) {
      if (patch.autoThread === false) (set.replies ??= {}).placement = "inline";
      else clear.push("replies.placement");
    }
    if (owns("agentName")) {
      if (patch.agentName) (set.routing ??= {}).agentName = patch.agentName;
      else clear.push("routing.agentName");
    }
    await this.conversationSettings.update({
      ref: snapshot.conversation.ref,
      set,
      clear,
      actor: { kind: "guardian", id: "discord-slash" },
    });
  }

  private async getConversationSettings(
    channelId: string,
    channelName?: string,
    parentId?: string | null,
    containerName?: string,
  ): Promise<ConversationSettingsSnapshot | null> {
    if (!this.conversationSettings) return null;
    if (!channelName || parentId === undefined || !containerName) {
      const channel = await this.client.channels.fetch(channelId).catch(() => null);
      if (channel) {
        if (!channelName && "name" in channel) channelName = channel.name ?? undefined;
        if (parentId === undefined) parentId = channel.isThread() ? channel.parentId : null;
        if (!containerName && "guild" in channel) containerName = channel.guild?.name;
      }
    }
    const descriptor = this.descriptor(channelId, channelName, parentId, containerName);
    this.conversationSettings.observe?.(descriptor);
    return this.conversationSettings.get(descriptor.ref);
  }

  async stop(): Promise<void> {
    // Epoch teardown must synchronously invalidate work still queued behind a
    // rate-limit bucket; otherwise it could later dispatch with this manager's
    // retained, now-stale credential.
    for (const controller of this.activeApiRequestControllers) controller.abort();
    this.activeApiRequestControllers.clear();
    this.rest.clearHashSweeper();
    this.rest.clearHandlerSweeper();
    await this.client.destroy();
    log.info("bot stopped");
  }

  async sendMessage(_channelUserId: string, threadId: string, message: OutgoingMessage) {
    const channel = await this.client.channels.fetch(threadId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Channel ${threadId} is not a text channel`);
    }

    const snapshot = await this.getConversationSettings(
      threadId,
      "name" in channel ? (channel.name ?? undefined) : undefined,
      channel.isThread() ? channel.parentId : null,
      "guild" in channel ? channel.guild?.name : undefined,
    );
    const autoThread = snapshot?.effective.replies.placement !== "inline";

    // For regular guild text channels, reply inside a thread to avoid flooding the channel
    let targetChannel: SendableChannel;
    if (message.replyToMessageId && channel.type === ChannelType.GuildText && autoThread) {
      const textChannel = channel as TextChannel;
      targetChannel = await this.getOrCreateThread(textChannel, message.replyToMessageId);
    } else {
      targetChannel = channel as SendableChannel;
    }

    try {
      let messageId: string | undefined;
      if (message.text) {
        // Discord natively supports markdown; send as-is
        // Discord has a 2000 character limit per message
        const chunks = splitMessage(message.text);
        for (const chunk of chunks) {
          const sent = await targetChannel.send({ content: chunk });
          messageId ??= sent.id;
        }
      }

      for (const att of message.attachments ?? []) {
        const attachmentMessageId = await this.sendAttachment(targetChannel, att);
        messageId ??= attachmentMessageId;
      }

      log.info("message sent", { threadId, targetChannelId: targetChannel.id });
      return { messageId, threadId: targetChannel.id };
    } catch (err) {
      log.error("failed to send message", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /** Keeps bot replies out of the main channel by threading them. */
  private async getOrCreateThread(channel: TextChannel, messageId: string): Promise<ThreadChannel> {
    const msg = await channel.messages.fetch(messageId);

    if (msg.thread) {
      // Unarchive if needed so we can post
      if (msg.thread.archived) {
        await msg.thread.setArchived(false);
      }
      return msg.thread;
    }

    // Thread name is the first line of the message (Discord caps it at 100
    // chars), with the bot @mention stripped so the title reads cleanly.
    let content = msg.content;
    if (this.client.user) {
      content = content.replace(new RegExp(`<@!?${this.client.user.id}>`, "g"), "").trim();
    }
    const firstLine = content.split("\n")[0].trim().slice(0, 100) || "Chat";
    const thread = await msg.startThread({
      name: firstLine,
      autoArchiveDuration: 1440, // auto-archive after 24h of inactivity
    });
    log.info("created thread for reply", {
      parentChannelId: channel.id,
      threadId: thread.id,
      name: firstLine,
    });
    return thread;
  }

  onMessage(handler: (msg: NormalizedMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async saveIncomingAttachments(message: NormalizedMessage): Promise<Attachment[]> {
    return saveUrlAttachments(message);
  }

  /**
   * Fetch recent Discord messages via the REST API (no live gateway needed).
   *
   * - `threadId = null`  → all text channels across all guilds
   * - `threadId = <id>`  → only that specific channel
   */
  async fetchHistory(threadId: string | null, windowHours: number): Promise<NormalizedMessage[]> {
    const cutoffMs = Date.now() - windowHours * 60 * 60 * 1000;
    const afterSnowflake = timestampToSnowflake(cutoffMs);
    const maxPerChannel = Math.min(this.maxMessagesPerChannel, 100);

    if (threadId !== null) {
      // Single-channel fetch — normalize consistently with the all-guilds path:
      // reverse to chronological order and filter out bot messages.
      const messages = await this.fetchChannelMessages(
        this.rest,
        threadId,
        afterSnowflake,
        maxPerChannel,
      );
      messages.reverse();
      return messages
        .filter((m) => !m.author.bot)
        .map((m) => restMessageToNormalized(m, "discord", threadId, threadId));
    }

    // All-guilds fetch — channels and messages are fetched in parallel across guilds
    const guilds = (await this.rest.get(Routes.userGuilds())) as DiscordRestGuild[];
    log.info("fetchHistory: guilds found", { count: guilds.length });

    const perGuild = await Promise.all(
      guilds.map(async (guild) => {
        let channels: DiscordRestChannel[];
        try {
          channels = (await this.rest.get(Routes.guildChannels(guild.id))) as DiscordRestChannel[];
        } catch (err) {
          log.warn("fetchHistory: failed to list channels", {
            guild: guild.name,
            error: err instanceof Error ? err.message : String(err),
          });
          return [];
        }

        const readable = channels.filter((c) => HISTORY_CHANNEL_TYPES.has(c.type));

        const perChannel = await Promise.all(
          readable.map(async (channel) => {
            const channelName = channel.name ?? channel.id;
            let messages: DiscordRestMessage[];
            try {
              messages = await this.fetchChannelMessages(
                this.rest,
                channel.id,
                afterSnowflake,
                maxPerChannel,
              );
            } catch (err) {
              if ((err as { status?: number }).status !== 403) {
                log.warn("fetchHistory: failed to read channel", {
                  guild: guild.name,
                  channel: channelName,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
              return [] as NormalizedMessage[];
            }

            // Discord returns newest-first; reverse to chronological order
            messages.reverse();
            return messages
              .filter((m) => !m.author.bot)
              .map((m) => restMessageToNormalized(m, guild.name, channel.id, channelName));
          }),
        );

        return perChannel.flat();
      }),
    );

    const allMessages = perGuild.flat();
    log.info("fetchHistory: complete", { messageCount: allMessages.length, windowHours });
    return allMessages;
  }

  private async fetchChannelMessages(
    rest: REST,
    channelId: string,
    afterSnowflake: string,
    limit: number,
  ): Promise<DiscordRestMessage[]> {
    return (await rest.get(Routes.channelMessages(channelId), {
      query: new URLSearchParams({ after: afterSnowflake, limit: String(limit) }),
    })) as DiscordRestMessage[];
  }

  async notifyTyping(threadId: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(threadId);
      if (channel?.isTextBased()) {
        await (channel as SendableChannel).sendTyping();
      }
    } catch {
      // Ignore typing errors — non-critical
    }
  }

  private extractAttachments(message: Message): Attachment[] {
    const attachments: Attachment[] = [];
    for (const att of message.attachments.values()) {
      const mimeType = att.contentType ?? undefined;
      const fileName = att.name
        ? discordAttachmentName(att.name, att.title)
        : (att.title ?? undefined);
      if (mimeType?.startsWith("image/")) {
        attachments.push({ type: "image", url: att.url, fileName });
      } else if (mimeType?.startsWith("video/")) {
        attachments.push({ type: "video", url: att.url, mimeType, fileName });
      } else if (mimeType?.startsWith("audio/")) {
        attachments.push({ type: "audio", url: att.url, mimeType, fileName });
      } else {
        attachments.push({
          type: "document",
          url: att.url,
          mimeType,
          fileName,
        });
      }
    }
    return attachments;
  }

  private async sendAttachment(channel: SendableChannel, att: OutgoingAttachment): Promise<string> {
    const isUrl = att.source.startsWith("http");
    const file = isUrl
      ? new AttachmentBuilder(att.source, { name: basename(att.source) })
      : new AttachmentBuilder(createReadStream(att.source), { name: basename(att.source) });

    const sent = await channel.send({
      content: att.caption,
      files: [file],
    });
    return sent.id;
  }
}

/** Breaks at newlines where possible. */
function splitMessage(text: string, maxLength = 2000): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt <= 0) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
