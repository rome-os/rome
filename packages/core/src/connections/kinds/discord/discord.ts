import type {
  Client,
  ChannelType,
  DiscordAPIError,
  REST,
  Message,
  MessageCreateOptions,
  TextChannel,
  DMChannel,
  NewsChannel,
  ThreadChannel,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
} from "discord.js";
import { randomBytes } from "node:crypto";
import { SendRefused, isStopCommand } from "@rome-os/app-runtime";
import type {
  APIRequest,
  RateLimitData,
  RequestMethod,
  ResponseLike,
  RESTOptions,
} from "discord.js";
import { requireOnFirstUse } from "../../../lib/require-on-first-use.js";
import { KeyedMutex } from "../../../lib/keyed-mutex.js";
import {
  filterConnectionApiResponseHeaders,
  isProtectedConnectionApiRequestHeader,
  type ConnectionApiRequest,
  type ConnectionApiResult,
} from "../../../apps/platform-requests.js";
import type {
  ChannelMessage,
  ChatDescriptor,
  ChatId,
  ChatSettingsControl,
  ChatSettingsSnapshot,
  MessageReceipt,
} from "@rome-os/app-runtime";
import type { Attachment, OutgoingMessage, OutgoingAttachment } from "../../../types.js";
import { createLogger } from "../../../logger.js";
import {
  ALL_ATTACHMENT_TYPES,
  attachmentsToSend,
  replyToShaped,
  textToSend,
} from "../../outbound/send-refusals.js";
import { saveUrlAttachments } from "../../inbound/attachment-files.js";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import {
  DISCORD_API_VERSION,
  DISCORD_BROKER_RESPONSE_LIMIT_BYTES,
  normalizeDiscordEndpoint,
} from "@rome/api-types/discord-broker";
import { isLinkCodeMessage } from "../../../people/link-code/index.js";
import { archivedDiscordThreads } from "./discord-threads.js";
import type { TalkHistoryRead } from "../../types.js";
import { type DiscordGet, readDiscordHistory, type WireChannel } from "./discord-history.js";
import { botReadsHistory } from "./discord-permissions.js";
import { discordAttachment } from "./discord-attachment.js";
import type * as connections from "../../message.js";
import type { Command, CommandSpec, Commands } from "../../command.js";

// discord.js loads when a Discord connection first needs it, not with every boot.
const discordJs = requireOnFirstUse<typeof import("discord.js")>("discord.js");

const log = createLogger("discord");

type SendableChannel = TextChannel | DMChannel | NewsChannel | ThreadChannel;

/** The chat settings the bot reads: which chats it sees, by their names and
 *  the channel a thread was opened under, and where a chat's replies go. */
type DiscordChatSettings = Pick<ChatSettingsControl, "get"> & {
  observe?(descriptor: ChatDescriptor): void;
};

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
  if (message.type !== discordJs().MessageType.Reply) return undefined;
  if (message.reference?.type === discordJs().MessageReferenceType.Forward) return undefined;
  return message.reference?.messageId;
}

function isThreadType(type: ChannelType): boolean {
  return (
    type === discordJs().ChannelType.PublicThread ||
    type === discordJs().ChannelType.PrivateThread ||
    type === discordJs().ChannelType.AnnouncementThread
  );
}

/** `list` as Discord's slash commands, in the shape its API registers. A
 *  command's subcommands that have subcommands of their own are groups. */
export function discordSlashCommands(list: readonly CommandSpec[]) {
  type Builder = {
    addStringOption(build: (option: StringOption) => StringOption): Builder;
  };
  type StringOption = import("discord.js").SlashCommandStringOption;
  const withOptions = <B extends Builder>(builder: B, spec: CommandSpec): B => {
    for (const option of spec.options ?? []) {
      builder.addStringOption((built) => {
        built
          .setName(option.name)
          .setDescription(option.description)
          .setRequired(option.required ?? false);
        if (option.choices) {
          built.addChoices(...option.choices.map((choice) => ({ name: choice, value: choice })));
        }
        if (option.suggested) built.setAutocomplete(true);
        return built;
      });
    }
    return builder;
  };
  return list.map((spec) => {
    const command = new (discordJs().SlashCommandBuilder)()
      .setName(spec.name)
      .setDescription(spec.description);
    for (const sub of spec.subcommands ?? []) {
      if (sub.subcommands) {
        command.addSubcommandGroup((group) => {
          group.setName(sub.name).setDescription(sub.description);
          for (const leaf of sub.subcommands ?? []) {
            group.addSubcommand((built) =>
              withOptions(built.setName(leaf.name).setDescription(leaf.description), leaf),
            );
          }
          return group;
        });
      } else {
        command.addSubcommand((built) =>
          withOptions(built.setName(sub.name).setDescription(sub.description), sub),
        );
      }
    }
    withOptions(command as unknown as Builder, spec);
    return command.toJSON();
  });
}

export function normalizeDiscordMessageText(content: string, botId?: string): string {
  if (!botId) return content.trim();
  return content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
}

const USER_MENTION = /<@!?([^\s>&]+)>/g;

/**
 * The text of an inbound message as a person sees it: each user mention
 * shows as `@name`, Rome's own accounts included, so the text is the same
 * whichever of Rome's accounts heard it. A mention whose name the message
 * does not carry stays as typed. A command after mentions alone, `/stop` or
 * a link code, reads as the bare command, so its rule matches it; whom it
 * addresses is Participation's to work out from the mentions.
 */
export function discordInboundText(
  content: string,
  nameOf: (userId: string) => string | undefined,
): string {
  const command = withoutMentions(content);
  if (isStopCommand(command)) return "/stop";
  if (isLinkCodeMessage(command)) return command;
  return content
    .replace(USER_MENTION, (token, id: string) => {
      const name = nameOf(id)?.trim();
      return name ? `@${name}` : token;
    })
    .trim();
}

/** The message with its user mentions removed, as a command reads it. */
function withoutMentions(content: string): string {
  return content.replace(USER_MENTION, "").trim();
}

/** A guild channel as surfaced to callers resolving a "#name" → snowflake. */
export interface GuildChannelInfo {
  id: string;
  name: string;
  guildId: string;
  guildName: string;
  type: "text" | "news" | "thread" | "forum";
  parentId?: string;
  /** True for a thread Discord has archived. */
  archived?: boolean;
}

/**
 * Narrow structural view of {@link DiscordAdapter} for cross-module callers
 * that need the Discord-specific methods. Keeping the surface in one exported interface lets
 * TypeScript catch signature drift at those call sites instead of letting a
 * hand-written structural cast silently rot.
 */
export interface DiscordAdapterLike {
  /** Whether the gateway has logged in, so the chats it names are all of them. */
  isReady(): boolean;
  /** Whether the bot may see a chat the gateway names. */
  sees(chat: GuildChannelInfo): boolean;
  listGuildChannels(): GuildChannelInfo[];
  listArchivedThreads(): Promise<GuildChannelInfo[]>;
  executeApiRequest(request: ConnectionApiRequest): Promise<ConnectionApiResult>;
}

function projectDiscordBody(
  status: number,
  headers: ResponseLike["headers"],
  bytes: Uint8Array,
): ConnectionApiResult {
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
      status,
      headers: filterConnectionApiResponseHeaders(headers.entries()),
      body,
    },
  };
}

/**
 * The Discord bot transport. Inbound gateway messages arrive as a Connections
 * message whose `raw` is the discord.js `Message`, so the Connection
 * integration delivers them as they are.
 */
export class DiscordAdapter {
  private client: Client;
  private handler?: (msg: connections.Message) => Promise<void>;
  /** Holds each chat's messages in arrival order until they are delivered. */
  private readonly hearing = new KeyedMutex();
  private chatSettings?: DiscordChatSettings;
  private connectionId?: string;
  private slashCommandsRegistered = false;
  /** The commands this bot offers as slash commands, and who answers them. */
  private commands?: Commands;

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
  /** Set by `stop`: this epoch's credential sends no further reads. */
  private stopped = false;

  constructor(config: {
    botToken: string;
    connectionId?: string;
    chatSettings?: DiscordChatSettings;
    /** The commands to offer as slash commands. Absent, the bot offers
     *  none. */
    commands?: Commands;
    onGatewayFault?: (fault: { kind: "credential" | "transport"; cause: unknown }) => void;
    /** Where the gateway client and the broker send REST requests. Defaults to
     *  Discord's API; tests point it at a local peer. */
    rest?: Partial<RESTOptions>;
  }) {
    this.connectionId = config.connectionId;
    this.chatSettings = config.chatSettings;
    this.commands = config.commands;
    this.onGatewayFault = config.onGatewayFault;
    this.client = new (discordJs().Client)({
      intents: [
        discordJs().GatewayIntentBits.Guilds,
        discordJs().GatewayIntentBits.GuildMessages,
        discordJs().GatewayIntentBits.MessageContent,
        discordJs().GatewayIntentBits.DirectMessages,
        discordJs().GatewayIntentBits.DirectMessageReactions,
      ],
      partials: [discordJs().Partials.Channel, discordJs().Partials.Message],
      ...(config.rest ? { rest: config.rest } : {}),
    });
    this._botToken = config.botToken;
    this.rest = new (discordJs().REST)({
      version: DISCORD_API_VERSION,
      userAgentAppendix: "Rome Discord broker/1",
      ...config.rest,
    }).setToken(config.botToken);
  }

  private _botToken: string;

  /** Whether the gateway has logged in, so `listGuildChannels` names every
   *  chat the bot sees rather than none. */
  isReady(): boolean {
    return this.client.isReady();
  }

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
        if (channel.type === discordJs().ChannelType.GuildText) kind = "text";
        else if (channel.type === discordJs().ChannelType.GuildAnnouncement) kind = "news";
        // A media chat holds posts as a forum does, so it lists as one.
        else if (
          channel.type === discordJs().ChannelType.GuildForum ||
          channel.type === discordJs().ChannelType.GuildMedia
        )
          kind = "forum";
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
          // The gateway keeps a thread it saw archived in its cache.
          ...(channel.isThread() && channel.archived ? { archived: true } : {}),
        });
      }
    }
    return out;
  }

  /**
   * The threads Discord has archived in every chat the bot sees, read from
   * Discord: public ones, and private ones the bot has joined. The gateway
   * names only active threads. A chat whose archive the bot may not see
   * contributes none; any other failure rejects, naming the chat.
   */
  async listArchivedThreads(): Promise<GuildChannelInfo[]> {
    // A chat the bot may not read answers 403, which Discord counts toward
    // banning the bot's address, so only chats it may read are asked.
    const chats = this.listGuildChannels().filter(
      (channel) => channel.type !== "thread" && this.readsArchiveOf(channel),
    );
    const byId = new Map(chats.map((chat) => [chat.id, chat]));
    // The scan must not outlive this credential's epoch: `stop` aborts it,
    // and no request is sent once it has.
    const { get, done } = this.epochGet("Discord connection stopped during the listing");
    let threads: Awaited<ReturnType<typeof archivedDiscordThreads>>;
    try {
      threads = await archivedDiscordThreads(
        get,
        chats.map((chat) => ({ id: chat.id, holdsPrivateThreads: chat.type === "text" })),
      );
    } finally {
      // A failed listing leaves the other readers mid-chat: they stop too.
      done();
    }
    return threads.flatMap((thread) => {
      const chat = byId.get(thread.parentId);
      if (!chat) return [];
      return [
        {
          id: thread.id,
          name: thread.name,
          guildId: chat.guildId,
          guildName: chat.guildName,
          type: "thread" as const,
          parentId: chat.id,
          archived: true,
        },
      ];
    });
  }

  /** Whether the gateway says the bot may see `chat`. The gateway names
   *  chats the bot cannot see too. A chat it cannot tell about counts as seen. */
  sees(chat: GuildChannelInfo): boolean {
    return this.holds(chat, [discordJs().PermissionFlagsBits.ViewChannel]);
  }

  /** Whether the gateway says the bot may read `chat`'s history. A chat it
   *  cannot tell about is asked, and a 403 then skips it. */
  private readsArchiveOf(chat: GuildChannelInfo): boolean {
    const flags = discordJs().PermissionFlagsBits;
    return this.holds(chat, [flags.ViewChannel, flags.ReadMessageHistory]);
  }

  private holds(chat: GuildChannelInfo, permissions: bigint[]): boolean {
    const guild = this.client.guilds.cache.get(chat.guildId);
    const channel = guild?.channels.cache.get(chat.id);
    const me = guild?.members.me;
    if (!channel || !me) return true;
    // discord.js types this as never null, yet a thread whose parent has left
    // the cache answers null: a chat it cannot tell about counts as seen.
    const granted: ReturnType<typeof me.permissionsIn> | null = me.permissionsIn(channel);
    if (!granted) return true;
    // A private thread's permissions are its parent's, yet only its members
    // and those who manage threads see it.
    if (
      channel.type === discordJs().ChannelType.PrivateThread &&
      !channel.joined &&
      !granted.has(discordJs().PermissionFlagsBits.ManageThreads)
    )
      return false;
    return granted.has(permissions);
  }

  /** Execute a provider-relative request through the epoch-owned discord.js
   * REST manager. This boundary pins the path to Discord API v10, rejects
   * caller-owned auth headers, and returns only serializable safe response data. */
  async executeApiRequest(request: ConnectionApiRequest): Promise<ConnectionApiResult> {
    const path = normalizeDiscordEndpoint(request.path);
    for (const name of Object.keys(request.headers)) {
      if (isProtectedConnectionApiRequestHeader(name)) {
        throw new Error(`header ${name} is owned by the channel provider`);
      }
    }
    const controller = new AbortController();
    let deadlineExceeded = false;
    let capturedResponse: ResponseLike | null = null;
    let rateLimit: RateLimitData | null = null;
    const routeData = (
      discordJs().REST as unknown as {
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
    this.rest.on(discordJs().RESTEvents.Response, onResponse);
    this.rest.on(discordJs().RESTEvents.RateLimited, onRateLimited);
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
    } catch (error) {
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
      // gives us the status and safe headers. Under the default undici
      // transport that event object shares its body with the response
      // discord.js already read for a 4xx, so the Discord error payload comes
      // from the thrown DiscordAPIError instead of the event body.
      const observedResponse = capturedResponse as ResponseLike | null;
      if (observedResponse) {
        const projected =
          error instanceof discordJs().DiscordAPIError
            ? this.projectDiscordApiError(error, observedResponse)
            : await this.projectDiscordResponse(observedResponse);
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
      this.rest.off(discordJs().RESTEvents.Response, onResponse);
      this.rest.off(discordJs().RESTEvents.RateLimited, onRateLimited);
    }
  }

  private async projectDiscordResponse(response: ResponseLike): Promise<ConnectionApiResult> {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return projectDiscordBody(response.status, response.headers, bytes);
  }

  private projectDiscordApiError(
    error: DiscordAPIError,
    response: ResponseLike,
  ): ConnectionApiResult {
    // discord.js keeps parsed JSON, or raw bytes for a non-JSON error body.
    const raw: unknown = error.rawError;
    if (raw instanceof ArrayBuffer) {
      return projectDiscordBody(error.status, response.headers, new Uint8Array(raw));
    }
    return {
      response: {
        status: error.status,
        headers: filterConnectionApiResponseHeaders(response.headers.entries()),
        body: raw,
      },
    };
  }

  private descriptor(
    channelId: string,
    displayName?: string,
    parentId?: string | null,
    containerName?: string,
  ): ChatDescriptor {
    if (!this.connectionId) throw new Error("Discord connection id is unavailable");
    const ref = { connectionId: this.connectionId, chatId: channelId as ChatId };
    return {
      ref,
      connectionKind: "discord",
      service: "discord",
      kind: parentId ? "topic" : "channel",
      displayName: displayName ?? channelId,
      containerName,
      ...(parentId
        ? {
            parent: {
              connectionId: this.connectionId,
              chatId: parentId as ChatId,
            },
          }
        : {}),
    };
  }

  /** Tells the chat settings which chat `message` was said in, with its name
   *  and the channel a thread was opened under, so its settings read as that
   *  chat's. */
  private observeChat(message: Message): void {
    if (!this.chatSettings) return;
    const parentId =
      message.channel && "isThread" in message.channel && message.channel.isThread()
        ? message.channel.parentId
        : null;
    const displayName = "name" in message.channel ? (message.channel.name ?? undefined) : undefined;
    const containerName = message.guild?.name;
    this.chatSettings.observe?.(
      this.descriptor(message.channelId, displayName, parentId, containerName),
    );
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
      if (this.commands && !this.slashCommandsRegistered) {
        this.slashCommandsRegistered = true;
        try {
          const commands = discordSlashCommands(this.commands.list);
          await this.rest.put(discordJs().Routes.applicationCommands(client.user.id), {
            body: commands,
          });
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
      if (!this.commands) return;
      if (interaction.isAutocomplete()) {
        await this.handleAutocomplete(interaction);
        return;
      }
      if (!interaction.isChatInputCommand()) return;
      await this.handleSlashCommand(interaction);
    });

    // discord.js 14 builds a DM's channel only from a message whose channel
    // it has cached, and a bot's READY caches none, so a person's first DM
    // would be dropped. The raw event runs before the message's handler, so
    // the DM is cached here, partial, with its sender as the recipient.
    this.client.on("raw", (packet: { t?: string; d?: Record<string, unknown> }) => {
      const data = packet.d;
      if (packet.t !== "MESSAGE_CREATE" || !data || "guild_id" in data) return;
      const channelId = data.channel_id;
      if (typeof channelId !== "string" || this.client.channels.cache.has(channelId)) return;
      (
        this.client.channels as unknown as {
          _add(data: { id: string; type: ChannelType; recipients: unknown[] }): unknown;
        }
      )._add({ id: channelId, type: discordJs().ChannelType.DM, recipients: [data.author] });
    });

    // The gateway calls this for each message without waiting on the last,
    // and hearing one can wait on Discord (a reply's author, a webhook's
    // person). Messages of one chat are heard one after another, so a slow
    // lookup never lets a later message overtake an earlier one.
    this.client.on("messageCreate", (message: Message) =>
      this.hearing
        .runExclusive(message.channelId, () => this.hear(message))
        .catch((err: unknown) => {
          log.error("could not hear a message", { chatId: message.channelId, error: String(err) });
        }),
    );

    await this.client.login(this._botToken);
    log.info("bot logged in", { username: this.client.user?.tag });
  }

  /** Hears one message from the gateway and hands it over. Whether Rome
   *  keeps it, in a chat switched off too, is Rome's call. */
  private async hear(message: Message): Promise<void> {
    if (!this.handler) return;

    if (!message.author) return;
    if (message.system) return;
    // Self-messages: check after we know the client is ready
    if (this.client.user && message.author.id === this.client.user.id) return;

    const isDm =
      message.channel.type === discordJs().ChannelType.DM ||
      message.channel.type === discordJs().ChannelType.GroupDM;
    const isThread = isThreadType(message.channel.type);

    this.observeChat(message);
    await this.dispatchMessage(message, isDm, isThread);
  }

  /** Who said the message `message` replies to, when Discord can fetch it.
   *  A missing message leaves it unknown. */
  private async repliedToAuthor(message: Message): Promise<string | undefined> {
    const reference = resolveDiscordReplyToMessageId(message);
    if (!reference) return undefined;
    try {
      return (await message.channel.messages.fetch(reference)).author.id;
    } catch {
      return undefined;
    }
  }

  /** Who started the thread `message` was said in, when it was said in one. */
  private threadStarter(message: Message): string | undefined {
    if (!isThreadType(message.channel.type) || !("ownerId" in message.channel)) return undefined;
    return (message.channel as ThreadChannel).ownerId ?? undefined;
  }

  private async dispatchMessage(message: Message, isDm: boolean, isThread: boolean): Promise<void> {
    if (!this.handler) return;
    const botId = this.client.user?.id;
    if (!botId) return;

    const text = discordInboundText(
      message.content,
      (id) =>
        // The account's own name, not a server nickname, so it reads the
        // same in every server and matches the name the agent is told.
        message.mentions.users.get(id)?.displayName ?? message.mentions.users.get(id)?.username,
    );

    let threadName: string | undefined;
    if (!isDm && "name" in message.channel) {
      threadName = message.channel.name ?? undefined;
    }

    const parentId =
      isThread && message.channel.isThread() ? (message.channel.parentId ?? null) : null;
    const replyToMessageId = resolveDiscordReplyToMessageId(message);
    // Who said the quoted message is a platform fact Discord gives only by
    // fetching it, and a direct message needs none.
    const repliedTo = !isDm && replyToMessageId ? await this.repliedToAuthor(message) : undefined;
    const startedBy = parentId ? this.threadStarter(message) : undefined;
    const isBot = message.author.bot;

    const msg: connections.Message = {
      id: message.id,
      where: {
        chatId: message.channelId as ChatId,
        kind: isDm ? "direct" : "group",
        ...(threadName ? { name: threadName } : {}),
        // A native thread is a chat of its own, opened under a channel.
        ...(parentId
          ? {
              thread: {
                parentChatId: parentId as ChatId,
                ...(startedBy ? { startedBy } : {}),
              },
            }
          : {}),
      },
      sender: {
        accountId: message.author.id,
        name: message.member?.displayName ?? message.author.displayName ?? message.author.username,
        ...(message.author.username ? { handle: message.author.username } : {}),
        ...(isBot ? { isBot: true } : {}),
      },
      content: { text, attachments: this.extractAttachments(message) },
      receivedBy: botId,
      // Users only: @everyone, @here and roles mention no one account.
      mentions: [...message.mentions.users.keys()],
      ...(replyToMessageId
        ? {
            replyTo: {
              messageId: replyToMessageId,
              ...(repliedTo ? { senderAccountId: repliedTo } : {}),
            },
          }
        : {}),
      saidAt: message.createdAt,
      raw: message,
    };

    log.info("message received", {
      from: msg.sender.accountId,
      chatId: msg.where.chatId,
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

  /** Reports a slash command someone ran and answers it, so that only they
   *  see the answer. */
  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const commands = this.commands;
    if (!commands) return;
    await interaction.deferReply({ ephemeral: true });
    try {
      const command = await this.commandOf(interaction);
      await interaction.editReply({ content: await commands.ran(command) });
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
   * Discord's typeahead for an option that asks for suggestions while it is
   * typed. A failure (Discord's acknowledgement timing out, or no
   * suggestions) shows none, and the person types the value themselves.
   */
  private async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const commands = this.commands;
    if (!commands) return;
    try {
      const focused = interaction.options.getFocused(true);
      const suggestions = await commands.suggest(
        await this.commandOf(interaction),
        focused.name,
        focused.value?.toString() ?? "",
      );
      // Discord shows at most 25.
      await interaction.respond(suggestions.slice(0, 25).map((value) => ({ name: value, value })));
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

  /** `interaction` as the command it reports. The chat it was run in is
   *  observed first, so its settings read as that chat's. */
  private async commandOf(
    interaction: ChatInputCommandInteraction | AutocompleteInteraction,
  ): Promise<Command> {
    const channel =
      interaction.channel ??
      (await this.client.channels.fetch(interaction.channelId ?? "").catch(() => null));
    const parentId = channel?.isThread() ? channel.parentId : null;
    const name = channel && "name" in channel ? (channel.name ?? undefined) : undefined;
    const chatId = interaction.channelId as ChatId;
    if (this.chatSettings && this.connectionId) {
      this.chatSettings.observe?.(this.descriptor(chatId, name, parentId, interaction.guild?.name));
    }
    const path = [interaction.commandName];
    const options: Record<string, string> = {};
    const read = (data: readonly import("discord.js").CommandInteractionOption[]) => {
      for (const option of data) {
        if (option.options && option.value === undefined) {
          path.push(option.name);
          read(option.options);
        } else if (option.value !== undefined) {
          options[option.name] = String(option.value);
        }
      }
    };
    read(interaction.options.data);
    return {
      where: {
        chatId,
        kind: interaction.guildId ? "group" : "direct",
        ...(name ? { name } : {}),
        ...(parentId ? { thread: { parentChatId: parentId as ChatId } } : {}),
      },
      sender: {
        accountId: interaction.user.id,
        name: interaction.user.displayName ?? interaction.user.username,
      },
      receivedBy: this.client.user?.id ?? interaction.applicationId,
      path,
      options,
    };
  }

  private async getConversationSettings(
    channelId: string,
    channelName?: string,
    parentId?: string | null,
    containerName?: string,
  ): Promise<ChatSettingsSnapshot | null> {
    if (!this.chatSettings) return null;
    if (!channelName || parentId === undefined || !containerName) {
      const channel = await this.client.channels.fetch(channelId).catch(() => null);
      if (channel) {
        if (!channelName && "name" in channel) channelName = channel.name ?? undefined;
        if (parentId === undefined) parentId = channel.isThread() ? channel.parentId : null;
        if (!containerName && "guild" in channel) containerName = channel.guild?.name;
      }
    }
    const descriptor = this.descriptor(channelId, channelName, parentId, containerName);
    this.chatSettings.observe?.(descriptor);
    return this.chatSettings.get(descriptor.ref);
  }

  async stop(): Promise<void> {
    this.stopped = true;
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

  /** The Discord channel at `address`: the channel itself, or the DM channel
   *  with the user it names. */
  private async channelOf(address: string): Promise<string> {
    const channel = await this.client.channels.fetch(address).catch(() => null);
    if (channel) return address;
    return this.directConversationFor(address);
  }

  /** `chatId`'s history as Discord keeps it, read live through REST
   *  (discord-history.ts). A DM is read by its own chat id, the one its
   *  messages carry. */
  async readHistory(chatId: ChatId, read: TalkHistoryRead): Promise<ChannelMessage[]> {
    // A read must not outlive this credential's epoch: `stop` aborts it, and
    // no request is sent once it has.
    const { get, signal, done } = this.epochGet("Discord connection stopped during the read");
    try {
      return await this.readHistoryWith(get, chatId, read, signal);
    } finally {
      // Whatever ended the read, nothing it started sends on.
      done();
    }
  }

  /** A GET bound to this credential's epoch: `stop` aborts it, after which it
   *  sends nothing and rejects with `stoppedMessage`. A 401 is reported as a
   *  rejected credential. `done` ends it, aborting whatever is still in
   *  flight. Throws once the connection has stopped. */
  private epochGet(stoppedMessage: string): {
    get: DiscordGet;
    signal: AbortSignal;
    done: () => void;
  } {
    if (this.stopped) throw new Error("Discord connection has stopped");
    const controller = new AbortController();
    this.activeApiRequestControllers.add(controller);
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error(stoppedMessage)), {
        once: true,
      });
    });
    void aborted.catch(() => undefined);
    const get: DiscordGet = async (route, query) => {
      if (controller.signal.aborted) return aborted;
      const request = this.rest
        .get(route, { ...(query ? { query } : {}), signal: controller.signal })
        .catch((err: unknown) => {
          this.reportRejectedCredential(err);
          throw err;
        });
      // discord.js does not observe the signal while it waits on a bucket.
      void request.catch(() => undefined);
      return Promise.race([request, aborted]);
    };
    const done = () => {
      controller.abort();
      this.activeApiRequestControllers.delete(controller);
    };
    return { get, signal: controller.signal, done };
  }

  private async readHistoryWith(
    get: DiscordGet,
    chatId: ChatId,
    read: TalkHistoryRead,
    signal: AbortSignal,
  ): Promise<ChannelMessage[]> {
    const botUser = this.client.user;
    const botId = botUser?.id ?? ((await get(discordJs().Routes.user())) as { id: string }).id;
    return readDiscordHistory(
      {
        get,
        botId,
        textOf: discordInboundText,
        readsHistoryIn: (chat) => this.readsHistoryIn(get, chat, botId, signal),
        nicknameOf: (guildId, userId) =>
          this.client.guilds.cache.get(guildId)?.members.cache.get(userId)?.nickname ?? undefined,
      },
      chatId,
      read,
    );
  }

  /** Whether the bot holds Read Message History in a guild chat or thread,
   *  read from Discord now through the read's own `get`, so the read's
   *  cancellation covers it (discord-permissions.ts). Discord refusing the
   *  chat answers no; a failure that says nothing about access answers null. */
  private async readsHistoryIn(
    get: DiscordGet,
    chat: WireChannel,
    botId: string,
    signal: AbortSignal,
  ): Promise<boolean | null> {
    try {
      return await botReadsHistory(get, chat, botId);
    } catch (err) {
      const status = (err as { status?: unknown } | null)?.status;
      // A stopped read, and a 401 (already reported by `get`), end the read.
      if (signal.aborted || status === 401) throw err;
      if (status === 403 || status === 404) return false;
      return null;
    }
  }

  /** Reports a 401 from Discord as a rejected credential, as the broker does,
   *  and says whether it was one. */
  private reportRejectedCredential(err: unknown): boolean {
    if ((err as { status?: unknown } | null)?.status !== 401) return false;
    this.onGatewayFault?.({
      kind: "credential",
      cause: new Error("Discord REST API rejected the bot credential"),
    });
    return true;
  }

  async directConversationFor(channelUserId: string): Promise<string> {
    return (await this.client.users.createDM(channelUserId)).id;
  }

  async send(chatId: ChatId, message: OutgoingMessage): Promise<MessageReceipt> {
    // A direct message is addressed by the other party's user id, which Chats
    // keys it by (docs/architecture/channels.md#direct-messages): Discord's
    // DM channel for that user is opened, or found, here.
    const text = textToSend("discord", message);
    const replyTo = replyToShaped("discord", message.replyToMessageId, DISCORD_SNOWFLAKE);
    const attachments = await attachmentsToSend("discord", message, {
      types: ALL_ATTACHMENT_TYPES,
      urls: true,
    });
    const threadId: string = await this.channelOf(chatId);
    const channel = await this.client.channels.fetch(threadId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Channel ${threadId} is not a text channel`);
    }

    const targetChannel = await this.replyChannel(channel as SendableChannel, replyTo);
    // A reply that opened no thread on the message quotes it instead, on the
    // first message that goes out. Discord refuses a quote of a message it
    // cannot find, and nothing has gone out then.
    let quote: MessageCreateOptions["reply"] =
      replyTo && targetChannel === channel
        ? { messageReference: replyTo, failIfNotExists: true }
        : undefined;
    // A quote does not mention its author, as an unquoted answer did not.
    // discord.js resends a create whose answer it lost, and a quote refused
    // on that resend would say nothing went out when the first one did. The
    // nonce has Discord return the first message to a resend instead.
    const quoting = <T extends object>(options: T): T => {
      const quoted = quote
        ? {
            ...options,
            reply: quote,
            allowedMentions: { ...ALL_MENTIONS, repliedUser: false },
            nonce: randomBytes(12).toString("base64url"),
            enforceNonce: true,
          }
        : options;
      quote = undefined;
      return quoted;
    };

    try {
      let messageId: string | undefined;
      if (text) {
        // Discord natively supports markdown; send as-is
        // Discord has a 2000 character limit per message
        const chunks = splitMessage(text);
        for (const chunk of chunks) {
          const sent = await sendQuoting(targetChannel, quoting({ content: chunk }));
          messageId ??= sent.id;
        }
      }

      for (const att of attachments) {
        const attachmentMessageId = await this.sendAttachment(targetChannel, att, quoting);
        messageId ??= attachmentMessageId;
      }

      log.info("message sent", { threadId, targetChannelId: targetChannel.id });
      // A reply posted into an auto-thread lands in that thread, so the
      // receipt names the thread, not the channel it was asked for.
      return {
        chatId: targetChannel.id as ChatId,
        ...(messageId ? { messageId } : {}),
      };
    } catch (err) {
      log.error("failed to send message", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /** Where a reply to `replyTo` in `channel` goes. In a guild text channel
   *  whose settings thread replies, that is a thread on the user's message,
   *  so the reply does not flood the channel. */
  private async replyChannel(
    channel: SendableChannel,
    replyTo: string | undefined,
  ): Promise<SendableChannel> {
    const snapshot = await this.getConversationSettings(
      channel.id,
      "name" in channel ? (channel.name ?? undefined) : undefined,
      channel.isThread() ? channel.parentId : null,
      "guild" in channel ? channel.guild?.name : undefined,
    );
    const autoThread = snapshot?.effective.replies.placement !== "inline";
    if (replyTo && channel.type === discordJs().ChannelType.GuildText && autoThread)
      return this.getOrCreateThread(channel, replyTo);
    return channel;
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

  onInbound(handler: (msg: connections.Message) => Promise<void>): void {
    this.handler = handler;
  }

  /** Download a message's files into the profile. Each attachment's `url` is
   *  its Discord CDN link, so the message needs no provider event. */
  async saveIncomingAttachments(message: ChannelMessage): Promise<Attachment[]> {
    return saveUrlAttachments({ ...message, channel: "discord" });
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
    return [...message.attachments.values()].map(discordAttachment);
  }

  private async sendAttachment(
    channel: SendableChannel,
    att: OutgoingAttachment,
    quoting: <T extends object>(options: T) => T = (options) => options,
  ): Promise<string> {
    const isUrl = att.source.startsWith("http");
    const file = isUrl
      ? new (discordJs().AttachmentBuilder)(att.source, { name: basename(att.source) })
      : new (discordJs().AttachmentBuilder)(createReadStream(att.source), {
          name: basename(att.source),
        });

    const sent = await sendQuoting(channel, quoting({ content: att.caption, files: [file] }));
    return sent.id;
  }
}

/** Whether `err` is Discord refusing the quote of a send: an unknown message,
 *  a bot that may not read the chat's history and so may not quote it, or an
 *  invalid form whose fault is the message reference. Any other invalid form
 *  is the send's own fault. */
function isRefusedQuote(err: unknown): boolean {
  if (!(err instanceof discordJs().DiscordAPIError)) return false;
  if (Number(err.code) === 10008 || Number(err.code) === 160002) return true;
  const errors = (err.rawError as { errors?: Record<string, unknown> }).errors;
  return Number(err.code) === 50035 && errors?.message_reference !== undefined;
}

/** Sends `options` on `channel`, refusing as `reply_unaddressable` the quote
 *  Discord cannot find. Only the first message of a send quotes, so nothing
 *  has gone out when it is refused. */
async function sendQuoting(
  channel: SendableChannel,
  options: MessageCreateOptions,
): Promise<Message> {
  try {
    return await channel.send(options);
  } catch (err) {
    const quoted = options.reply?.messageReference;
    if (quoted && isRefusedQuote(err)) {
      throw new SendRefused(
        "reply_unaddressable",
        `discord cannot quote message ${JSON.stringify(quoted)} here`,
      );
    }
    throw err;
  }
}

/** The mentions Discord parses when a message names none of its own, kept
 *  when a quote turns off the mention of its author. */
const ALL_MENTIONS = {
  parse: ["users", "roles", "everyone"] as ("users" | "roles" | "everyone")[],
};

/** A Discord message id: a snowflake, a decimal number. */
const DISCORD_SNOWFLAKE = /^\d{1,20}$/;

/** Breaks at newlines where possible. */
export function splitMessage(text: string, maxLength = 2000): string[] {
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
