import type { Account, ChatRef, ChatStopInput, ChatStopResult } from "@rome-os/app-runtime";
import type { PlatformOfChannel } from "../channels/channel.js";
import type { AgentTurnStreamRegistry } from "./agent-turn-stream-registry.js";

export async function stopActiveConversationTurn(
  input: ChatStopInput,
  options: {
    turns: AgentTurnStreamRegistry;
    isGuardian: (service: string, senderId: string) => Promise<boolean>;
  },
): Promise<ChatStopResult> {
  const turn = options.turns.getActiveByConversation(input.ref);
  if (!turn?.interrupt) return { status: "idle" };

  if (turn.initiatorId !== input.senderId) {
    const guardian = await options.isGuardian(input.service, input.senderId);
    if (!guardian) return { status: "forbidden" };
  }

  await turn.interrupt("chat-stop");
  return { status: "stop_requested", turnId: turn.turnId };
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
