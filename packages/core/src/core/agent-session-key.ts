import { v4 as uuidv4 } from "uuid";
import { type RootSession, walkToRoot } from "../agent/index.js";

// Builds and reads channelThreadKeys. Each builder serializes to the exact
// string stored in `sessions.channel_thread_key`, so existing rows keep
// resolving. The inbox app still spells messaging-channel and sentinel keys.

const WEBCHAT_KEY_PREFIX = "webchat:";

/** A webchat conversation's key. */
export function webchatSessionKey(chatId: string): string {
  return `${WEBCHAT_KEY_PREFIX}${chatId}`;
}

/** A one-off key for a run that names no conversation. */
export function adhocSessionKey(agentName: string): string {
  return `${agentName}:${uuidv4()}`;
}

const SENTINEL_KEY_PREFIX = "sentinel:";

/**
 * A root session's channelThreadKey, by its named parts. A subagent's or a
 * fork's session stores its parent link after its root's key, which
 * `walkToRoot` in the agent context reads. An ad-hoc key and a messaging
 * channel's key share the `<a>:<b>` shape, so an ad-hoc key parses as
 * `channel` with its agent name in `channel`.
 */
export type ParsedSessionKey =
  | { kind: "webchat"; chatId: string }
  | { kind: "channel"; channel: string; threadId: string }
  | { kind: "sentinel"; watched: ParsedSessionKey }
  | { kind: "other"; raw: string };

/** The one reader of a root session's channelThreadKey. It takes the end of
 *  a `walkToRoot`, so a subagent's or a fork's key is never read as a root's. */
export function parseSessionKey(root: RootSession): ParsedSessionKey {
  return parseRootKey(root.stored);
}

function parseRootKey(key: string): ParsedSessionKey {
  if (key.startsWith(SENTINEL_KEY_PREFIX)) {
    return { kind: "sentinel", watched: parseRootKey(key.slice(SENTINEL_KEY_PREFIX.length)) };
  }
  const separator = key.indexOf(":");
  if (separator <= 0) return { kind: "other", raw: key };
  const head = key.slice(0, separator);
  const rest = key.slice(separator + 1);
  if (head === "webchat" && rest && !rest.includes(":")) {
    return { kind: "webchat", chatId: rest };
  }
  return { kind: "channel", channel: head, threadId: rest };
}

/**
 * The channel a key's turns are delivered on: the root session's, so a
 * subagent's or a fork's session takes its root's. Undefined for a sentinel,
 * which watches a channel without replying on it, and for a key with no
 * channel part.
 */
export function sessionKeyChannel(key: string): string | undefined {
  return channelOf(parseSessionKey(walkToRoot(key)));
}

function channelOf(parsed: ParsedSessionKey): string | undefined {
  switch (parsed.kind) {
    case "webchat":
      return "webchat";
    case "channel":
      return parsed.channel;
    case "sentinel":
    case "other":
      return undefined;
  }
}

/** The webchat conversation a key belongs to when it is that chat's own
 *  session, not a subagent or fork under it. */
export function webchatConversationOfKey(key: string): string | undefined {
  const root = walkToRoot(key);
  if (root.hasParent) return undefined;
  const parsed = parseSessionKey(root);
  return parsed.kind === "webchat" ? parsed.chatId : undefined;
}
