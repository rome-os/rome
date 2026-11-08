// A subagent's or a fork's session has a parent turn
// (docs/domains/agents.md#subagent-call, docs/concepts/sessions.md#forked-turns).
// Today the link to it is stored in the session's `channel_thread_key`: the
// parent's string with a subagent or fork marker after it. This module is the
// one place that writes and reads that stored form. The strings stay byte for
// byte, because stored rows resolve by them.
//
// The dashboard keeps a second copy of the same link, by its own id for the
// session (`rome_sessions.parent_session_id`). `rootSession` walks that copy
// and `walkToRoot` walks the string. Both find the same root session, except
// for a fork promoted to a chat: the dashboard then holds it as a chat, its
// own root, while its string still leads to the chat it was forked from.

import { v4 as uuidv4 } from "uuid";
import type { DashboardSessions } from "./dashboard-sessions.js";
import type { SessionId } from "./session.js";
import type { SessionRecordId } from "./subagent.js";

const SUBAGENT_MARKER = /^(.+):subagent:([^:#]+)$/;
const FORK_MARKER = /^(.+)#fork:([^:#]+)$/;

/** What a fresh subagent session stores, under its parent session's string. */
export function storeSubagentParent(parent: string): string {
  return `${parent}:subagent:${uuidv4()}`;
}

/** What a fork's subagent sessions store their parent under, so they never
 *  resume one of the source's subagent sessions. */
export function storeForkParent(source: string, forkSessionId: SessionId): string {
  return `${source}#fork:${forkSessionId}`;
}

/** Where a walk up a stored string's parent links ends: its root session. */
export interface StoredRoot {
  /** The root session's own stored string. */
  stored: string;
  /** Whether the walk passed a parent link, so the string is not the root's. */
  hasParent: boolean;
  /** The forks passed on the way up, nearest first. */
  forkSessionIds: SessionId[];
}

/** Walks up a stored string's parent links to its root session. */
export function walkToRoot(stored: string): StoredRoot {
  let current = stored;
  let hasParent = false;
  const forkSessionIds: SessionId[] = [];
  for (;;) {
    const subagent = SUBAGENT_MARKER.exec(current);
    if (subagent) {
      current = subagent[1]!;
      hasParent = true;
      continue;
    }
    const fork = FORK_MARKER.exec(current);
    if (fork) {
      forkSessionIds.push(fork[2]!);
      current = fork[1]!;
      hasParent = true;
      continue;
    }
    return { stored: current, hasParent, forkSessionIds };
  }
}

/**
 * The parent turn's session that a dashboard session of `type` names: only a
 * subagent's or a fork's session has a parent turn, so any other type has
 * none, whatever parent it names.
 */
export function parentTurnSession(
  type: string,
  parentSessionId: SessionRecordId | null,
): SessionRecordId | null {
  return type === "subagent" || type === "fork" ? parentSessionId : null;
}

/** How many parents a walk to the root reads before it stops. A subagent can
 *  call again and a fork can be forked, so a chain deeper than this, or a
 *  cycle, is treated as unreachable. */
export const MAX_ANCESTORS = 16;

/**
 * The session `id`'s work started from, by the dashboard's id: the session
 * itself when it has no parent turn, otherwise the first session up its
 * parent turns that has none. When a parent's session is gone, the walk stops
 * at the last session it found, and it stops after MAX_ANCESTORS parents.
 * Null when the dashboard has no session with the id.
 */
export async function rootSession(
  sessions: Pick<DashboardSessions, "parentSession">,
  id: SessionRecordId,
): Promise<SessionRecordId | null> {
  let current = id;
  let parent = await sessions.parentSession(current);
  if (parent === undefined) return null;
  for (let depth = 0; parent && depth < MAX_ANCESTORS; depth++) {
    const next = await sessions.parentSession(parent);
    if (next === undefined) break;
    current = parent;
    parent = next;
  }
  return current;
}
