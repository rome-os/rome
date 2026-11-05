import { v4 as uuidv4 } from "uuid";

/**
 * Whatever hands a session its next input. A session is one agent's turns for
 * one caller, so the agent and the caller find it.
 *
 * - `chat`: a person in a dashboard chat, the handoff chats included.
 * - `place`: one of Rome's accounts in a place on a connection. A `watcher`
 *   follows the place without answering in it (the inbox's sentinel).
 * - `parent-turn`: a subagent's parent turn. Each child gets its own id, so
 *   it never reuses the parent's context.
 * - `fork-point`: a session at one completed turn. Only the fork's own
 *   subagents name it, so they never resume the source's children.
 * - `execution`: a trigger execution, or a run that names no conversation.
 *
 * `chatId` on a place or an execution names the conversation its turns are
 * recorded in, when the caller knows it.
 */
export type SessionCaller =
  | { kind: "chat"; chatId: string }
  | { kind: "place"; connection: string; place: string; watcher?: boolean; chatId?: string }
  | { kind: "parent-turn"; parent: SessionCaller; childId: string }
  | { kind: "fork-point"; source: SessionCaller; forkSessionId: string }
  | { kind: "execution"; id: string; chatId?: string };

// The codec below writes and reads the string stored in
// `sessions.channel_thread_key`. Each kind serializes to the exact string the
// old key builders wrote, so existing rows keep resolving. Only this file
// spells or parses that string.

const CHAT_PREFIX = "webchat:";
const WATCHER_PREFIX = "sentinel:";
const CHILD_SUFFIX = /^(.+):subagent:([^:#]+)$/;
const FORK_SUFFIX = /^(.+)#fork:([^:#]+)$/;

/** The stored key of a caller. */
export function callerKey(caller: SessionCaller): string {
  switch (caller.kind) {
    case "chat":
      return `${CHAT_PREFIX}${caller.chatId}`;
    case "place":
      return `${caller.watcher ? WATCHER_PREFIX : ""}${caller.connection}:${caller.place}`;
    case "parent-turn":
      return `${callerKey(caller.parent)}:subagent:${caller.childId}`;
    case "fork-point":
      return `${callerKey(caller.source)}#fork:${caller.forkSessionId}`;
    case "execution":
      return caller.id;
  }
}

/**
 * The caller a stored key names. A run that named no conversation was stored
 * as `<agent>:<uuid>`, the same shape as a place's key, so it reads back as a
 * place whose connection is the agent's name. That is how the old parser read
 * it too.
 */
export function callerFromKey(key: string): SessionCaller {
  const child = CHILD_SUFFIX.exec(key);
  if (child) return { kind: "parent-turn", parent: callerFromKey(child[1]!), childId: child[2]! };
  const fork = FORK_SUFFIX.exec(key);
  if (fork) return { kind: "fork-point", source: callerFromKey(fork[1]!), forkSessionId: fork[2]! };
  if (key.startsWith(WATCHER_PREFIX)) {
    const watched = callerFromKey(key.slice(WATCHER_PREFIX.length));
    return watched.kind === "place" && !watched.watcher
      ? { ...watched, watcher: true }
      : { kind: "execution", id: key };
  }
  const separator = key.indexOf(":");
  if (separator <= 0) return { kind: "execution", id: key };
  const head = key.slice(0, separator);
  const rest = key.slice(separator + 1);
  if (`${head}:` === CHAT_PREFIX && rest && !rest.includes(":"))
    return { kind: "chat", chatId: rest };
  return { kind: "place", connection: head, place: rest };
}

/** A fresh child of `parent`. */
export function childCaller(parent: SessionCaller): SessionCaller {
  return { kind: "parent-turn", parent, childId: uuidv4() };
}

/** A run of `agentName` that names no conversation. */
export function adhocCaller(agentName: string): SessionCaller {
  return { kind: "execution", id: `${agentName}:${uuidv4()}` };
}

/**
 * The connection a caller's turns are delivered on. A child and a fork take
 * their parent's. Undefined for a watcher, which answers nowhere, and for an
 * execution, which names no connection.
 */
export function callerConnection(caller: SessionCaller): string | undefined {
  switch (caller.kind) {
    case "chat":
      return CHAT_PREFIX.slice(0, -1);
    case "place":
      return caller.watcher ? undefined : caller.connection;
    case "parent-turn":
      return callerConnection(caller.parent);
    case "fork-point":
      return callerConnection(caller.source);
    case "execution":
      return undefined;
  }
}

/** The conversation a caller names for its turns, if any. */
export function callerChatId(caller: SessionCaller): string | undefined {
  switch (caller.kind) {
    case "chat":
      return caller.chatId;
    case "place":
    case "execution":
      return caller.chatId;
    case "parent-turn":
    case "fork-point":
      return undefined;
  }
}

/** The caller with `chatId` as the conversation it names, where its kind can
 *  name one. A chat names itself already. */
export function withChatId(caller: SessionCaller, chatId: string | undefined): SessionCaller {
  if (!chatId) return caller;
  return caller.kind === "place" || caller.kind === "execution" ? { ...caller, chatId } : caller;
}

/** The caller a stored key names, or a fresh run's when there is none. */
export function callerOfRun(
  agentName: string,
  key: string | undefined,
  chatId?: string,
): SessionCaller {
  return withChatId(key ? callerFromKey(key) : adhocCaller(agentName), chatId);
}

/** The chat a caller is when it is a dashboard chat's own session. */
export function chatOfCaller(caller: SessionCaller): string | undefined {
  return caller.kind === "chat" ? caller.chatId : undefined;
}
