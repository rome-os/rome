// The Slack Web API calls Rome's own Slack app makes, sent to the Slack gateway
// Worker, which holds the workspace's bot token and makes the call at Slack
// for a workspace bound to this instance (rome-cloud docs/slack-gateway.md).
// The instance never holds the token. Errors are `SlackApiError` from
// `kinds/slack/slack.ts`, so `isSlackCredentialError` reads them.

import { cloudBearer } from "../../../instance/instance-identity.js";
import { SlackApiError, type SlackUserName } from "../slack/slack.js";
import type { SlackWireMessage } from "./message.js";
import { SlackTooSoonError } from "./read-gate.js";

const SLACK_API_TIMEOUT_MS = 15_000;
const SLACK_RATE_LIMIT_MAX_WAIT_MS = 30_000;

/** The Worker's header naming the workspace a call is made in. */
export const SLACK_TEAM_HEADER = "x-slack-team";

/** Every call names the workspace by its team id. */
export interface SlackAppWebApi {
  postMessage(
    teamId: string,
    input: { channel: string; markdown: string; threadTs?: string },
    signal?: AbortSignal,
  ): Promise<{ ts: string }>;
  openDirectMessage(teamId: string, userId: string, signal?: AbortSignal): Promise<string>;
  userName(teamId: string, userId: string, signal?: AbortSignal): Promise<SlackUserName>;
  /** One page of a conversation's history, newest first: at most `limit`
   *  messages before `latest` (exclusive), or the newest. */
  conversationHistory(
    teamId: string,
    input: { channel: string; latest?: string; limit: number },
    signal?: AbortSignal,
  ): Promise<{ messages: SlackWireMessage[]; hasMore: boolean }>;
  /** One page of a thread's messages, oldest first, its root included: at
   *  most `limit` after `cursor`, or from the start. */
  conversationReplies(
    teamId: string,
    input: { channel: string; ts: string; cursor?: string; oldest?: string; limit: number },
    signal?: AbortSignal,
  ): Promise<{ messages: SlackWireMessage[]; nextCursor?: string }>;
  /** One page of the channels the app is a member of, public and private. */
  memberChannels(
    teamId: string,
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

/** A refusal the Worker made itself, as the connection reads it: an instance
 *  it does not take, or a workspace no longer bound to this instance, is a
 *  credential Rome no longer holds. */
function workerRefusal(status: number, error: string | undefined): SlackApiError {
  if (status === 401)
    return new SlackApiError("not_authed", "Rome Cloud did not accept this Rome.");
  if (error === "not_bound") {
    return new SlackApiError(
      "app_uninstalled",
      "Rome Cloud no longer holds this Slack workspace for this Rome.",
    );
  }
  return new SlackApiError(error ?? `http_${status}`, `Rome's Slack service answered ${status}.`);
}

/**
 * A Slack Web API client that sends each call to the Slack gateway Worker at
 * `workerOrigin`, such as `https://slack.romeos.io`, signed with the
 * instance's token. `bearer` defaults to that token.
 */
export function createSlackAppWebApi(
  workerOrigin: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  bearer: () => Promise<string | null> = cloudBearer,
): SlackAppWebApi {
  const origin = new URL(workerOrigin).origin;

  async function send(
    teamId: string,
    method: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const token = await bearer();
    if (!token) {
      throw new SlackApiError(
        "not_authed",
        "Rome's Slack app needs this Rome linked to Rome Cloud. Link it in Settings.",
      );
    }
    return fetchImpl(`${origin}/v1/slack/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        [SLACK_TEAM_HEADER]: teamId,
      },
      body: JSON.stringify(args),
      signal: timeout(signal),
    });
  }

  /** A call that changes something: one wait Slack asks for is waited out. */
  async function call(
    teamId: string,
    method: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<SlackApiResponse> {
    let retried = false;
    for (;;) {
      const response = await send(teamId, method, args, signal);
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

  /** A read: the read gate waits out a refusal as too soon, within the
   *  read's limit. */
  async function get(
    teamId: string,
    method: string,
    args: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<SlackApiResponse> {
    const response = await send(teamId, method, args, signal);
    if (response.status === 429) {
      await response.body?.cancel().catch(() => {});
      throw new SlackTooSoonError(retryAfterMs(response));
    }
    return read(response);
  }

  async function read(response: Response): Promise<SlackApiResponse> {
    const result = (await response.json().catch(() => null)) as SlackApiResponse | null;
    if (!response.ok) {
      if (response.status === 429) throw new SlackApiError("ratelimited");
      throw workerRefusal(
        response.status,
        typeof result?.error === "string" ? result.error : undefined,
      );
    }
    if (!result?.ok) throw new SlackApiError(result?.error ?? "unknown_error");
    return result;
  }

  return {
    async postMessage(teamId, input, signal) {
      const result = await call(
        teamId,
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
    async openDirectMessage(teamId, userId, signal) {
      const result = await call(teamId, "conversations.open", { users: userId }, signal);
      const id = stringField((result.channel as { id?: unknown } | undefined)?.id);
      if (!id) throw new SlackApiError("missing_channel", "Slack did not open a direct message.");
      return id;
    },
    async userName(teamId, userId, signal) {
      const body = await get(teamId, "users.info", { user: userId }, signal);
      const user = body.user as
        | { name?: unknown; real_name?: unknown; profile?: { display_name?: unknown } }
        | undefined;
      return {
        displayName: stringField(user?.profile?.display_name) ?? stringField(user?.real_name),
        username: stringField(user?.name),
      };
    },
    async conversationHistory(teamId, input, signal) {
      const body = await get(
        teamId,
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
    async conversationReplies(teamId, input, signal) {
      const body = await get(
        teamId,
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
    async memberChannels(teamId, input, signal) {
      const body = await get(
        teamId,
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
