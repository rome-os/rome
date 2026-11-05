import type { ChatId, ChatRef, ProviderSessionResetPolicy } from "@rome-os/app-runtime";
import { evaluateProviderSessionReset } from "../chat-settings/reset-policy.js";
import type { AgentSessionManager } from "../agent-sessions/index.js";
import { callerKey, type SessionCaller } from "./session-caller.js";
import type { ThreadContext } from "./types.js";

// A connection's reset setting: a wake on a place whose session's context is
// older than the place allows starts the next turn on a fresh context. The
// caller decides when, from the policy; the session replaces the context.

export type ResolveConnectionReset = (ref: ChatRef) => Promise<ProviderSessionResetPolicy>;

/**
 * Reset the session of `agentName` for `caller` when the connection's policy
 * says its context is due. Applies only to a wake on a connection, which a
 * thread context with a connection id names.
 */
export async function resetWhenDue(
  sessions: Pick<AgentSessionManager, "reset">,
  resolve: ResolveConnectionReset | undefined,
  agentName: string,
  caller: SessionCaller,
  threadContext: ThreadContext | undefined,
): Promise<void> {
  if (!resolve || !threadContext?.connectionId) return;
  const interactionAt = new Date();
  const policy = await resolve({
    connectionId: threadContext.connectionId,
    chatId: threadContext.threadId as ChatId,
  });
  await sessions.reset(agentName, callerKey(caller), {
    policy: policy.mode,
    when: (context) => evaluateProviderSessionReset(policy, context, interactionAt),
  });
}
