import type { ConciergeTasksRepository } from "../db/repositories/concierge-tasks.js";
import type { InterruptedTurn } from "../webchat/repository.js";
import { createLogger } from "../logger.js";

const log = createLogger("restart-marks");

/**
 * Settles the status reactions a stopped Rome process left working, once at
 * startup, before any turn runs (docs/domains/chats.md#status-reaction). A
 * stopped process ends no turn, so no turn's end settles them: the work of
 * every turn this boot ended failed. The Concierge then decides what to
 * continue, and a turn that runs again marks its work again. Marks only show
 * how work stands, so a failure is logged and never stops boot. Answers how
 * many changed.
 */
export async function settleMarksAfterRestart(
  tasks: Pick<ConciergeTasksRepository, "failInterruptedReactions">,
  ended: readonly InterruptedTurn[],
): Promise<number> {
  try {
    return await tasks.failInterruptedReactions(new Set(ended.map((turn) => turn.sessionId)));
  } catch (error) {
    log.warn("failed to settle status reactions a stopped process left working", {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}
