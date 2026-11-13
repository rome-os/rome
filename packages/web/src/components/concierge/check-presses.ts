import { z } from "zod";
import { getPending, markUnchanged } from "./task-pending";

/**
 * An `inputs_settled` event: the Concierge turn that took these owner
 * messages in ended, and no newer turn carries them on.
 */
export const inputsSettledSchema = z.object({
  sessionId: z.string(),
  inputIds: z.array(z.string()),
});

/**
 * Marks each pending press whose message a turn that has now ended took in,
 * with the row still as it was, as the server tells it. A press whose turn
 * has not ended, or that is queued behind, stays pending, so one turn ending
 * never speaks for a press it did not handle.
 */
export function settlePresses({ sessionId, inputIds }: z.infer<typeof inputsSettledSchema>): void {
  const settled = new Set(inputIds);
  for (const [taskId, press] of getPending()) {
    if (press.phase !== "pending" || press.chatId !== sessionId) continue;
    if (settled.has(press.inputId)) markUnchanged(taskId);
  }
}
