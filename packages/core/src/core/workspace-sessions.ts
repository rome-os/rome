// One session for an account that serves its workspace: every chat on its
// channel shares it (docs/domains/participation.md#workspace-account).

import type { ThreadContext } from "@rome-os/app-runtime";
import type { Sessions } from "../agent/index.js";
import { channelChatSessionKey, workspaceSessionKey } from "./agent-session-key.js";

/** Whether the account behind a connection serves its whole workspace. */
export type ServesWorkspace = (connectionId: string) => boolean;

/**
 * `sessions`, opening a chat's session on an account that serves its
 * workspace under the account's one key instead. The chat's own key is the
 * one a chat on a connection opens by, its channel and the chat's id, which
 * the thread context names. Any other key opens as asked. Such a session reads
 * as shared whichever chat opened it, since its turns run in every chat of
 * the account.
 */
export function workspaceSessions(sessions: Sessions, servesWorkspace: ServesWorkspace): Sessions {
  return {
    ...sessions,
    open(key, opening) {
      const thread = opening?.threadContext;
      if (
        !thread?.connectionId ||
        key.channelThreadKey !== channelChatSessionKey(thread.channel, thread.threadId) ||
        !servesWorkspace(thread.connectionId)
      ) {
        return sessions.open(key, opening);
      }
      return sessions.open(
        { ...key, channelThreadKey: workspaceSessionKey(thread.channel) },
        {
          ...opening,
          audience: "shared",
          toolEnv: { ...opening?.toolEnv, ROME_TURN_AUDIENCE: "shared" },
        },
      );
    },
  };
}

/** The key of the session that answers a chat on `channel`: the account's one
 *  session when it serves its workspace, else the chat's own. */
export function chatSessionKeyOf(
  connectionOfChannel: (channel: string) => string | null,
  servesWorkspace: ServesWorkspace,
): (chat: Pick<ThreadContext, "channel" | "threadId">) => string {
  return ({ channel, threadId }) => {
    const connectionId = connectionOfChannel(channel);
    return connectionId && servesWorkspace(connectionId)
      ? workspaceSessionKey(channel)
      : channelChatSessionKey(channel, threadId);
  };
}
