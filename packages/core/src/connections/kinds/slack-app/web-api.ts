// The Slack Web API calls Rome's own Slack app makes from the instance, against
// a configurable Slack origin so a test environment can stand in for Slack.
// Errors are `SlackApiError` from `kinds/slack/slack.ts`, so
// `isSlackCredentialError` reads them.

import { SlackApiError, type SlackBotIdentity, type SlackUserName } from "../slack/slack.js";
import type { SlackWireMessage } from "./message.js";
import { SlackTooSoonError } from "./read-gate.js";

const SLACK_API_TIMEOUT_MS = 15_000;
const SLACK_RATE_LIMIT_MAX_WAIT_MS = 30_000;
/** Slack's answers for a token it no longer takes. */
const ALREADY_REFUSED = new Set([
  "invalid_auth",
  "token_revoked",
  "account_inactive",
  "not_authed",
  "app_uninstalled",
]);

export interface SlackAppWebApi {
  authTest(botToken: string, signal?: AbortSignal): Promise<SlackBotIdentity>;
  postMessage(
    botToken: string,
    input: { channel: string; markdown: string; threadTs?: string },
    signal?: AbortSignal,
  ): Promise<{ ts: string }>;
  openDirectMessage(botToken: string, userId: string, signal?: AbortSignal): Promise<string>;
  userName(botToken: string, userId: string, signal?: AbortSignal): Promise<SlackUserName>;
  /** Revoke the bot token, so Slack refuses it from then on. A token Slack
   *  already refuses counts as revoked. */
  revoke(botToken: string, signal?: AbortSignal): Promise<void>;
  /** One page of a conversation's history, newest first: at most `limit`
   *  messages before `latest` (exclusive), or the newest. */
  conversationHistory(
    botToken: string,
    input: { channel: string; latest?: string; limit: number },
    signal?: AbortSignal,
  ): Promise<{ messages: SlackWireMessage[]; hasMore: boolean }>;
  /** One page of a thread's messages, oldest first, its root included: at
   *  most `limit` after `cursor`, or from the start. */
  conversationReplies(
    botToken: string,
    input: { channel: string; ts: string; cursor?: string; oldest?: string; limit: number },
    signal?: AbortSignal,
  ): Promise<{ messages: SlackWireMessage[]; nextCursor?: string }>;
  /** One page of the channels the app is a member of, public and private. */
  memberChannels(
    botToken: string,
    input: { cursor?: string; limit: number },
    signal?: AbortSignal,
  ): Promise<{ channels: SlackChannel[]; nextCursor?: string }>;
}

/** A channel the app is a member of, as Slack names it. */
export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
}

interface SlackApiResponse {
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function timeout(signal?: AbortSignal): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(SLACK_API_TIMEOUT_MS)])
    : AbortSignal.timeout(SLACK_API_TIMEOUT_MS);
}

/** How long Slack asked Rome to wait, at least a second. */
function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get("retry-after") ?? "1");
  return Math.max(1_000, Number.isFinite(seconds) ? seconds * 1_000 : 1_000);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** A Slack Web API client rooted at `baseUrl`, such as `https://slack.com`. */
export function createSlackAppWebApi(
  baseUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): SlackAppWebApi {
  const origin = new URL(baseUrl).origin;

  async function call(
    token: string,
    method: string,
    body: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<SlackApiResponse> {
    let retried = false;
    for (;;) {
      const response = await fetchImpl(`${origin}/api/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body ?? {}),
        signal: timeout(signal),
      });
      if (response.status === 429 && !retried) {
        await response.body?.cancel().catch(() => {});
        retried = true;
        const waitMs = retryAfterMs(response);
        if (waitMs > SLACK_RATE_LIMIT_MAX_WAIT_MS) {
          throw new SlackApiError("ratelimited", `Slack asked Rome to wait ${waitMs}ms.`);
        }
        await delay(waitMs, signal);
        continue;
      }
      return read(response);
    }
  }

  async function get(
    token: string,
    method: string,
    query: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<SlackApiResponse> {
    const response = await fetchImpl(
      `${origin}/api/${method}?${new URLSearchParams(query).toString()}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: timeout(signal) },
    );
    // The read gate waits out a refusal as too soon, within the read's limit.
    if (response.status === 429) {
      await response.body?.cancel().catch(() => {});
      throw new SlackTooSoonError(retryAfterMs(response));
    }
    return read(response);
  }

  async function read(response: Response): Promise<SlackApiResponse> {
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

  return {
    async authTest(botToken, signal) {
      const result = await call(botToken, "auth.test", undefined, signal);
      const teamId = stringField(result.team_id);
      const botUserId = stringField(result.user_id);
      if (!teamId || !botUserId) {
        throw new SlackApiError(
          "invalid_auth_test",
          "Slack did not return a workspace and bot id.",
        );
      }
      return {
        teamId,
        workspaceName: stringField(result.team),
        botUserId,
        botUsername: stringField(result.user),
        appId: stringField(result.app_id),
      };
    },
    async postMessage(botToken, input, signal) {
      const result = await call(
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
      const result = await call(botToken, "conversations.open", { users: userId }, signal);
      const id = stringField((result.channel as { id?: unknown } | undefined)?.id);
      if (!id) throw new SlackApiError("missing_channel", "Slack did not open a direct message.");
      return id;
    },
    async userName(botToken, userId, signal) {
      const body = await get(botToken, "users.info", { user: userId }, signal);
      const user = body.user as
        | { name?: unknown; real_name?: unknown; profile?: { display_name?: unknown } }
        | undefined;
      return {
        displayName: stringField(user?.profile?.display_name) ?? stringField(user?.real_name),
        username: stringField(user?.name),
      };
    },
    async revoke(botToken, signal) {
      try {
        await call(botToken, "auth.revoke", undefined, signal);
      } catch (error) {
        if (error instanceof SlackApiError && ALREADY_REFUSED.has(error.code)) return;
        throw error;
      }
    },
    async conversationHistory(botToken, input, signal) {
      const body = await get(
        botToken,
        "conversations.history",
        {
          channel: input.channel,
          limit: String(input.limit),
          ...(input.latest ? { latest: input.latest } : {}),
        },
        signal,
      );
      const messages = Array.isArray(body.messages) ? body.messages : [];
      return {
        messages: messages.filter(
          (message): message is SlackWireMessage =>
            typeof message === "object" &&
            message !== null &&
            typeof (message as { ts?: unknown }).ts === "string",
        ),
        hasMore: body.has_more === true,
      };
    },
    async conversationReplies(botToken, input, signal) {
      const body = await get(
        botToken,
        "conversations.replies",
        {
          channel: input.channel,
          ts: input.ts,
          limit: String(input.limit),
          ...(input.cursor ? { cursor: input.cursor } : {}),
          ...(input.oldest ? { oldest: input.oldest } : {}),
        },
        signal,
      );
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const nextCursor = stringField(
        (body.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor,
      );
      return {
        messages: messages.filter(
          (message): message is SlackWireMessage =>
            typeof message === "object" &&
            message !== null &&
            typeof (message as { ts?: unknown }).ts === "string",
        ),
        ...(nextCursor ? { nextCursor } : {}),
      };
    },
    async memberChannels(botToken, input, signal) {
      const body = await get(
        botToken,
        "users.conversations",
        {
          types: "public_channel,private_channel",
          exclude_archived: "true",
          limit: String(input.limit),
          ...(input.cursor ? { cursor: input.cursor } : {}),
        },
        signal,
      );
      const listed = Array.isArray(body.channels) ? body.channels : [];
      const channels: SlackChannel[] = [];
      for (const each of listed) {
        const channel = each as { id?: unknown; name?: unknown; is_private?: unknown };
        const id = stringField(channel.id);
        const name = stringField(channel.name);
        if (id && name) channels.push({ id, name, isPrivate: channel.is_private === true });
      }
      const nextCursor = stringField(
        (body.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor,
      );
      return { channels, ...(nextCursor ? { nextCursor } : {}) };
    },
  };
}
