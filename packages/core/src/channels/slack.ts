// Slack bot transport over Socket Mode. Channel contract: docs/architecture/channels.md.
//
// Each Slack bot is its own Slack app, created by the guardian from a
// prefilled manifest. Rome holds the app's bot token (Web API calls) and its
// app-level token (Socket Mode), and opens its own WebSocket to Slack, so an
// instance needs no public events address. Events arrive as Socket Mode
// envelopes, which Rome acknowledges before handling.

import type { ChannelMessage, ChatId, MessageReceipt, OutgoingMessage } from "@rome-os/app-runtime";
import { WebSocket } from "ws";
import { createLogger } from "../logger.js";
import { InboundDedup } from "./inbound-dedup.js";

const log = createLogger("slack");

const SLACK_API_TIMEOUT_MS = 15_000;
const SLACK_RATE_LIMIT_MAX_WAIT_MS = 30_000;
/** chat.postMessage takes up to 12,000 characters of `markdown_text`. */
const SLACK_MARKDOWN_CHUNK_LENGTH = 12_000;
const SLACK_RECONNECT_BASE_MS = 1_000;
const SLACK_RECONNECT_MAX_MS = 30_000;
/** Consecutive failed reconnects before the socket reports a fault and lets
 *  the registry rebuild the epoch with its own backoff. */
const SLACK_RECONNECT_MAX_ATTEMPTS = 5;
const SLACK_USER_NAME_CACHE_SIZE = 500;
/** How long a new connection, setup's probe included, waits for `hello`. */
const SLACK_HELLO_TIMEOUT_MS = 10_000;
/** How often a live connection pings Slack. A ping still unanswered at the
 *  next one marks the connection dead, since a half-open socket never closes
 *  on its own. */
const SLACK_PING_INTERVAL_MS = 30_000;

/** The bot scopes a Rome Slack app asks for. Rome reads direct messages and
 *  mentions only, so it never asks to read channel history. */
export const SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "im:history",
  "im:read",
  "im:write",
  "users:read",
] as const;

/** The bot events a Rome Slack app subscribes to. */
export const SLACK_BOT_EVENTS = [
  "app_mention",
  "message.im",
  "app_uninstalled",
  "tokens_revoked",
] as const;

export interface SlackBotIdentity {
  teamId: string;
  workspaceName?: string;
  botUserId: string;
  botUsername?: string;
  appId?: string;
}

export class SlackApiError extends Error {
  constructor(
    readonly code: string,
    message = `Slack API request failed: ${code}`,
  ) {
    super(message);
    this.name = "SlackApiError";
  }
}

/** True when Slack refused the token itself, rather than the request. */
export function isSlackCredentialError(error: unknown): boolean {
  return (
    error instanceof SlackApiError &&
    [
      "account_inactive",
      "invalid_auth",
      "not_allowed_token_type",
      "not_authed",
      "token_expired",
      "token_revoked",
      "app_uninstalled",
      "tokens_revoked",
      "app_mismatch",
    ].includes(error.code)
  );
}

/** The Slack Web API calls the transport makes. Injectable so tests run
 *  without the network. */
export interface SlackWebApi {
  authTest(botToken: string, signal?: AbortSignal): Promise<SlackBotIdentity>;
  /** Opens a Socket Mode connection with the app-level token and returns its
   *  WebSocket URL. */
  openConnection(appToken: string, signal?: AbortSignal): Promise<string>;
  postMessage(
    botToken: string,
    input: { channel: string; markdown: string; threadTs?: string },
    signal?: AbortSignal,
  ): Promise<{ ts: string }>;
  /** The direct-message conversation with one workspace member. */
  openDirectMessage(botToken: string, userId: string, signal?: AbortSignal): Promise<string>;
  userName(botToken: string, userId: string, signal?: AbortSignal): Promise<SlackUserName>;
}

export interface SlackUserName {
  displayName?: string;
  username?: string;
}

interface SlackApiResponse {
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
}

async function slackApiCall(
  token: string,
  method: string,
  body: Record<string, unknown> | undefined,
  signal?: AbortSignal,
): Promise<SlackApiResponse> {
  let retriedRateLimit = false;
  for (;;) {
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(SLACK_API_TIMEOUT_MS)])
      : AbortSignal.timeout(SLACK_API_TIMEOUT_MS);
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body ?? {}),
      signal: requestSignal,
    });
    if (response.status === 429 && !retriedRateLimit) {
      await response.body?.cancel().catch(() => {});
      retriedRateLimit = true;
      const retryAfterSeconds = Number(response.headers.get("retry-after") ?? "1");
      const waitMs = Math.max(
        1_000,
        Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1_000 : 1_000,
      );
      if (waitMs > SLACK_RATE_LIMIT_MAX_WAIT_MS) {
        throw new SlackApiError("ratelimited", `Slack asked Rome to wait ${waitMs}ms.`);
      }
      await abortableDelay(waitMs, signal);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new SlackApiError(
        response.status === 429 ? "ratelimited" : `http_${response.status}`,
        `Slack API returned HTTP ${response.status}`,
      );
    }
    const result = (await response.json()) as SlackApiResponse;
    if (!result.ok) throw new SlackApiError(result.error ?? "unknown_error");
    return result;
  }
}

/** A read method Slack takes only as a query string. */
async function slackApiGet(
  token: string,
  method: string,
  query: Record<string, string>,
  signal?: AbortSignal,
): Promise<SlackApiResponse> {
  const response = await fetch(
    `https://slack.com/api/${method}?${new URLSearchParams(query).toString()}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(SLACK_API_TIMEOUT_MS)])
        : AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new SlackApiError(
      `http_${response.status}`,
      `Slack API returned HTTP ${response.status}`,
    );
  }
  const body = (await response.json()) as SlackApiResponse;
  if (!body.ok) throw new SlackApiError(body.error ?? "unknown_error");
  return body;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  const abortError = () =>
    signal?.reason instanceof Error ? signal.reason : new Error("Slack wait aborted.");
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError());
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export const slackWebApi: SlackWebApi = {
  async authTest(botToken, signal) {
    const result = await slackApiCall(botToken, "auth.test", undefined, signal);
    const teamId = stringField(result.team_id);
    const botUserId = stringField(result.user_id);
    if (!teamId || !botUserId) {
      throw new SlackApiError("invalid_auth_test", "Slack did not return a workspace and bot id.");
    }
    let appId = stringField(result.app_id);
    const botId = stringField(result.bot_id);
    if (!appId && botId) {
      // auth.test names the bot, and bots.info names the app it belongs to.
      const bot = await slackApiGet(botToken, "bots.info", { bot: botId }, signal);
      appId = stringField((bot.bot as { app_id?: unknown } | undefined)?.app_id);
    }
    return {
      teamId,
      workspaceName: stringField(result.team),
      botUserId,
      botUsername: stringField(result.user),
      appId,
    };
  },
  async openConnection(appToken, signal) {
    const result = await slackApiCall(appToken, "apps.connections.open", undefined, signal);
    const url = stringField(result.url);
    if (!url) throw new SlackApiError("missing_url", "Slack did not return a Socket Mode URL.");
    return url;
  },
  async postMessage(botToken, input, signal) {
    const result = await slackApiCall(
      botToken,
      "chat.postMessage",
      {
        channel: input.channel,
        markdown_text: input.markdown,
        ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      },
      signal,
    );
    const ts = stringField(result.ts);
    if (!ts) throw new SlackApiError("missing_message_id");
    return { ts };
  },
  async openDirectMessage(botToken, userId, signal) {
    const result = await slackApiCall(botToken, "conversations.open", { users: userId }, signal);
    const channel = result.channel as { id?: unknown } | undefined;
    const id = stringField(channel?.id);
    if (!id) throw new SlackApiError("missing_channel", "Slack did not open a direct message.");
    return id;
  },
  async userName(botToken, userId, signal) {
    const body = await slackApiGet(botToken, "users.info", { user: userId }, signal);
    const user = body.user as
      | { name?: unknown; real_name?: unknown; profile?: { display_name?: unknown } }
      | undefined;
    return {
      displayName: stringField(user?.profile?.display_name) ?? stringField(user?.real_name),
      username: stringField(user?.name),
    };
  },
};

// ── Socket Mode ──────────────────────────────────────────────────────────────

/** The slice of a WebSocket the Socket Mode client uses. `close` drops the
 *  connection at once and fires `close`, even when the peer is gone. */
export interface SlackSocketLike {
  send(data: string): void;
  close(): void;
  /** Sends a protocol ping, answered by a `pong` event. */
  ping(): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close" | "pong", listener: () => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
}

export type CreateSlackSocket = (url: string) => SlackSocketLike;

const createWebSocket: CreateSlackSocket = (url) => {
  const ws = new WebSocket(url);
  return {
    send: (data) => ws.send(data),
    close: () => ws.terminate(),
    ping: () => ws.ping(),
    addEventListener: (type: string, listener: (event: never) => void) => {
      if (type === "message") {
        ws.on("message", (data) => (listener as (event: { data: unknown }) => void)({ data }));
      } else if (type === "close" || type === "pong") {
        ws.on(type, () => (listener as () => void)());
      } else if (type === "error") {
        ws.on("error", (error) => (listener as (event: unknown) => void)(error));
      }
    },
  };
};

/** One Events API payload, as a Socket Mode `events_api` envelope carries it. */
export interface SlackEventCallback {
  type: "event_callback";
  team_id: string;
  api_app_id?: string;
  event_id: string;
  event: SlackEvent;
}

export interface SlackEvent {
  type: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  team?: string;
  user_team?: string;
  source_team?: string;
  tokens?: { bot?: string[]; oauth?: string[] };
  text?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
}

interface SocketEnvelope {
  type?: string;
  envelope_id?: string;
  payload?: unknown;
  reason?: string;
  connection_info?: { app_id?: string };
}

/**
 * The app an app-level token belongs to, as the `hello` of a Socket Mode
 * connection names it. Setup reads it to check that the pasted app-level
 * token and bot token belong to the same app. The connection is closed once
 * it answers.
 */
export async function readSocketAppId(
  api: SlackWebApi,
  appToken: string,
  options: { createSocket?: CreateSlackSocket; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string | undefined> {
  const url = await api.openConnection(appToken, options.signal);
  const socket = (options.createSocket ?? createWebSocket)(url);
  try {
    return await new Promise<string | undefined>((resolve, reject) => {
      const onAbort = () =>
        settle(() =>
          reject(
            options.signal?.reason instanceof Error ? options.signal.reason : new Error("aborted"),
          ),
        );
      const settle = (finish: () => void) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        finish();
      };
      const fail = (error: Error) => settle(() => reject(error));
      const timer = setTimeout(
        () => fail(new SlackApiError("hello_timeout", "Slack did not answer on Socket Mode.")),
        options.timeoutMs ?? SLACK_HELLO_TIMEOUT_MS,
      );
      timer.unref?.();
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener("abort", onAbort, { once: true });
      socket.addEventListener("message", (event) => {
        let envelope: SocketEnvelope;
        try {
          envelope = JSON.parse(String(event.data)) as SocketEnvelope;
        } catch {
          return;
        }
        if (envelope.type !== "hello") return;
        settle(() => resolve(envelope.connection_info?.app_id));
      });
      socket.addEventListener("close", () =>
        fail(new SlackApiError("socket_closed", "Slack closed the Socket Mode connection.")),
      );
      // `ws` emits `error` for a refused or cancelled connection, and an
      // unhandled one would end the process. The listener stays attached, so
      // an error after the probe settles is ignored too.
      socket.addEventListener("error", (event) =>
        fail(
          new SlackApiError(
            "socket_error",
            `Socket Mode connection failed: ${event instanceof Error ? event.message : String(event)}`,
          ),
        ),
      );
    });
  } finally {
    socket.close();
  }
}

/**
 * A Socket Mode connection that stays open. Slack rotates a connection every
 * few hours with a `disconnect` envelope, and the client opens a fresh one.
 * An unexpected close reconnects with backoff. Only a refused token, or
 * reconnects that keep failing, reach `onFault`.
 */
export class SlackSocketMode {
  private socket: SlackSocketLike | null = null;
  private stopped = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Watches the current socket: first for its `hello`, then for pongs. */
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private awaitingPong = false;
  private readonly abort = new AbortController();

  constructor(
    private readonly config: {
      appToken: string;
      api: SlackWebApi;
      createSocket?: CreateSlackSocket;
      /** The app the bot token belongs to. A connection whose `hello` names
       *  another app is refused, since its events are not this bot's. */
      expectedAppId?: string;
      onEvent: (payload: SlackEventCallback) => void;
      onFault: (cause: unknown) => void;
      helloTimeoutMs?: number;
      pingIntervalMs?: number;
    },
  ) {}

  /** Opens the first connection. Rejects when Slack refuses the token. */
  async start(): Promise<void> {
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort(new Error("Slack Socket Mode stopped."));
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearWatchdog();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private watch(socket: SlackSocketLike, delayMs: number, onExpire: () => void): void {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (socket === this.socket) onExpire();
    }, delayMs);
    this.watchdog.unref?.();
  }

  /** Drops a connection that stopped answering and opens another. */
  private abandon(socket: SlackSocketLike, reason: string): void {
    log.warn("slack socket stopped answering", { reason });
    this.clearWatchdog();
    this.socket = null;
    socket.close();
    this.scheduleReconnect();
  }

  private ping(socket: SlackSocketLike): void {
    const interval = this.config.pingIntervalMs ?? SLACK_PING_INTERVAL_MS;
    this.watch(socket, interval, () => {
      if (this.awaitingPong) {
        this.abandon(socket, "no pong");
        return;
      }
      this.awaitingPong = true;
      socket.ping();
      this.ping(socket);
    });
  }

  private async connect(): Promise<void> {
    const url = await this.config.api.openConnection(this.config.appToken, this.abort.signal);
    if (this.stopped) return;
    const socket = (this.config.createSocket ?? createWebSocket)(url);
    this.socket = socket;
    this.awaitingPong = false;
    this.watch(socket, this.config.helloTimeoutMs ?? SLACK_HELLO_TIMEOUT_MS, () =>
      this.abandon(socket, "no hello"),
    );
    socket.addEventListener("message", (event) => this.onMessage(socket, event.data));
    socket.addEventListener("pong", () => {
      if (socket === this.socket) this.awaitingPong = false;
    });
    socket.addEventListener("close", () => this.onClose(socket));
    socket.addEventListener("error", (event) => {
      log.warn("slack socket error", { error: describe(event) });
    });
  }

  private onMessage(socket: SlackSocketLike, data: unknown): void {
    if (socket !== this.socket) return;
    let envelope: SocketEnvelope;
    try {
      envelope = JSON.parse(String(data)) as SocketEnvelope;
    } catch {
      log.warn("slack socket sent a frame that is not JSON");
      return;
    }
    if (envelope.type === "hello") {
      const appId = envelope.connection_info?.app_id;
      if (this.config.expectedAppId && appId !== this.config.expectedAppId) {
        log.error("slack socket belongs to another app", {
          expectedAppId: this.config.expectedAppId,
          appId,
        });
        this.stop();
        this.config.onFault(
          new SlackApiError("app_mismatch", "The app-level token belongs to another Slack app."),
        );
        return;
      }
      this.reconnectAttempts = 0;
      this.ping(socket);
      log.info("slack socket connected");
      return;
    }
    if (envelope.type === "disconnect") {
      log.info("slack socket rotating", { reason: envelope.reason });
      this.replace(socket);
      return;
    }
    // Every envelope with an id is acknowledged, or Slack resends it. Rome
    // answers none of them with a payload.
    if (envelope.envelope_id) socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    if (envelope.type !== "events_api") return;
    const payload = envelope.payload as SlackEventCallback | undefined;
    if (payload?.type !== "event_callback" || !payload.event) return;
    try {
      this.config.onEvent(payload);
    } catch (error) {
      log.error("slack event handler failed", { error: describe(error) });
    }
  }

  private onClose(socket: SlackSocketLike): void {
    if (socket !== this.socket || this.stopped) return;
    this.clearWatchdog();
    this.socket = null;
    this.scheduleReconnect();
  }

  /** Opens the next connection, then closes the one Slack is retiring. */
  private replace(old: SlackSocketLike): void {
    this.clearWatchdog();
    this.socket = null;
    old.close();
    this.scheduleReconnect(0);
  }

  /** Every connection that ends before its `hello`, or after it stops
   *  answering, spends one attempt. A `hello` refills the budget, and an
   *  exhausted one reaches `onFault` so the registry can report it. */
  private scheduleReconnect(delayMs?: number, cause?: unknown): void {
    if (this.stopped || this.reconnectTimer) return;
    if (this.reconnectAttempts >= SLACK_RECONNECT_MAX_ATTEMPTS) {
      this.stop();
      this.config.onFault(
        cause ?? new SlackApiError("socket_unavailable", "Slack Socket Mode kept dropping."),
      );
      return;
    }
    const attempt = this.reconnectAttempts++;
    const wait =
      delayMs ?? Math.min(SLACK_RECONNECT_BASE_MS * 2 ** attempt, SLACK_RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error) => {
        if (this.stopped) return;
        if (isSlackCredentialError(error)) {
          this.stop();
          this.config.onFault(error);
          return;
        }
        log.warn("slack socket reconnect failed", { error: describe(error) });
        this.scheduleReconnect(undefined, error);
      });
    }, wait);
    this.reconnectTimer.unref?.();
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Addresses and text ───────────────────────────────────────────────────────

/** A Slack member's address. Slack user ids are issued per workspace, so the
 *  address carries the workspace: one person in two workspaces is two
 *  accounts. */
export function slackSenderId(teamId: string, userId: string): string {
  return `${teamId}/${userId}`;
}

/** The Slack user id inside a sender address, or the input when it carries no
 *  workspace. */
export function slackUserIdOf(senderId: string): string {
  const separator = senderId.indexOf("/");
  return separator === -1 ? senderId : senderId.slice(separator + 1);
}

/** A thread in a Slack channel is its own conversation, addressed by the
 *  channel and the thread's first message. */
export function slackThreadChatId(channelId: string, threadTs: string): ChatId {
  return `${channelId}:${threadTs}` as ChatId;
}

export function parseSlackChatId(chatId: string): {
  channelId: string;
  threadTs?: string;
} {
  const separator = chatId.indexOf(":");
  if (separator === -1) return { channelId: chatId };
  return {
    channelId: chatId.slice(0, separator),
    threadTs: chatId.slice(separator + 1),
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Slack's wire text as a person reads it: mentions, channel links and URLs
 *  unwrapped, and the bot's own mention removed. */
export function decodeSlackText(text: string, botUserId?: string): string {
  const withoutBot = botUserId
    ? text.replace(new RegExp(`<@${escapeRegex(botUserId)}(?:\\|[^>]+)?>`, "g"), "")
    : text;
  return withoutBot
    .replace(
      /<@([A-Z0-9]+)(?:\|([^>]+))?>/gi,
      (_match, id: string, label?: string) => `@${label ?? id}`,
    )
    .replace(
      /<#([A-Z0-9]+)(?:\|([^>]*))?>/gi,
      (_match, id: string, label?: string) => `#${label || id}`,
    )
    .replace(/<(https?:\/\/[^|>]+)(?:\|([^>]+))?>/gi, (_match, url: string, label?: string) =>
      label && label !== url ? `${label} (${url})` : url,
    )
    .replace(/&(amp|lt|gt);/g, (_entity, name: string) =>
      name === "amp" ? "&" : name === "lt" ? "<" : ">",
    )
    .trim();
}

/** Splits text into chunks Slack accepts, never inside a code point. */
export function splitSlackText(text: string, limit = SLACK_MARKDOWN_CHUNK_LENGTH): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const codePoint of text) {
    if (chunk && chunk.length + codePoint.length > limit) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += codePoint;
  }
  if (chunk || chunks.length === 0) chunks.push(chunk);
  return chunks;
}

function isExternalAuthor(payload: SlackEventCallback): boolean {
  const event = payload.event;
  return [event.team, event.user_team, event.source_team].some(
    (team) => typeof team === "string" && team !== payload.team_id,
  );
}

// ── Adapter ──────────────────────────────────────────────────────────────────

export interface SlackAdapterConfig {
  botToken: string;
  appToken: string;
  /** The connection kind the channel records carry. */
  channel: string;
  api?: SlackWebApi;
  createSocket?: CreateSlackSocket;
  /** A refused token or a transport that will not come back. */
  onFault?: (fault: { kind: "credential" | "transport"; cause: unknown }) => void;
}

/**
 * The Slack bot transport. Inbound events arrive as the channel's own record,
 * a `ChannelMessage` whose `raw` is the Events API payload. Rome hears direct
 * messages and mentions of the bot. A mention in a channel opens a thread
 * conversation, and the reply goes into that thread.
 */
export class SlackAdapter {
  private handler?: (message: ChannelMessage) => Promise<void>;
  private identity: SlackBotIdentity | null = null;
  private socket: SlackSocketMode | null = null;
  private readonly dedup = new InboundDedup(1_000);
  private readonly userNames = new Map<string, SlackUserName>();
  /** The tail of each conversation's deliveries, so a slow name lookup never
   *  lets a later message overtake an earlier one. */
  private readonly deliveries = new Map<string, Promise<void>>();
  private sendAbort = new AbortController();
  private readonly api: SlackWebApi;

  constructor(private readonly config: SlackAdapterConfig) {
    this.api = config.api ?? slackWebApi;
  }

  onInbound(handler: (message: ChannelMessage) => Promise<void>): void {
    this.handler = handler;
  }

  /** Checks the bot token, then opens Socket Mode. Rejects when either token
   *  is refused. */
  async start(): Promise<void> {
    if (this.sendAbort.signal.aborted) this.sendAbort = new AbortController();
    const signal = this.sendAbort.signal;
    const identity = await this.api.authTest(this.config.botToken, signal);
    // A stop() while auth.test was in flight wins: the adapter stays down.
    if (signal.aborted) return;
    this.identity = identity;
    const socket = new SlackSocketMode({
      appToken: this.config.appToken,
      api: this.api,
      createSocket: this.config.createSocket,
      expectedAppId: this.identity.appId,
      onEvent: (payload) => this.handleEvent(payload),
      onFault: (cause) =>
        this.config.onFault?.({
          kind: isSlackCredentialError(cause) ? "credential" : "transport",
          cause,
        }),
    });
    this.socket = socket;
    await socket.start();
    log.info("slack bot started", {
      teamId: this.identity.teamId,
      botUserId: this.identity.botUserId,
    });
  }

  stop(): void {
    this.sendAbort.abort(new Error("Slack adapter stopped."));
    this.socket?.stop();
    this.socket = null;
    this.identity = null;
  }

  async send(chatId: ChatId, message: OutgoingMessage): Promise<MessageReceipt> {
    const omittedAttachments = message.attachments?.length ?? 0;
    if (omittedAttachments > 0) {
      log.warn("slack omitted outbound attachments", { attachments: omittedAttachments });
    }
    const text = message.text?.trim();
    if (!text) return { chatId };
    const { channelId, threadTs } = parseSlackChatId(chatId);
    let firstTs: string | undefined;
    for (const chunk of splitSlackText(text)) {
      const sent = await this.api.postMessage(
        this.config.botToken,
        { channel: channelId, markdown: chunk, threadTs },
        this.sendAbort.signal,
      );
      firstTs ??= sent.ts;
    }
    return { chatId, ...(firstTs ? { messageId: firstTs } : {}) };
  }

  /** The direct-message conversation with a workspace member. */
  async directConversationFor(senderId: string): Promise<ChatId | null> {
    // An address names its workspace. A member of another workspace is not
    // reachable through this bot, even when the user id resolves here.
    const separator = senderId.indexOf("/");
    if (!this.identity || separator === -1) return null;
    if (senderId.slice(0, separator) !== this.identity.teamId) return null;
    const userId = slackUserIdOf(senderId.trim());
    if (!userId) return null;
    return (await this.api.openDirectMessage(
      this.config.botToken,
      userId,
      this.sendAbort.signal,
    )) as ChatId;
  }

  private handleEvent(payload: SlackEventCallback): void {
    const identity = this.identity;
    if (!identity) return;
    // Only this bot's app and workspace speak on its connection.
    if (payload.team_id !== identity.teamId) return;
    if (payload.api_app_id && identity.appId && payload.api_app_id !== identity.appId) return;
    if (this.dedup.checkAndRecord(payload.event_id)) return;
    const event = payload.event;

    if (event.type === "app_uninstalled") {
      this.config.onFault?.({ kind: "credential", cause: new SlackApiError(event.type) });
      return;
    }
    if (event.type === "tokens_revoked") {
      if (event.tokens?.bot?.includes(identity.botUserId)) {
        this.config.onFault?.({ kind: "credential", cause: new SlackApiError(event.type) });
      }
      return;
    }

    // Slack user ids are workspace-scoped. An author from another workspace
    // (Slack Connect) never speaks under this workspace's address, where an id
    // collision could inherit a local member's pairing.
    if (isExternalAuthor(payload)) return;
    if (event.bot_id || event.user === identity.botUserId) return;
    if (event.subtype && event.subtype !== "file_share") return;
    if (!event.user || !event.channel || !event.ts || typeof event.text !== "string") return;

    const message = this.toChannelMessage(payload, identity);
    if (!message) return;
    const user = event.user;
    const previous = this.deliveries.get(message.chatId) ?? Promise.resolve();
    const next = previous.then(() => this.deliver(message, identity.teamId, user));
    this.deliveries.set(message.chatId, next);
    void next.finally(() => {
      if (this.deliveries.get(message.chatId) === next) {
        this.deliveries.delete(message.chatId);
      }
    });
  }

  private toChannelMessage(
    payload: SlackEventCallback,
    identity: SlackBotIdentity,
  ): ChannelMessage | null {
    const event = payload.event;
    const channel = event.channel!;
    const ts = event.ts!;
    const text = decodeSlackText(event.text!, identity.botUserId);
    if (!text) return null;
    const base = {
      channel: this.config.channel,
      direction: "inbound" as const,
      messageId: ts,
      senderId: slackSenderId(payload.team_id, event.user!),
      text,
      attachments: [],
      timestamp: new Date(Number.parseFloat(ts) * 1_000),
      raw: payload,
    };
    if (event.type === "message" && event.channel_type === "im") {
      return {
        ...base,
        chatId: channel as ChatId,
        ...(event.thread_ts ? { replyTo: { messageId: event.thread_ts } } : {}),
        thread: { kind: "dm" },
        addressing: "direct",
      };
    }
    if (event.type === "app_mention" && event.channel_type !== "im" && !channel.startsWith("D")) {
      const rootTs = event.thread_ts ?? ts;
      return {
        ...base,
        chatId: slackThreadChatId(channel, rootTs),
        parentChatId: channel as ChatId,
        ...(event.thread_ts ? { replyTo: { messageId: event.thread_ts } } : {}),
        thread: { kind: "topic" },
        addressing: "mention",
      };
    }
    return null;
  }

  private async deliver(message: ChannelMessage, teamId: string, userId: string): Promise<void> {
    const name = await this.lookUpName(teamId, userId);
    const named: ChannelMessage = {
      ...message,
      ...(name.displayName ? { senderDisplayName: name.displayName } : {}),
      ...(name.username ? { senderUsername: name.username } : {}),
    };
    log.info("message received", {
      chatId: named.chatId,
      threadKind: named.thread?.kind,
    });
    try {
      await this.handler?.(named);
    } catch (error) {
      log.error("message handler error", { messageId: named.messageId, error: describe(error) });
    }
  }

  /** A member's name, best effort: a failed lookup leaves the message
   *  unnamed rather than holding it. */
  private async lookUpName(teamId: string, userId: string): Promise<SlackUserName> {
    const key = slackSenderId(teamId, userId);
    const cached = this.userNames.get(key);
    if (cached) return cached;
    try {
      const name = await this.api.userName(this.config.botToken, userId, this.sendAbort.signal);
      if (this.userNames.size >= SLACK_USER_NAME_CACHE_SIZE) {
        const oldest = this.userNames.keys().next().value;
        if (oldest !== undefined) this.userNames.delete(oldest);
      }
      this.userNames.set(key, name);
      return name;
    } catch (error) {
      log.warn("slack user lookup failed", { error: describe(error) });
      return {};
    }
  }
}
