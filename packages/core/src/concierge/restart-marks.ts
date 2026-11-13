import type { ConciergeTasksRepository } from "../db/repositories/concierge-tasks.js";
import type { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";
import type { InterruptedTurn } from "../webchat/repository.js";
import { createLogger } from "../logger.js";
import { willContinueAfterRestart } from "../webchat/restart-continuation.js";

const log = createLogger("restart-marks");

/**
 * Settles the status reactions a stopped Rome process left working, once at
 * startup, before any turn runs (docs/domains/chats.md#status-reaction). A
 * stopped process ends no turn, so no turn's end answers its messages: they
 * are answered here, unless startup continues that turn, whose end then
 * answers them. A task's mark follows its status, which a restart recomputes.
 * Marks only show how work stands, so a failure is logged and never stops
 * boot. Answers how many changed.
 */
export async function settleMarksAfterRestart(
  tasks: Pick<ConciergeTasksRepository, "answerInterrupted" | "findBySession" | "setLastOutcome">,
  webchat: Pick<ChatsWebChatRepository, "canContinueAfterRestart" | "getRestartLastActivityAt">,
  ended: readonly InterruptedTurn[],
  now = Date.now(),
): Promise<number> {
  try {
    const continuing = new Set(
      ended.filter((turn) => willContinueAfterRestart(turn, webchat, now)).map((t) => t.sessionId),
    );
    // A task chat's turn the restart ended failed: startup never continues
    // one, so its task ended failed, and the Concierge is told on catch-up.
    let failed = 0;
    for (const turn of ended) {
      if (continuing.has(turn.sessionId)) continue;
      const task = await tasks.findBySession(turn.sessionId);
      if (!task) continue;
      await tasks.setLastOutcome(task.id, "failed");
      failed += 1;
    }
    return (await tasks.answerInterrupted(continuing)) + failed;
  } catch (error) {
    log.warn("failed to settle status reactions a stopped process left working", {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}
