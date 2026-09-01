import type { ChatStopInput, ChatStopResult } from "@rome-os/app-runtime";
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
