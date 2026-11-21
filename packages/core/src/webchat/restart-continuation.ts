import type { SessionActor } from "../access/session-actor.js";
import type { BackendTurnParams } from "@rome-os/app-runtime";
import type { BackendTurnOptions, BackendTurnOutcome } from "../apps/actions/session-runner.js";
import type { InterruptedTurn } from "./repository.js";
import { createLogger } from "../logger.js";
import type { ChatsWebChatRepository } from "./chats-webchat-repository.js";

const log = createLogger("restart-continuation");
export const MAX_RESTART_INACTIVITY_MS = 24 * 60 * 60 * 1000;
const RESTART_MARKER = "<restart_recovery>";

export const RESTART_CONTINUATION_PROMPT =
  RESTART_MARKER +
  "The previous turn was cut off by a Rome restart. " +
  "Read this chat's history to see what was running. " +
  "Check the actual state of the work and verify anything uncertain. Do only what remains. " +
  "If a side-effecting action cannot be confirmed, ask the guardian rather than redo it. " +
  "</restart_recovery>";

/** What a continuation asks of whatever runs backend turns: run this turn in its chat and say how it ended. */
export interface ContinuationRunner {
  runAndReport(
    params: BackendTurnParams,
    options?: BackendTurnOptions,
  ): Promise<BackendTurnOutcome>;
}

/** Whether a turn's last timestamped activity is less than a day before `now`. */
export function isRecentActivity(lastActivityAt: number | null, now: number): boolean {
  return (
    typeof lastActivityAt === "number" &&
    Number.isFinite(lastActivityAt) &&
    Number.isFinite(now) &&
    lastActivityAt <= now &&
    now - lastActivityAt < MAX_RESTART_INACTIVITY_MS
  );
}

/**
 * Whether startup continues interrupted turn `turn`: a turn of a top-level
 * guardian chat, with recent activity, that is not itself a continuation.
 */
export function willContinueAfterRestart(
  turn: InterruptedTurn,
  repo: Pick<ChatsWebChatRepository, "canContinueAfterRestart" | "getRestartLastActivityAt">,
  now = Date.now(),
): boolean {
  // The marker lives in turn_start's prompt, not a later best-effort trace
  // write, so even a crash immediately after turn_start cannot loop recovery.
  if (!turn.runtimeSessionId || turn.prompt.includes(RESTART_MARKER)) return false;
  return (
    repo.canContinueAfterRestart(turn) && isRecentActivity(repo.getRestartLastActivityAt(turn), now)
  );
}

/** Call once after startup, with only this boot's cleanup results. Runs sequentially, without retries. */
export async function continueInterruptedTurns(
  turns: InterruptedTurn[],
  repo: Pick<
    ChatsWebChatRepository,
    "canContinueAfterRestart" | "getRestartGuardianPrompt" | "getRestartLastActivityAt"
  >,
  runner: ContinuationRunner,
  now = Date.now(),
  /** Who the continuation acts for: the person whose turn it continues. Absent, no one. */
  actorOf: (turn: InterruptedTurn) => Promise<SessionActor | undefined> = async () => undefined,
): Promise<void> {
  for (const turn of turns) {
    try {
      if (!turn.runtimeSessionId || !willContinueAfterRestart(turn, repo, now)) continue;
      const excerpt = repo.getRestartGuardianPrompt(turn);
      const actor = await actorOf(turn);
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
          ...(actor ? { actor } : {}),
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
