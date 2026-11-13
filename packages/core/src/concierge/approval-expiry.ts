// Turning down a task chat's pending approvals: when its wait ran out, or
// when the task was stopped, archived or deleted, so nothing approved later
// runs for a task that ended.

import type { ApprovalsRepository } from "../apps/repositories/approvals.js";
import type { ApprovalHandler } from "../apps/actions/approval-handler.js";
import { createLogger } from "../logger.js";

const log = createLogger("concierge-approval-expiry");

export interface ApprovalExpiryDeps {
  approvals: Pick<ApprovalsRepository, "list" | "resolvePending">;
  handler: Pick<ApprovalHandler, "onRejected">;
}

/** What turning a chat's approvals down asks for. */
/** Who an approval Rome turned down reads as resolved by: its task's wait ran out. */
export const RESOLVED_BY_EXPIRY = "rome:task-ended";
/** Who an approval Rome turned down reads as resolved by: its task was stopped, archived or deleted. */
export const RESOLVED_BY_STOP = "rome:task-stopped";

export interface TurnDown {
  /** Only approvals that began by then, epoch milliseconds. */
  until: number;
  reason: string;
  /** Why Rome turned them down, as the approval records it. */
  resolvedBy: typeof RESOLVED_BY_EXPIRY | typeof RESOLVED_BY_STOP;
  /**
   * Whether the turn that asked carries on, told of the refusal, as on any
   * rejection. A stopped task's turn does not.
   */
  continueTurn: boolean;
}

/**
 * Turns down chat `chatId`'s approvals still pending that began by `until`.
 * One already resolved is left alone, so a repeat changes nothing. Answers
 * how many it turned down.
 */
export async function turnDownApprovals(
  deps: ApprovalExpiryDeps,
  chatId: string,
  turnDown: TurnDown,
): Promise<number> {
  let turnedDown = 0;
  for (const approval of await deps.approvals.list("pending")) {
    const threadId = (approval.payload as { channelContext?: { threadId?: unknown } } | null)
      ?.channelContext?.threadId;
    if (threadId !== chatId || approval.createdAt.getTime() > turnDown.until) continue;
    const resolved = await deps.approvals.resolvePending(
      approval.id,
      "reject",
      turnDown.resolvedBy,
    );
    if (resolved.outcome !== "resolved") continue;
    turnedDown += 1;
    if (!turnDown.continueTurn || approval.type !== "action_execution") continue;
    // The turn that carries on runs on its own: the turn-down is done once
    // the approval is resolved, whatever that turn does.
    void deps.handler.onRejected(approval.id, turnDown.reason).catch((error: unknown) =>
      log.warn("failed to finish a turned-down approval's turn", {
        approvalId: approval.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  return turnedDown;
}
