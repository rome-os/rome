import type { Account, ChannelMessage, ChannelsService, ChatId } from "@rome-os/app-runtime";

/**
 * Slack's Web API methods, answered through Rome's own Slack app connection
 * instead of a token. The connection keeps its token to itself, so this app
 * never holds one: it hands each call to the channels service, which sends,
 * reads and searches as the connection's account. Only the methods below are
 * offered; any other is refused, naming them.
 */

/** What an agent is told when no Slack connection answers. */
export const SLACK_APP_CONNECT_HINT =
  "Slack is connected by Rome itself, not by this app. Ask the guardian to connect Rome's Slack app in Settings → Connections, then retry.";

/** What a call that named no Slack connection says when both are connected. */
export const SLACK_BOTH_ON_APP =
  'Both Slack connections are connected: this call went through Rome\'s Slack app, which replaces the Slack sign-in. Pass via: "sign_in" to make it through the sign-in instead.';

/** What a call that asked for the Slack sign-in says when there is none. */
export const SLACK_NO_SIGN_IN =
  'The Slack sign-in is not connected. Omit via, or pass via: "app", to go through Rome\'s Slack app.';

const OFFERED =
  "It offers chat.postMessage (send), conversations.history (read) and search.messages (search over what Rome has kept of the app's direct messages and mentions).";

/** What a call that takes the Slack app says while the app's connection
 *  names no account yet, such as while it is locked. */
export const SLACK_APP_NOT_READY =
  "Rome's Slack app is connected but cannot make calls now: its connection reports no Slack account yet. Ask the guardian to check it in Settings → Connections, then retry.";

/** Rome's Slack app connection, with the Slack account it is, or null when
 *  none is connected. It is the Slack channel that searches: the Slack bot
 *  connection, also on Slack, does not. A host declares that whether or not
 *  the connection is locked, so a locked app is still found here, with no
 *  account when it names none. */
export async function slackAppConnection(
  channels: ChannelsService,
): Promise<{ account: Account | null } | null> {
  const summaries = await channels.list();
  const app = summaries.find(
    (summary) => summary.platform === "slack" && summary.searchable === true,
  );
  return app ? { account: app.account ?? null } : null;
}

export type SlackAppProxyResult =
  | { status: "ok"; data: { status: number; data: unknown; headers: Record<string, string> } }
  | { status: "error"; error: string };

type Args = Record<string, unknown>;

/** The method a Slack Web API path names: `/api/chat.postMessage` names
 *  `chat.postMessage`. */
function methodOf(path: string): string {
  return path.replace(/^\/api\//, "").replace(/\/+$/, "");
}

function stringArg(args: Args, name: string): string | undefined {
  const value = args[name];
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number") return String(value);
  return undefined;
}

function numberArg(args: Args, name: string): number | undefined {
  const value = args[name];
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

/** A Slack `ts`, `<seconds>.<micros>`, as an instant. */
function instantOf(ts: string): Date | undefined {
  const seconds = Number(ts);
  return Number.isFinite(seconds) ? new Date(seconds * 1_000) : undefined;
}

/** A Slack `ts` in microseconds, exact where a Date keeps only
 *  milliseconds, or undefined when it is not one. */
function microsOf(ts: string | undefined): bigint | undefined {
  const match = ts?.match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if (!match) return undefined;
  return BigInt(match[1] ?? "0") * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}

/** The message's own `ts`: a reply's id names its thread first. */
function tsOf(messageId: string | undefined): string | undefined {
  return messageId?.slice(messageId.lastIndexOf(":") + 1);
}

/** A message as Slack's own answers spell it, in the fields Rome knows. */
function wireOf(message: ChannelMessage) {
  const ts = tsOf(message.messageId);
  const threadTs = message.replyTo?.messageId;
  const user = message.senderId.slice(message.senderId.indexOf("/") + 1);
  return {
    type: "message",
    ts,
    user,
    text: message.text,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    ...(message.senderDisplayName ? { user_name: message.senderDisplayName } : {}),
    ...(message.direction === "outbound" ? { from_rome: true } : {}),
  };
}

/** The HTTP verbs each offered method takes, as Slack's own Web API takes
 *  them: a send only by POST, a read or a search by GET or POST. */
const VERBS: Record<string, readonly string[]> = {
  "chat.postMessage": ["POST"],
  "conversations.history": ["GET", "POST"],
  "search.messages": ["GET", "POST"],
};

function ok(data: Record<string, unknown>): SlackAppProxyResult {
  return { status: "ok", data: { status: 200, data: { ok: true, ...data }, headers: {} } };
}

function refused(error: string): SlackAppProxyResult {
  return { status: "error", error };
}

/**
 * Answer one Slack Web API call as Rome's Slack app account. Arguments are read
 * from the body and the query alike, as Slack reads them.
 */
export async function slackAppProxyCall(params: {
  channels: ChannelsService;
  account: Account;
  /** The HTTP verb the call names. Absent, the method's own verb. */
  method?: string;
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean>;
}): Promise<SlackAppProxyResult> {
  const method = methodOf(params.path);
  const args: Args = {
    ...(params.query ?? {}),
    ...(params.body && typeof params.body === "object" ? (params.body as Args) : {}),
  };
  const { channels, account } = params;
  const verbs = VERBS[method];
  const verb = params.method?.toUpperCase();
  if (verbs && verb !== undefined && !verbs.includes(verb)) {
    return refused(
      `Slack "${method}" takes ${verbs.join(" or ")}, not ${verb}. Nothing was sent or read.`,
    );
  }
  try {
    switch (method) {
      case "chat.postMessage": {
        const channel = stringArg(args, "channel");
        const text = stringArg(args, "text") ?? stringArg(args, "markdown_text");
        if (!channel || !text) {
          return refused(
            'Slack "chat.postMessage" on Rome\'s Slack app takes "channel" and "text".',
          );
        }
        const threadTs = stringArg(args, "thread_ts");
        const chatId = (threadTs ? `${channel}:${threadTs}` : channel) as ChatId;
        const receipt = await channels.send(account, chatId, { text });
        return ok({ channel, ts: tsOf(receipt.messageId) ?? null });
      }
      case "conversations.history": {
        const channel = stringArg(args, "channel");
        if (!channel) {
          return refused('Slack "conversations.history" on Rome\'s Slack app takes "channel".');
        }
        const limit = numberArg(args, "limit") ?? 100;
        const latest = stringArg(args, "latest");
        const oldest = stringArg(args, "oldest");
        const since = oldest ? instantOf(oldest) : undefined;
        const page = await channels.query(account, {
          chatId: channel as ChatId,
          limit,
          ...(latest ? { olderThan: latest } : {}),
          ...(since ? { since } : {}),
        });
        // `since` holds milliseconds and includes its bound. Slack's `oldest`
        // is exact to the microsecond and excludes its own, so the page is cut
        // there. Only messages within that one millisecond are cut, so the
        // page keeps its length but for them.
        const floor = microsOf(oldest);
        const messages =
          floor === undefined
            ? page
            : page.filter((message) => {
                const ts = microsOf(tsOf(message.messageId));
                return ts === undefined || ts > floor;
              });
        // A page can hold fewer than `limit` with more before it, since the
        // connection reads Slack a short page at a time. Only an empty page,
        // or one that reached `oldest`, says nothing is left.
        return ok({
          messages: messages.map(wireOf),
          has_more: messages.length > 0 && messages.length === page.length,
        });
      }
      case "search.messages": {
        const text = stringArg(args, "query");
        if (!text) return refused('Slack "search.messages" on Rome\'s Slack app takes "query".');
        if (!channels.search) return refused("This Rome searches no Slack messages.");
        const count = numberArg(args, "count");
        const channel = stringArg(args, "channel");
        const found = await channels.search(account, {
          text,
          ...(channel ? { chatId: channel as ChatId } : {}),
          ...(count ? { limit: count } : {}),
        });
        const matches = found.messages.map((message) => ({
          ...wireOf(message),
          channel: { id: String(message.chatId).split(":")[0] },
        }));
        return ok({
          query: text,
          messages: { total: matches.length, matches },
          coverage: found.coverage,
        });
      }
      default:
        return refused(
          `Slack method "${method}" isn't offered on Rome's Slack app connection. ${OFFERED}`,
        );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return refused(`Slack "${method}" through Rome's Slack app failed: ${message}`);
  }
}
