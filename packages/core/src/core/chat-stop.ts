import type { Account, ChatRef, ChatStopInput, ChatStopResult } from "@rome-os/app-runtime";
import type { PlatformOfChannel } from "../chats/connected-accounts/connected-account.js";
import type { Sessions } from "../agent/index.js";
import type { ChatTurns } from "./chat-turns.js";

export async function stopActiveConversationTurn(
  input: ChatStopInput,
  options: {
    chatTurns: ChatTurns;
    sessions: Pick<Sessions, "turn">;
    isGuardian: (service: string, senderId: string) => Promise<boolean>;
  },
): Promise<ChatStopResult> {
  const running = options.chatTurns.runningIn(input.ref);
  const turn = running && options.sessions.turn(running.turnId);
  if (!turn || turn.hasEnded) return { status: "idle" };

  if (running.initiatorId !== input.senderId) {
    const guardian = await options.isGuardian(input.service, input.senderId);
    if (!guardian) return { status: "forbidden" };
  }

  await turn.stop("chat-stop");
  return { status: "stop_requested", turnId: turn.id };
}

/**
 * The platform a stop's sender is on: that of the account the chat's
 * connection reaches, or, until its grant names one, that of the channel the
 * host named as `service`. That channel may be one of several on its kind,
 * named by an opaque id, so it is read as a channel rather than as a kind.
 */
export function stopSenderPlatform(
  ref: Pick<ChatRef, "connectionId">,
  service: string,
  deps: {
    accountOf: (connectionId: string) => Account | null;
    platformOfChannel: PlatformOfChannel;
  },
): string {
  return deps.accountOf(ref.connectionId)?.platform ?? deps.platformOfChannel(service);
}
