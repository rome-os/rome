// What Rome's Slack app shares about Slack: its API errors, the addresses it
// gives members, messages and threads, and Slack's wire text as a person reads
// it. Channel contract: docs/architecture/channels.md.

/** chat.postMessage takes up to 12,000 characters of `markdown_text`. */
const SLACK_MARKDOWN_CHUNK_LENGTH = 12_000;

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

export interface SlackUserName {
  displayName?: string;
  username?: string;
}

/** One Events API payload, as Slack sends it. */
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

/** A message's id. One said in a thread carries its thread, as
 *  `thread:message`, so a reply to it finds the thread without asking Slack. */
export function slackMessageId(ts: string, threadTs?: string): string {
  return threadTs && threadTs !== ts ? `${threadTs}:${ts}` : ts;
}

/** The thread a reply to `messageId` goes into. A message in a thread is
 *  answered in that thread, and one at the top of a channel starts a thread
 *  under it. A direct message outside a thread is answered in place. */
export function replyThreadOf(channelId: string, messageId?: string): string | undefined {
  if (!messageId) return undefined;
  const separator = messageId.indexOf(":");
  if (separator !== -1) return messageId.slice(0, separator);
  return channelId.startsWith("D") ? undefined : messageId;
}

/** A chat's channel, and the thread an older thread-keyed chat id names. A
 *  thread lives inside its channel's chat, so a chat id carries no thread; the
 *  older `channel:thread` form is still read. */
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
