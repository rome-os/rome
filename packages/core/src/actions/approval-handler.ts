import type { ApprovalsRepository } from "../db/repositories/approvals.js";
import type { ExecutionJournalRepository } from "../db/repositories/execution-journal.js";
import type { ActionEngine, ActionRunContext } from "./engine.js";
import type { ActionResult } from "./types.js";
import type { AgentRunnerInterface, ThreadContext } from "../core/types.js";
import type { AgentMessage } from "../types.js";
import type { JournalEntry } from "./replay.js";
import type { MainBackendTurnRunner } from "./backend-turn.js";
import { createLogger } from "../logger.js";

const log = createLogger("approval-handler");

interface ApprovalPayload {
  actionName: string;
  args: Record<string, unknown>;
  rootActionName?: string;
  rootArgs?: Record<string, unknown>;
  rootExecutionId?: string;
  replayJournal?: JournalEntry[];
  channelContext?: ThreadContext;
  sharedContext?: Record<string, unknown>;
  sessionId?: string;
  romeSessionId?: string;
  agentName?: string;
  channelThreadKey?: string;
}

function formatResultForAgent(result: ActionResult): string {
  if (result.status === "error") {
    return `The action failed with error: ${result.error}`;
  }
  if (result.status === "pending_approval") {
    return `The action you requested was approved, but it triggered another action ("${result.approval.actionName}") that also requires guardian approval. It is now awaiting further approval.`;
  }
  if (result.status === "pending_interaction") {
    return `The action you requested was approved and now awaits the guardian in the "${result.interaction.appId}" interaction surface. The outcome will arrive as a new turn.`;
  }
  if (result.status === "handoff") {
    return `The action you requested was approved and control has been handed off to the "${result.handoff.appId}" app. The outcome will arrive as a new turn.`;
  }
  if (result.status === "place_widget") {
    return `The action you requested was approved and executed; the "${result.placement.appId}" widget has been placed on the guardian's workspace.`;
  }
  const dataStr = result.data ? JSON.stringify(result.data, null, 2) : "no data";
  return `The action you requested has been approved and executed successfully.\n\nResult: ${dataStr}`;
}

export class ApprovalHandler {
  constructor(
    private approvalsRepo: ApprovalsRepository,
    private journalRepo: ExecutionJournalRepository,
    private actionEngine: ActionEngine,
    private agentRunner: AgentRunnerInterface,
    /** The shared backend-turn orchestrator. The approved action's
     * execution + trace and the session continuation run inside one of its
     * backend session tasks, so webchat renders the deferred tool call live and
     * the continuation reply rides the SSE push — the same seam defer uses. */
    private backendTurnRunner: MainBackendTurnRunner,
    /** Resolve the continued session's project working dir from its (channel,
     * thread). An approval resume — like defer — runs the SDK turn on a fresh
     * stack that never carried the dir, so without this it falls back to the
     * default project and the per-cwd transcript resume fails with "No
     * conversation found". Undefined ⇒ keep the default-dir fallback. */
    private resolveWorkingDir?: (channel: string, threadId: string) => Promise<string | undefined>,
  ) {}

  async onApproved(approvalId: string): Promise<void> {
    const approval = await this.approvalsRepo.findById(approvalId);
    if (!approval) {
      log.error("approval not found", { approvalId });
      return;
    }

    if (approval.status !== "approved") {
      log.warn("approval not in approved status, skipping", {
        approvalId,
        status: approval.status,
      });
      return;
    }

    if (approval.type !== "action_execution") {
      log.warn("approval is not action_execution, skipping", {
        approvalId,
        type: approval.type,
      });
      return;
    }

    if (approval.executedAt) {
      log.warn("approval already executed, skipping", { approvalId });
      return;
    }

    const rawPayload = approval.payload as Record<string, unknown> | null;
    if (!rawPayload || typeof rawPayload !== "object") {
      log.error("approval has no payload", { approvalId });
      await this.approvalsRepo.markExecutionFailed(approvalId, "approval has no payload");
      return;
    }

    if (typeof rawPayload.actionName !== "string" || !rawPayload.actionName) {
      log.error("approval payload missing required actionName", { approvalId });
      await this.approvalsRepo.markExecutionFailed(
        approvalId,
        "approval payload missing required field: actionName",
      );
      return;
    }

    const payload = rawPayload as unknown as ApprovalPayload;

    // Claim execution atomically (queued -> running) so only one worker runs it.
    const claimed = await this.approvalsRepo.claimExecution(approvalId);
    if (!claimed) {
      log.warn("approval execution already claimed or not queueable, skipping", {
        approvalId,
        executionState: approval.executionState,
      });
      return;
    }

    log.info("processing approved action", {
      approvalId,
      actionName: payload.actionName,
      hasReplayJournal: !!payload.replayJournal,
      hasSessionId: !!payload.sessionId,
    });

    // Run the approved action + its trace and the continuation inside one
    // backend session task. For webchat that renders the tool call live and
    // pushes the reply over SSE; for other channels (or with no webchat runtime
    // wired) the orchestrator runs it with a no-op emit.
    await this.backendTurnRunner.runBackendSessionTask(
      payload.channelContext?.channel ?? "",
      payload.channelContext?.threadId ?? "",
      async ({ emit }) => {
        await this.executeApprovedAction(approvalId, payload, emit);
      },
    );
  }

  private async executeApprovedAction(
    approvalId: string,
    payload: ApprovalPayload,
    emit?: (msg: AgentMessage & { agent?: string }) => void,
  ): Promise<void> {
    const agentName = payload.agentName ?? "main";
    // The trace stream is shaped around AgentMessage, so we synthesize a
    // tool_use/tool_result pair to make this deferred execution visible in
    // the chat. The `approval:` prefix keeps the id distinguishable from
    // SDK-issued `toolu_*` ids and makes it queryable back to the approval row.
    const traceId = `approval:${approvalId}`;

    try {
      emit?.({
        type: "tool_use",
        id: traceId,
        tool: payload.actionName,
        input: payload.args,
        agent: agentName,
      });

      let result: ActionResult;
      if (payload.replayJournal && payload.rootActionName) {
        const runContext: ActionRunContext = {
          initiator: `approval:${approvalId}`,
          replayJournal: payload.replayJournal,
          replayRootExecutionId: payload.rootExecutionId,
          channelContext: payload.channelContext,
          sharedContext: payload.sharedContext,
          sessionId: payload.sessionId,
          romeSessionId: payload.romeSessionId,
          agentName: payload.agentName,
          channelThreadKey: payload.channelThreadKey,
        };
        result = await this.actionEngine.run(
          payload.rootActionName,
          payload.rootArgs ?? {},
          runContext,
        );
      } else {
        result = await this.actionEngine.run(payload.actionName, payload.args, {
          initiator: `approval:${approvalId}`,
        });
      }

      emit?.({
        type: "tool_result",
        toolUseId: traceId,
        tool: payload.actionName,
        output: result,
        agent: agentName,
      });

      if (payload.sessionId) {
        const resultText = formatResultForAgent(result);
        const workingDir = await this.resolveWorkingDir?.(
          payload.channelContext?.channel ?? "",
          payload.channelContext?.threadId ?? "",
        );
        for await (const message of this.agentRunner.run({
          agentName,
          prompt: resultText,
          sessionId: payload.sessionId,
          channelThreadKey: payload.channelThreadKey,
          // Resume in the session's own project dir so the SDK transcript resume
          // hits the right per-cwd path; undefined keeps the default fallback.
          workingDir,
          threadContext: payload.channelContext,
          initiatedBy: "system",
        })) {
          if (emit) emit({ ...message, agent: agentName });
        }
      }

      await this.approvalsRepo.markExecuted(approvalId);
      log.info("approval executed successfully", { approvalId });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error("approval execution failed", { approvalId, error: errorMsg });
      // Don't leak internal stack traces / DB errors / file paths to the
      // chat surface — keep the detailed error in server logs and emit a
      // generic message. The execution record (markExecutionFailed) still
      // captures the full reason for debugging.
      emit?.({
        type: "tool_result",
        toolUseId: traceId,
        tool: payload.actionName,
        output: { error: "Action execution failed. See server logs for details." },
        agent: agentName,
      });
      try {
        await this.approvalsRepo.markExecutionFailed(approvalId, errorMsg);
      } catch {
        // Best-effort — failure already logged above
      }
    }
  }

  async onRejected(approvalId: string): Promise<void> {
    const approval = await this.approvalsRepo.findById(approvalId);
    if (!approval) return;

    const payload = approval.payload as ApprovalPayload | null;

    if (payload?.sessionId) {
      try {
        const agentName = payload.agentName ?? "main";
        const workingDir = await this.resolveWorkingDir?.(
          payload.channelContext?.channel ?? "",
          payload.channelContext?.threadId ?? "",
        );
        const params = {
          agentName,
          prompt: `The action "${payload.actionName}" you requested has been rejected by the guardian.`,
          sessionId: payload.sessionId,
          channelThreadKey: payload.channelThreadKey,
          // Resume in the session's own project dir (per-cwd SDK transcript);
          // undefined keeps the default-dir fallback.
          workingDir,
          threadContext: payload.channelContext,
          initiatedBy: "system" as const,
        };
        for await (const message of this.agentRunner.run(params)) {
          void message;
        }
      } catch (err) {
        log.error("failed to notify agent of rejection", {
          approvalId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info("approval rejected", {
      approvalId,
      rootExecutionId: payload?.rootExecutionId,
    });
  }
}
