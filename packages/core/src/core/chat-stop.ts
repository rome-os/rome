import type { ChatStopInput, ChatStopResult } from "@rome-os/app-runtime";
import type { Sessions } from "../agent/index.js";
import type { ChatTurns } from "./chat-turns.js";

/** Stops the turn running in a chat, for a sender already let in
 *  (docs/domains/participation.md#entry). */
export async function stopActiveConversationTurn(
  input: Pick<ChatStopInput, "ref">,
  options: { chatTurns: ChatTurns; sessions: Pick<Sessions, "turn"> },
): Promise<ChatStopResult> {
  const running = options.chatTurns.runningIn(input.ref);
  const turn = running && options.sessions.turn(running.turnId);
  if (!turn || turn.hasEnded) return { status: "idle" };

  await turn.stop("chat-stop");
  return { status: "stop_requested", turnId: turn.id };
}
