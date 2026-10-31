import { CONCIERGE_CHAT_ID } from "@/hooks/use-concierge";
import { listSessionMessagePage, listSessionTurns } from "@/lib/chat-api";
import { getPending, markUnchanged } from "./task-pending";

/** How many recent turns of the Concierge chat to look for the pressed messages in. */
const RECENT_TURNS = 10;

/**
 * Marks each pending press whose message a Concierge turn took in, and that
 * turn has ended, with the row still as it was. A turn that has not taken a
 * press in (it is queued behind, or still waiting) leaves it pending, so one
 * turn ending never speaks for the presses it did not handle.
 */
export async function checkPresses(): Promise<void> {
  const waiting = [...getPending()].filter(([, press]) => press.phase === "pending");
  if (waiting.length === 0) return;
  const [turns, page] = await Promise.all([
    listSessionTurns(CONCIERGE_CHAT_ID),
    listSessionMessagePage(CONCIERGE_CHAT_ID, { limit: RECENT_TURNS }),
  ]);
  if (!turns || !page) return;
  const running = new Set(turns.flatMap((turn) => [turn.turnId, turn.agentTurnId ?? turn.turnId]));
  for (const [taskId, press] of waiting) {
    const sent = page.messages.find((message) => message.id === press.inputId);
    if (sent?.inputState === "consumed" && sent.turnId && !running.has(sent.turnId)) {
      markUnchanged(taskId);
    }
  }
}
