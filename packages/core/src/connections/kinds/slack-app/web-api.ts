// The Slack Web API calls Rome's own Slack app makes from the instance, against
// a configurable Slack origin so a test environment can stand in for Slack.
// Errors are the Slack bot kind's `SlackApiError`, so `isSlackCredentialError`
// reads them the same way.

import { SlackApiError, type SlackBotIdentity, type SlackUserName } from "../slack/slack.js";
import type { SlackWireMessage } from "./message.js";

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

/** A Slack user as the app reads them: their names, and whether they are a
 *  full member of the workspace, not a guest, a bot or someone from another
 *  workspace. */
export interface SlackAppUser extends SlackUserName {
  /** The workspace the user is a full member of, by Slack's own answer:
   *  absent for a guest, a bot, a deleted user and a stranger. */
  fullMemberOf?: string;
}

export interface SlackAppWebApi {
  authTest(botToken: string, signal?: AbortSignal): Promise<SlackBotIdentity>;
  postMessage(
    botToken: string,
    input: { channel: string; markdown: string; threadTs?: string },
    signal?: AbortSignal,
  ): Promise<{ ts: string }>;
  openDirectMessage(botToken: string, userId: string, signal?: AbortSignal): Promise<string>;
  userName(botToken: string, userId: string, signal?: AbortSignal): Promise<SlackAppUser>;
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
        const seconds = Number(response.headers.get("retry-after") ?? "1");
        const waitMs = Math.max(1_000, Number.isFinite(seconds) ? seconds * 1_000 : 1_000);
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
        | {
            name?: unknown;
            real_name?: unknown;
            profile?: { display_name?: unknown };
            is_bot?: unknown;
            is_restricted?: unknown;
            is_ultra_restricted?: unknown;
            is_stranger?: unknown;
            deleted?: unknown;
            team_id?: unknown;
          }
        | undefined;
      // A guest is restricted, a single-channel guest ultra restricted, and
      // someone from another workspace a stranger. Slack does not mark every
      // Slack Connect user a stranger, so the user's own workspace is kept
      // for the connection to compare with its own.
      const team = stringField(user?.team_id);
      const fullMember =
        user !== undefined &&
        team !== undefined &&
        user.is_bot !== true &&
        user.is_restricted !== true &&
        user.is_ultra_restricted !== true &&
        user.is_stranger !== true &&
        user.deleted !== true;
      return {
        displayName: stringField(user?.profile?.display_name) ?? stringField(user?.real_name),
        username: stringField(user?.name),
        ...(fullMember ? { fullMemberOf: team } : {}),
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
