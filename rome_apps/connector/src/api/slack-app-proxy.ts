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

const OFFERED =
  "It offers chat.postMessage (send), conversations.history (read) and search.messages (search over what Rome has kept of the app's direct messages and mentions).";

/** The Slack account Rome's Slack app connection is, or null when none is
 *  connected. It is the Slack account whose channel searches: the Slack bot
 *  connection, also on Slack, does not. */
export async function slackAppAccount(channels: ChannelsService): Promise<Account | null> {
  const summaries = await channels.list();
  const held = summaries.find(
    (summary) => summary.platform === "slack" && summary.searchable === true && summary.account,
  );
  return held?.account ?? null;
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
        const messages = await channels.query(account, {
          chatId: channel as ChatId,
          limit,
          ...(latest ? { olderThan: latest } : {}),
          ...(since ? { since } : {}),
        });
        return ok({ messages: messages.map(wireOf), has_more: messages.length >= limit });
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
