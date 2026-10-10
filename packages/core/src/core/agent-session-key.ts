import { v4 as uuidv4 } from "uuid";

// The one place that spells a channelThreadKey. Each builder names the parts
// a key carries and serializes to the exact string stored in
// `sessions.channel_thread_key`, so existing rows keep resolving.

// Read back by parsers until callers use the stored conversation.
export const WEBCHAT_KEY_PREFIX = "webchat:";

/** A webchat conversation's key. */
export function webchatSessionKey(conversationId: string): string {
  return `${WEBCHAT_KEY_PREFIX}${conversationId}`;
}

/** A fresh subagent's key, nested under its parent's so it never reuses the
 *  parent's provider context. */
export function subagentSessionKey(parentKey: string): string {
  return `${parentKey}:subagent:${uuidv4()}`;
}

/** The key subagents of a forked turn nest under. */
export function forkSessionKey(parentKey: string, forkSessionId: string): string {
  return `${parentKey}#fork:${forkSessionId}`;
}

/** A one-off key for a run that names no conversation. */
export function adhocSessionKey(agentName: string): string {
  return `${agentName}:${uuidv4()}`;
}
