import type { ConciergeTasksRepository } from "../db/repositories/concierge-tasks.js";
import type { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";
import type { InterruptedTurn } from "../webchat/repository.js";
import { createLogger } from "../logger.js";
import { willContinueAfterRestart } from "../webchat/restart-continuation.js";

const log = createLogger("restart-marks");

/**
 * Settles the status reactions a stopped Rome process left working, once at
 * startup, before any turn runs (docs/domains/chats.md#status-reaction). A
 * stopped process ends no turn, so no turn's end settles them: the work of
 * every turn this boot ended failed, unless startup continues that turn, whose
 * end then settles its chat's marks. Marks only show how work stands, so a
 * failure is logged and never stops boot. Answers how many changed.
 */
export async function settleMarksAfterRestart(
  tasks: Pick<ConciergeTasksRepository, "failInterruptedReactions">,
  webchat: Pick<ChatsWebChatRepository, "canContinueAfterRestart" | "getRestartLastActivityAt">,
  ended: readonly InterruptedTurn[],
  now = Date.now(),
): Promise<number> {
  try {
    const continuing = new Set(
      ended.filter((turn) => willContinueAfterRestart(turn, webchat, now)).map((t) => t.sessionId),
    );
    const interrupted = new Set(ended.map((turn) => turn.sessionId));
    return await tasks.failInterruptedReactions(continuing, interrupted);
  } catch (error) {
    log.warn("failed to settle status reactions a stopped process left working", {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}
