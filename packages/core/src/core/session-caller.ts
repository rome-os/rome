import type { SessionCaller } from "@rome-os/app-runtime";

// The caller is the SDK's, so apps and the host name a session the same way.
export type { SessionCaller };

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
 * The caller a stored key names. A run that named no caller was once stored
 * as `<agent>:<uuid>`, the same shape as a place's key, so such a row reads
 * back as a place whose connection is the agent's name. Sessions no caller
 * opens are now stored without one.
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

/** The connection a stored caller's turns are delivered on. Undefined for a
 *  caller on no connection. */
export function connectionOfCaller(stored: string): string | undefined {
  return callerConnection(callerFromKey(stored));
}

/** The chat a caller is when it is a dashboard chat's own session. */
export function chatOfCaller(caller: SessionCaller): string | undefined {
  return caller.kind === "chat" ? caller.chatId : undefined;
}
