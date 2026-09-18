import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ConversationId, InboundMessage, OutgoingMessage } from "@rome-os/app-runtime";
import { createLogger } from "../logger.js";
import { InMemoryInboundDedup, type DeferredInboundDedup } from "./inbound-dedup.js";

const log = createLogger("slack");
const SLACK_SIGNATURE_VERSION = "v0";
const SIGNATURE_MAX_AGE_SECONDS = 5 * 60;
const SLACK_TEXT_CHUNK_LENGTH = 4_000;
const SLACK_INITIAL_STARTUP_GRACE_MS = 30_000;
const SLACK_RATE_LIMIT_MAX_WAIT_MS = 30_000;
const SLACK_API_TIMEOUT_MS = 15_000;
export const SLACK_GUARDIAN_LINK_TTL_MS = 5 * 60_000;
export const SLACK_GUARDIAN_LINK_MAX_FAILED_ATTEMPTS = 5;

export const SLACK_REQUIRED_BOT_SCOPES = ["app_mentions:read", "chat:write", "im:history"] as const;

export interface SlackEventEnvelope {
  type: "event_callback";
  event_id: string;
  event_time?: number;
  team_id: string;
  api_app_id?: string;
  event: SlackEvent;
}

export interface SlackEvent {
  type: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  user_team?: string;
  source_team?: string;
  tokens?: { bot?: string[]; oauth?: string[] };
  text?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
}

export type SlackIngressHandler = (
  envelope: SlackEventEnvelope,
) => boolean | void | Promise<boolean | void>;

export interface SlackRequestVerification {
  ok: boolean;
  reason?: "not_configured" | "missing_headers" | "stale" | "bad_signature";
}

/**
 * Process-wide ingress for the one Slack application attached to an instance.
 * It authenticates Slack's raw HTTP request before JSON parsing, deduplicates
 * Events API retries, and dispatches only within the addressed workspace.
 */
export class SlackIngress {
  private readonly handlers = new Map<string, SlackIngressHandler[]>();
  private readonly inFlight = new Map<string, Promise<"delivered" | "duplicate" | "retry">>();
  private readonly dedup: DeferredInboundDedup;
  private readonly now: () => number;
  private readonly initialStartupDeadline: number;
  private pendingRegistrations = 0;

  constructor(
    private readonly signingSecret?: string,
    options: { dedup?: DeferredInboundDedup; now?: () => number; startupGraceMs?: number } = {},
  ) {
    this.dedup = options.dedup ?? new InMemoryInboundDedup(10_000);
    this.now = options.now ?? Date.now;
    this.initialStartupDeadline =
      this.now() + (options.startupGraceMs ?? SLACK_INITIAL_STARTUP_GRACE_MS);
  }

  get configured(): boolean {
    return typeof this.signingSecret === "string" && this.signingSecret.length > 0;
  }

  verifyRequest(
    rawBody: string | Uint8Array,
    headers: { timestamp?: string; signature?: string },
    now = this.now(),
  ): SlackRequestVerification {
    if (!this.signingSecret) return { ok: false, reason: "not_configured" };
    const timestamp = headers.timestamp?.trim();
    const signature = headers.signature?.trim();
    if (!timestamp || !signature) return { ok: false, reason: "missing_headers" };

    const timestampSeconds = /^\d+$/.test(timestamp) ? Number(timestamp) : Number.NaN;
    if (
      !Number.isFinite(timestampSeconds) ||
      Math.abs(Math.floor(now / 1_000) - timestampSeconds) > SIGNATURE_MAX_AGE_SECONDS
    ) {
      return { ok: false, reason: "stale" };
    }

    const digest = createHmac("sha256", this.signingSecret)
      .update(`${SLACK_SIGNATURE_VERSION}:${timestamp}:`)
      .update(rawBody)
      .digest("hex");
    const expected = `${SLACK_SIGNATURE_VERSION}=${digest}`;
    const expectedBytes = Buffer.from(expected);
    const actualBytes = Buffer.from(signature);
    if (
      expectedBytes.length !== actualBytes.length ||
      !timingSafeEqual(expectedBytes, actualBytes)
    ) {
      return { ok: false, reason: "bad_signature" };
    }
    return { ok: true };
  }

  subscribe(
    teamId: string,
    handler: SlackIngressHandler,
    options: { first?: boolean } = {},
  ): () => void {
    const teamHandlers = this.handlers.get(teamId) ?? [];
    this.handlers.set(
      teamId,
      options.first ? [handler, ...teamHandlers] : [...teamHandlers, handler],
    );
    return () => {
      const current = this.handlers.get(teamId);
      if (!current) return;
      const remaining = current.filter((candidate) => candidate !== handler);
      if (remaining.length > 0) this.handlers.set(teamId, remaining);
      else this.handlers.delete(teamId);
    };
  }

  /**
   * Mark the bounded window in which a Talk epoch is identifying its workspace
   * before it can subscribe. This process-wide ingress exists separately from
   * RuntimeKit.registerIngress because guardian verification must receive Slack
   * events before a grant (and therefore a connection-scoped runtime) exists.
   */
  beginHandlerRegistration(): () => void {
    this.pendingRegistrations++;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.pendingRegistrations--;
    };
  }

  /** Dispatch one already-authenticated Events API envelope. */
  async dispatch(
    envelope: SlackEventEnvelope,
  ): Promise<"delivered" | "duplicate" | "retry" | "starting" | "unhandled"> {
    // Concurrent retries share the first delivery. If that delivery fails they
    // all fail, leaving the id unrecorded so Slack can retry it later.
    const pending = this.inFlight.get(envelope.event_id);
    if (pending) {
      const result = await pending;
      return result === "retry" ? "retry" : "duplicate";
    }

    const handlers = this.handlers.get(envelope.team_id);
    if (!handlers || handlers.length === 0) {
      return this.pendingRegistrations > 0 || this.now() < this.initialStartupDeadline
        ? "starting"
        : "unhandled";
    }

    const delivery = this.dispatchOnce(envelope, [...handlers]);
    this.inFlight.set(envelope.event_id, delivery);
    try {
      return await delivery;
    } finally {
      if (this.inFlight.get(envelope.event_id) === delivery) {
        this.inFlight.delete(envelope.event_id);
      }
    }
  }

  private async dispatchOnce(
    envelope: SlackEventEnvelope,
    handlers: SlackIngressHandler[],
  ): Promise<"delivered" | "duplicate" | "retry"> {
    const reservation = await this.dedup.reserve(envelope.event_id);
    if (reservation.state === "complete") return "duplicate";
    if (reservation.state === "busy") return "retry";
    try {
      for (const handler of handlers) {
        if ((await handler(envelope)) === true) break;
      }
      // Record only after the registered ingress handlers accept the event. A
      // synchronous or awaited ingress throw leaves it retryable; downstream Talk
      // delivery is intentionally fire-and-forget under the Talker contract.
      await reservation.commit();
      return "delivered";
    } catch (error) {
      await reservation.release();
      throw error;
    }
  }
}

export interface SlackBotIdentity {
  teamId: string;
  workspaceName?: string;
  botUserId: string;
  botUsername?: string;
  appId?: string;
}

export interface SlackWebApi {
  authTest(token: string, signal?: AbortSignal): Promise<SlackBotIdentity>;
  postMessage(
    token: string,
    input: { channel: string; text: string; threadTs?: string },
  ): Promise<{ ts: string }>;
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

interface SlackApiResponse {
  ok?: boolean;
  error?: string;
  team_id?: string;
  team?: string;
  user_id?: string;
  user?: string;
  ts?: string;
  app_id?: string;
}

async function slackApiCall(
  token: string,
  method: string,
  body: Record<string, string | boolean> | undefined,
  signal?: AbortSignal,
): Promise<SlackApiResponse> {
  let retriedRateLimit = false;
  while (true) {
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
      retriedRateLimit = true;
      const retryAfterSeconds = Number(response.headers.get("retry-after") ?? "1");
      const waitMs = Math.min(
        SLACK_RATE_LIMIT_MAX_WAIT_MS,
        Math.max(0, Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1_000 : 1_000),
      );
      await abortableDelay(waitMs, signal);
      continue;
    }
    if (!response.ok) {
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

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export const slackWebApi: SlackWebApi = {
  async authTest(token, signal) {
    const result = await slackApiCall(token, "auth.test", undefined, signal);
    if (!result.team_id || !result.user_id) {
      throw new SlackApiError("invalid_auth_test", "Slack did not return a workspace and bot id.");
    }
    return {
      teamId: result.team_id,
      workspaceName: result.team,
      botUserId: result.user_id,
      botUsername: result.user,
      appId: result.app_id,
    };
  },
  async postMessage(token, input) {
    const result = await slackApiCall(token, "chat.postMessage", {
      channel: input.channel,
      text: input.text,
      mrkdwn: false,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    });
    if (!result.ts) throw new SlackApiError("missing_message_id");
    return { ts: result.ts };
  },
};

export function isSlackCredentialError(error: unknown): boolean {
  return (
    error instanceof SlackApiError &&
    [
      "account_inactive",
      "invalid_auth",
      "missing_scope",
      "not_authed",
      "token_expired",
      "token_revoked",
    ].includes(error.code)
  );
}

export function slackChannelUserId(teamId: string, userId: string): string {
  return `${teamId}/${userId}`;
}

export function slackThreadConversationId(channelId: string, threadTs: string): ConversationId {
  return `${channelId}:${threadTs}` as ConversationId;
}

export function parseSlackConversationId(conversationId: string): {
  channelId: string;
  threadTs?: string;
} {
  const separator = conversationId.indexOf(":");
  if (separator === -1) return { channelId: conversationId };
  return {
    channelId: conversationId.slice(0, separator),
    threadTs: conversationId.slice(separator + 1),
  };
}

export function stripSlackBotMention(text: string, botUserId: string): string {
  return decodeSlackText(
    text.replace(new RegExp(`<@${escapeRegex(botUserId)}(?:\\|[^>]+)?>`, "g"), ""),
  ).trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slackTimestamp(ts: string): Date {
  return new Date(Number.parseFloat(ts) * 1_000);
}

function decodeSlackText(text: string): string {
  return text.replace(/&(amp|lt|gt);/g, (_entity, name: string) => {
    if (name === "amp") return "&";
    if (name === "lt") return "<";
    return ">";
  });
}

function splitSlackText(text: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const codePoint of text) {
    const escaped =
      codePoint === "&"
        ? "&amp;"
        : codePoint === "<"
          ? "&lt;"
          : codePoint === ">"
            ? "&gt;"
            : codePoint;
    if (chunk && chunk.length + escaped.length > SLACK_TEXT_CHUNK_LENGTH) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += escaped;
  }
  if (chunk || chunks.length === 0) chunks.push(chunk);
  return chunks;
}

/** Text-only Slack adapter. HTTP ingress lifecycle is owned by SlackIngress. */
export class SlackAdapter {
  private handler?: (message: InboundMessage) => void;
  private unsubscribe: (() => void) | null = null;
  private identity: SlackBotIdentity | null = null;
  private startGeneration = 0;
  private startAbort: AbortController | null = null;

  constructor(
    private readonly config: {
      botToken: string;
      ingress: SlackIngress;
      api?: SlackWebApi;
      expectedAppId?: string;
      onCredentialFault?: (cause: unknown) => void;
      onTransportFault?: (cause: unknown) => void;
    },
  ) {}

  onMessage(handler: (message: InboundMessage) => void): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    const api = this.config.api ?? slackWebApi;
    const finishRegistration = this.config.ingress.beginHandlerRegistration();
    const generation = ++this.startGeneration;
    this.startAbort?.abort();
    this.unsubscribe?.();
    this.unsubscribe = null;
    const controller = new AbortController();
    this.startAbort = controller;
    try {
      const identity = await api.authTest(this.config.botToken, controller.signal);
      if (controller.signal.aborted || generation !== this.startGeneration) return;
      this.identity = identity;
      this.startAbort = null;
      this.unsubscribe = this.config.ingress.subscribe(identity.teamId, (envelope) =>
        this.handleEnvelope(envelope),
      );
      log.info("slack adapter started", {
        teamId: identity.teamId,
        botUserId: identity.botUserId,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      throw error;
    } finally {
      finishRegistration();
    }
  }

  stop(): void {
    this.startGeneration++;
    this.startAbort?.abort();
    this.startAbort = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.identity = null;
  }

  async send(conversationId: ConversationId, message: OutgoingMessage): Promise<{ ts?: string }> {
    const omittedAttachments = message.attachments?.length ?? 0;
    const omittedParts = message.parts?.length ?? 0;
    if (omittedAttachments > 0 || omittedParts > 0) {
      log.warn("slack omitted unsupported outbound content", {
        attachments: omittedAttachments,
        parts: omittedParts,
      });
    }
    const fallbackText = message.parts
      ?.map((part) => {
        if (part.type === "text") return part.content;
        if (part.type === "approval_card") {
          return `Rome needs your approval to run ${part.actionName}. Open Settings → Activity to review it.`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
    const outboundText = message.text?.trim() || fallbackText?.trim();
    if (!outboundText) return {};
    const api = this.config.api ?? slackWebApi;
    const { channelId, threadTs } = parseSlackConversationId(conversationId);
    let firstTs: string | undefined;
    try {
      for (const text of splitSlackText(outboundText)) {
        const sent = await api.postMessage(this.config.botToken, {
          channel: channelId,
          text,
          threadTs,
        });
        firstTs ??= sent.ts;
      }
      return { ts: firstTs };
    } catch (error) {
      log.warn("slack message send failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private handleEnvelope(envelope: SlackEventEnvelope): boolean {
    const identity = this.identity;
    const event = envelope.event;
    if (!identity || !this.handler) return false;

    if (
      this.config.expectedAppId &&
      envelope.api_app_id &&
      envelope.api_app_id !== this.config.expectedAppId
    ) {
      const error = new Error(
        `Slack event app ${envelope.api_app_id} does not match connected app ${this.config.expectedAppId}.`,
      );
      log.error("slack event app mismatch", {
        expectedAppId: this.config.expectedAppId,
        receivedAppId: envelope.api_app_id,
      });
      this.config.onTransportFault?.(error);
      return true;
    }

    if (event.type === "app_uninstalled") {
      this.config.onCredentialFault?.(new SlackApiError(event.type));
      return true;
    }
    if (event.type === "tokens_revoked") {
      if (event.tokens?.bot && event.tokens.bot.length > 0) {
        this.config.onCredentialFault?.(new SlackApiError(event.type));
      }
      return true;
    }

    // Slack user ids are workspace-scoped. Never map a Slack Connect author
    // under the host workspace identity, where an id collision could inherit a
    // local member's pairing or guardian admission.
    if (
      (event.user_team && event.user_team !== envelope.team_id) ||
      (event.source_team && event.source_team !== envelope.team_id)
    )
      return true;

    if (
      event.bot_id ||
      (event.subtype && event.subtype !== "file_share") ||
      event.user === identity.botUserId
    )
      return true;
    if (!event.user || !event.channel || !event.ts || typeof event.text !== "string") return true;

    let message: InboundMessage | null = null;
    if (event.type === "message" && event.channel_type === "im") {
      const text = decodeSlackText(event.text).trim();
      if (!text) return true;
      message = {
        messageId: event.ts,
        conversationId: event.channel as ConversationId,
        senderId: slackChannelUserId(envelope.team_id, event.user),
        text,
        attachments: [],
        timestamp: slackTimestamp(event.ts),
        thread: { kind: "dm" },
        addressing: "direct",
        raw: envelope,
      };
    } else if (event.type === "app_mention") {
      const text = stripSlackBotMention(event.text, identity.botUserId);
      if (!text) return true;
      const rootTs = event.thread_ts ?? event.ts;
      message = {
        messageId: event.ts,
        conversationId: slackThreadConversationId(event.channel, rootTs),
        parentConversationId: event.channel as ConversationId,
        senderId: slackChannelUserId(envelope.team_id, event.user),
        text,
        attachments: [],
        timestamp: slackTimestamp(event.ts),
        ...(event.thread_ts ? { replyTo: { messageId: event.thread_ts } } : {}),
        thread: { kind: "topic" },
        addressing: "mention",
        raw: envelope,
      };
    }

    if (message) {
      this.handler(message);
      return true;
    }
    return false;
  }
}

export function generateSlackGuardianLinkCode(): string {
  return `ROME-LINK-${randomBytes(6).toString("hex").toUpperCase()}`;
}

function isSlackGuardianLinkAttempt(text: string): boolean {
  return /^ROME-LINK-[A-Z0-9_-]{4,32}$/i.test(text.trim());
}

export function isSlackGuardianLinkEvent(
  envelope: SlackEventEnvelope,
  code: string,
  botUserId: string,
  expectedAppId?: string,
): envelope is SlackEventEnvelope & { event: Required<Pick<SlackEvent, "user" | "text">> } {
  const event = envelope.event;
  return (
    event.type === "message" &&
    (!expectedAppId || !envelope.api_app_id || envelope.api_app_id === expectedAppId) &&
    event.channel_type === "im" &&
    !event.bot_id &&
    !event.subtype &&
    typeof event.user === "string" &&
    event.user !== botUserId &&
    typeof event.text === "string" &&
    event.text.trim().toUpperCase() === code.toUpperCase()
  );
}

export function waitForSlackGuardianLink(
  ingress: SlackIngress,
  identity: SlackBotIdentity,
  code: string,
  signal: AbortSignal,
  options: { expiresInMs?: number; maxFailedAttempts?: number; expectedAppId?: string } = {},
): Promise<{ channelUserId: string }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Setup cancelled."));
      return;
    }
    let unregister = () => {};
    const failedAttempts = new Map<string, number>();
    const lockedSenders = new Set<string>();
    let settled = false;
    const finish = (outcome: { channelUserId: string } | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(expiry);
      signal.removeEventListener("abort", onAbort);
      unregister();
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    const onAbort = () => {
      finish(signal.reason instanceof Error ? signal.reason : new Error("Setup cancelled."));
    };
    const expiry = setTimeout(
      () => finish(new Error("Slack guardian-link code expired. Retry to generate a new code.")),
      options.expiresInMs ?? SLACK_GUARDIAN_LINK_TTL_MS,
    );
    unregister = ingress.subscribe(
      identity.teamId,
      (envelope) => {
        const event = envelope.event;
        const sender = typeof event.user === "string" ? event.user : null;
        if (
          options.expectedAppId &&
          envelope.api_app_id &&
          envelope.api_app_id !== options.expectedAppId &&
          typeof event.text === "string" &&
          event.text.trim().toUpperCase() === code.toUpperCase()
        ) {
          finish(
            new Error(
              "Slack sent the guardian code from a different app. Check the OAuth app and signing-secret configuration.",
            ),
          );
          return true;
        }
        if (
          sender &&
          !lockedSenders.has(sender) &&
          isSlackGuardianLinkEvent(envelope, code, identity.botUserId, options.expectedAppId)
        ) {
          finish({ channelUserId: slackChannelUserId(identity.teamId, envelope.event.user) });
          return true;
        }
        if (
          event.type !== "message" ||
          event.channel_type !== "im" ||
          event.bot_id ||
          event.subtype ||
          !sender ||
          event.user === identity.botUserId ||
          typeof event.text !== "string" ||
          !isSlackGuardianLinkAttempt(event.text)
        ) {
          return false;
        }
        if (lockedSenders.has(sender)) return true;
        const attempts = (failedAttempts.get(sender) ?? 0) + 1;
        failedAttempts.set(sender, attempts);
        if (attempts >= (options.maxFailedAttempts ?? SLACK_GUARDIAN_LINK_MAX_FAILED_ATTEMPTS)) {
          lockedSenders.add(sender);
        }
        // Link-looking messages are setup credentials, not agent requests.
        return true;
      },
      { first: true },
    );
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
