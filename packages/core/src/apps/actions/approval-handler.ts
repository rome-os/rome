import type { ApprovalsRepository } from "../repositories/approvals.js";
import type { ExecutionJournalRepository } from "../repositories/execution-journal.js";
import type { ActionEngine, ActionRunContext } from "./engine.js";
import type { ActionResult } from "./types.js";
import type { AgentRunnerInterface, ThreadContext } from "../../core/types.js";
import type { AgentEvent } from "../../types.js";
import type { JournalEntry } from "./replay.js";
import type { ApprovalSessionRunner } from "./session-runner.js";
import { createLogger } from "../../logger.js";
import { withoutSessionActor, type SessionActor } from "../../access/session-actor.js";

const log = createLogger("approval-handler");

interface ApprovalPayload {
  actionName: string;
  args: Record<string, unknown>;
  rootActionName: string;
  rootArgs: Record<string, unknown>;
  rootExecutionId: string;
  replayJournal: JournalEntry[];
  channelContext?: ThreadContext;
  sharedContext?: Record<string, unknown>;
  sessionId?: string;
  agentName?: string;
  channelThreadKey?: string;
}

/** The person an execution acted for, as its row records, for {@link ApprovalHandler}'s requester. */
export function executionRequester(executions: {
  findById(id: string): Promise<{ actor?: unknown } | null>;
}): (rootExecutionId: string) => Promise<SessionActor | undefined> {
  return async (rootExecutionId) =>
    ((await executions.findById(rootExecutionId))?.actor as SessionActor | null) ?? undefined;
}

export interface ActionApprovalResolutionObserver {
  approvalRejected(actionName: string, args: Record<string, unknown>): Promise<void> | void;
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
  if (result.status === "place_widget") {
    return `The action you requested was approved and executed; the "${result.placement.appId}" widget has been placed on the guardian's workspace.`;
  }
  if (result.status === "show_widget") {
    return `The action you requested was approved and executed. ${result.widget.text}`;
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
    private backendTurnRunner: ApprovalSessionRunner,
    /** Resolve the continued session's project working dir from its (channel,
     * thread). An approval resume — like defer — runs the SDK turn on a fresh
     * stack that never carried the dir, so without this it falls back to the
     * default project and the per-cwd transcript resume fails with "No
     * conversation found". Undefined ⇒ keep the default-dir fallback. */
    private resolveWorkingDir?: (channel: string, threadId: string) => Promise<string | undefined>,
    private resolutionObserver?: ActionApprovalResolutionObserver,
    /**
     * The person the turn that asked for the approval acted for, read from the
     * approval's root execution. The approved action and the resumed turn act
     * for them, never for the guardian who approved. Absent, for no one.
     */
    private requesterOf: (
      rootExecutionId: string,
    ) => Promise<SessionActor | undefined> = async () => undefined,
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

    if (typeof rawPayload.rootActionName !== "string" || !Array.isArray(rawPayload.replayJournal)) {
      log.error("approval payload missing its root call", { approvalId });
      await this.approvalsRepo.markExecutionFailed(
        approvalId,
        "approval payload missing required fields: rootActionName, replayJournal",
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

  /**
   * Runs the approved action and the resumed turn outside the approver's
   * request: both name the requester explicitly, so the guardian who clicked
   * Approve is never who they act for.
   */
  private executeApprovedAction(
    approvalId: string,
    payload: ApprovalPayload,
    emit?: (msg: AgentEvent & { agent?: string }) => void,
  ): Promise<void> {
    return withoutSessionActor(() => this.runApprovedAction(approvalId, payload, emit));
  }

  private async runApprovedAction(
    approvalId: string,
    payload: ApprovalPayload,
    emit?: (msg: AgentEvent & { agent?: string }) => void,
  ): Promise<void> {
    const agentName = payload.agentName ?? "main";
    // The trace stream is shaped around AgentEvent, so we synthesize a
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

      // The engine records the root call and its journal with every approval,
      // so approving replays the root and resumes at the approved call. It
      // runs for the person who asked, not the guardian who approved.
      const requester = await this.requesterOf(payload.rootExecutionId);
      const runContext: ActionRunContext = {
        initiator: `approval:${approvalId}`,
        ...(requester ? { actor: requester } : {}),
        replayJournal: payload.replayJournal,
        replayRootExecutionId: payload.rootExecutionId,
        channelContext: payload.channelContext,
        sharedContext: payload.sharedContext,
        sessionId: payload.sessionId,
        agentName: payload.agentName,
        channelThreadKey: payload.channelThreadKey,
      };
      const result = await this.actionEngine.run(
        payload.rootActionName,
        payload.rootArgs,
        runContext,
      );

      emit?.({
        type: "tool_result",
        toolUseId: traceId,
        tool: payload.actionName,
        output: result,
        isError: result.status === "error",
        agent: agentName,
      });

      if (payload.sessionId) {
        const resultText = formatResultForAgent(result);
        const workingDir = await this.resolveWorkingDir?.(
          payload.channelContext?.channel ?? "",
          payload.channelContext?.threadId ?? "",
        );
        const channel = payload.channelContext?.channel;
        const threadId = payload.channelContext?.threadId;
        const messaging = Boolean(channel && threadId && channel !== "webchat");
        let reply = "";
        let turnId: string | undefined;
        for await (const message of this.agentRunner.run({
          agentName,
          prompt: resultText,
          // The resumed turn acts for the person whose turn asked.
          ...(requester ? { actor: requester } : {}),
          sessionId: payload.sessionId,
          channelThreadKey: payload.channelThreadKey,
          // Resume in the session's own project dir so the SDK transcript resume
          // hits the right per-cwd path; undefined keeps the default fallback.
          workingDir,
          threadContext: payload.channelContext,
          initiatedBy: "system",
          // The reply is recorded as it is said below, never twice, and a
          // reply that could not be said is not on record as said.
          ...(messaging ? { persistAnswer: false } : {}),
        })) {
          if (message.type === "turn_start") turnId = message.turnId;
          if (message.type === "result") reply = message.content;
          if (emit) emit({ ...message, agent: agentName });
        }
        // Webchat's reply rides the session stream through `emit`. A messaging
        // channel has no such stream, so its reply goes out on the channel.
        if (messaging && channel && threadId) {
          // The action already ran. A reply that cannot be sent must not mark
          // the approval's execution as failed.
          try {
            await this.backendTurnRunner.deliverMessagingReply(
              { agentName, channel, threadId },
              reply,
              turnId,
            );
          } catch (err) {
            log.error("approval continuation reply not delivered", {
              approvalId,
              channel,
              error: err instanceof Error ? err.message : String(err),
            });
          }
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
        isError: true,
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

    if (payload?.actionName && payload.args) {
      try {
        await this.resolutionObserver?.approvalRejected(payload.actionName, payload.args);
      } catch (err) {
        log.error("approval rejection observer failed", {
          approvalId,
          actionName: payload.actionName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (payload?.sessionId) {
      try {
        const agentName = payload.agentName ?? "main";
        const workingDir = await this.resolveWorkingDir?.(
          payload.channelContext?.channel ?? "",
          payload.channelContext?.threadId ?? "",
        );
        const requester = await this.requesterOf(payload.rootExecutionId);
        const params = {
          agentName,
          prompt: `The action "${payload.actionName}" you requested has been rejected by the guardian.`,
          ...(requester ? { actor: requester } : {}),
          sessionId: payload.sessionId,
          channelThreadKey: payload.channelThreadKey,
          // Resume in the session's own project dir (per-cwd SDK transcript);
          // undefined keeps the default-dir fallback.
          workingDir,
          threadContext: payload.channelContext,
          initiatedBy: "system" as const,
        };
        // The resumed turn runs outside the rejecting guardian's request.
        await withoutSessionActor(async () => {
          for await (const message of this.agentRunner.run(params)) {
            void message;
          }
        });
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
