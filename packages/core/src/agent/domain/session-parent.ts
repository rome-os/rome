// A subagent's or a fork's session has a parent turn
// (docs/domains/agents.md#subagent-call, docs/concepts/sessions.md#forked-turns).
// Today the link to it is stored in the session's `channel_thread_key`: the
// parent's string with a subagent or fork marker after it. This module is the
// one place that writes and reads that stored form. The strings stay byte for
// byte, because stored rows resolve by them.

import { v4 as uuidv4 } from "uuid";
import type { SessionId } from "./session.js";

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

/** Where a walk up a stored string's parent links ends. */
export interface RootSession {
  /** The root session's own stored string. */
  stored: string;
  /** Whether the walk passed a parent link, so the string is not the root's. */
  hasParent: boolean;
  /** The forks passed on the way up, nearest first. */
  forkSessionIds: SessionId[];
}

/** Walks up a stored string's parent links to its root session. */
export function walkToRoot(stored: string): RootSession {
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
