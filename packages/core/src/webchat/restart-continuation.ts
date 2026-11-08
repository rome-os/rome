import type { MainBackendTurnRunner } from "../actions/backend-turn.js";
import type { InterruptedTurn } from "../db/repositories/webchat.js";
import { createLogger } from "../logger.js";
import type { ChatsWebChatRepository } from "./chats-webchat-repository.js";

const log = createLogger("restart-continuation");
const RESTART_MARKER = "<restart_recovery>";

export const RESTART_CONTINUATION_PROMPT =
  RESTART_MARKER +
  "The previous turn was cut off by a Rome restart. " +
  "Read this chat's history to see what was running. " +
  "Check the actual state of the work and verify anything uncertain. Do only what remains. " +
  "If a side-effecting action cannot be confirmed, ask the guardian rather than redo it. " +
  "</restart_recovery>";

/** Call once after startup, with only this boot's cleanup results. Runs sequentially, without retries. */
export async function continueInterruptedTurns(
  turns: InterruptedTurn[],
  repo: Pick<ChatsWebChatRepository, "canContinueAfterRestart" | "getRestartGuardianPrompt">,
  runner: Pick<MainBackendTurnRunner, "runAndReport">,
): Promise<void> {
  for (const turn of turns) {
    // The marker lives in turn_start's prompt, not a later best-effort trace
    // write, so even a crash immediately after turn_start cannot loop recovery.
    if (!turn.runtimeSessionId || turn.prompt.includes(RESTART_MARKER)) continue;
    try {
      if (!repo.canContinueAfterRestart(turn)) continue;
      const excerpt = repo.getRestartGuardianPrompt(turn);
      await runner.runAndReport(
        {
          agentName: turn.agentName,
          sessionId: turn.runtimeSessionId,
          channel: "webchat",
          threadId: turn.sessionId,
          prompt:
            RESTART_CONTINUATION_PROMPT +
            (excerpt
              ? `\n\nInterrupted request (may already be partly complete):\n${excerpt}`
              : ""),
        },
        {
          inputLabel: "Restart recovery",
          shouldRun: () => repo.canContinueAfterRestart(turn),
        },
      );
    } catch (error) {
      log.warn("could not continue interrupted turn", {
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        error: String(error),
      });
    }
  }
}
