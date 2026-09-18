import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ConversationId, InboundMessage, OutgoingMessage } from "@rome-os/app-runtime";
import { createLogger } from "../logger.js";
import { InMemoryInboundDedup, type InboundDedup } from "./inbound-dedup.js";

const log = createLogger("slack");
const SLACK_SIGNATURE_VERSION = "v0";
const SIGNATURE_MAX_AGE_SECONDS = 5 * 60;
const SLACK_TEXT_CHUNK_LENGTH = 4_000;
export const SLACK_GUARDIAN_LINK_TTL_MS = 5 * 60_000;
export const SLACK_GUARDIAN_LINK_MAX_FAILED_ATTEMPTS = 5;

export const SLACK_REQUIRED_BOT_SCOPES = ["app_mentions:read", "chat:write", "im:history"] as const;

export interface SlackEventEnvelope {
  type: "event_callback";
  event_id: string;
  event_time?: number;
  team_id: string;
  event: SlackEvent;
}

export interface SlackEvent {
  type: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
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
  private readonly inFlight = new Map<string, Promise<"delivered" | "duplicate">>();
  private readonly dedup: InboundDedup;

  constructor(
    private readonly signingSecret?: string,
    options: { dedup?: InboundDedup } = {},
  ) {
    this.dedup = options.dedup ?? new InMemoryInboundDedup(10_000);
  }

  get configured(): boolean {
    return typeof this.signingSecret === "string" && this.signingSecret.length > 0;
  }

  verifyRequest(
    rawBody: string | Uint8Array,
    headers: { timestamp?: string; signature?: string },
    now = Date.now(),
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

  /** Dispatch one already-authenticated Events API envelope. */
  async dispatch(envelope: SlackEventEnvelope): Promise<"delivered" | "duplicate" | "unhandled"> {
    // Concurrent retries share the first delivery. If that delivery fails they
    // all fail, leaving the id unrecorded so Slack can retry it later.
    const pending = this.inFlight.get(envelope.event_id);
    if (pending) {
      await pending;
      return "duplicate";
    }

    const handlers = this.handlers.get(envelope.team_id);
    if (!handlers || handlers.length === 0) return "unhandled";

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
  ): Promise<"delivered" | "duplicate"> {
    if (await this.dedup.has(envelope.event_id)) return "duplicate";
    for (const handler of handlers) {
      if ((await handler(envelope)) === true) break;
    }
    // Record only after the complete handler chain succeeds. A throw leaves the
    // event retryable rather than turning Slack's retry into a silent duplicate.
    await this.dedup.record(envelope.event_id);
    return "delivered";
  }
}

export interface SlackBotIdentity {
  teamId: string;
  workspaceName?: string;
  botUserId: string;
  botUsername?: string;
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
}

async function slackApiCall(
  token: string,
  method: string,
  body: Record<string, string> | undefined,
  signal?: AbortSignal,
): Promise<SlackApiResponse> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!response.ok) throw new Error(`Slack API returned HTTP ${response.status}`);
  const result = (await response.json()) as SlackApiResponse;
  if (!result.ok) throw new SlackApiError(result.error ?? "unknown_error");
  return result;
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
    };
  },
  async postMessage(token, input) {
    const result = await slackApiCall(token, "chat.postMessage", {
      channel: input.channel,
      text: input.text,
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
  return text.replace(new RegExp(`<@${escapeRegex(botUserId)}>`, "g"), "").trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slackTimestamp(ts: string): Date {
  return new Date(Number.parseFloat(ts) * 1_000);
}

function splitSlackText(text: string): string[] {
  if (text.length <= SLACK_TEXT_CHUNK_LENGTH) return [text];
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += SLACK_TEXT_CHUNK_LENGTH) {
    chunks.push(text.slice(offset, offset + SLACK_TEXT_CHUNK_LENGTH));
  }
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
      onCredentialFault?: (cause: unknown) => void;
    },
  ) {}

  onMessage(handler: (message: InboundMessage) => void): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    const api = this.config.api ?? slackWebApi;
    const generation = ++this.startGeneration;
    this.startAbort?.abort();
    this.unsubscribe?.();
    this.unsubscribe = null;
    const controller = new AbortController();
    this.startAbort = controller;
    let identity: SlackBotIdentity;
    try {
      identity = await api.authTest(this.config.botToken, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      throw error;
    }
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
    if (!message.text) {
      if (omittedAttachments > 0 || omittedParts > 0) {
        throw new Error("Slack bot conversations support text output only.");
      }
      return {};
    }
    const api = this.config.api ?? slackWebApi;
    const { channelId, threadTs } = parseSlackConversationId(conversationId);
    let firstTs: string | undefined;
    try {
      for (const text of splitSlackText(message.text)) {
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

    if (event.type === "app_uninstalled" || event.type === "tokens_revoked") {
      this.config.onCredentialFault?.(new SlackApiError(event.type));
      return true;
    }

    if (event.bot_id || event.subtype || event.user === identity.botUserId) return true;
    if (!event.user || !event.channel || !event.ts || typeof event.text !== "string") return true;

    let message: InboundMessage | null = null;
    if (event.type === "message" && event.channel_type === "im") {
      const text = event.text.trim();
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
  return `ROME-LINK-${randomBytes(6).toString("base64url").toUpperCase()}`;
}

function isSlackGuardianLinkAttempt(text: string): boolean {
  return /^ROME-LINK-[A-Z0-9_-]{4,32}$/i.test(text.trim());
}

export function isSlackGuardianLinkEvent(
  envelope: SlackEventEnvelope,
  code: string,
  botUserId: string,
): envelope is SlackEventEnvelope & { event: Required<Pick<SlackEvent, "user" | "text">> } {
  const event = envelope.event;
  return (
    event.type === "message" &&
    event.channel_type === "im" &&
    !event.bot_id &&
    !event.subtype &&
    typeof event.user === "string" &&
    event.user !== botUserId &&
    typeof event.text === "string" &&
    event.text.trim() === code
  );
}

export function waitForSlackGuardianLink(
  ingress: SlackIngress,
  identity: SlackBotIdentity,
  code: string,
  signal: AbortSignal,
  options: { expiresInMs?: number; maxFailedAttempts?: number } = {},
): Promise<{ channelUserId: string }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Setup cancelled."));
      return;
    }
    let unregister = () => {};
    let failedAttempts = 0;
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
        if (isSlackGuardianLinkEvent(envelope, code, identity.botUserId)) {
          finish({ channelUserId: slackChannelUserId(identity.teamId, envelope.event.user) });
          return true;
        }
        const event = envelope.event;
        if (
          event.type !== "message" ||
          event.channel_type !== "im" ||
          event.bot_id ||
          event.subtype ||
          event.user === identity.botUserId ||
          typeof event.text !== "string" ||
          !isSlackGuardianLinkAttempt(event.text)
        ) {
          return false;
        }
        failedAttempts++;
        if (
          failedAttempts >= (options.maxFailedAttempts ?? SLACK_GUARDIAN_LINK_MAX_FAILED_ATTEMPTS)
        ) {
          finish(
            new Error(
              "Too many incorrect Slack guardian-link attempts. Retry to generate a new code.",
            ),
          );
        }
        // Link-looking messages are setup credentials, not agent requests.
        return true;
      },
      { first: true },
    );
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
