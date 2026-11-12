import type { ConciergeTasksRepository } from "../db/repositories/concierge-tasks.js";
import type { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";
import type { InterruptedTurn } from "../webchat/repository.js";
import { willContinueAfterRestart } from "../webchat/restart-continuation.js";

/**
 * Settles the status reactions a stopped Rome process left working, once at
 * startup, before any turn runs (docs/domains/chats.md#status-reaction). A
 * stopped process ends no turn, so no turn's end settles them: the work of
 * every turn this boot ended failed, unless startup continues that turn, whose
 * end then settles its chat's marks. Answers how many changed.
 */
export async function settleMarksAfterRestart(
  tasks: Pick<ConciergeTasksRepository, "failInterruptedReactions">,
  webchat: Pick<ChatsWebChatRepository, "canContinueAfterRestart" | "getRestartLastActivityAt">,
  ended: readonly InterruptedTurn[],
  now = Date.now(),
): Promise<number> {
  const continuing = new Set(
    ended.filter((turn) => willContinueAfterRestart(turn, webchat, now)).map((t) => t.sessionId),
  );
  const interrupted = new Set(ended.map((turn) => turn.sessionId));
  return tasks.failInterruptedReactions(continuing, interrupted);
}
