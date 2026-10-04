import {
  getCurrentActionContext,
  type CurrentActionContext,
  type RomeSessionType,
} from "@rome-os/app-runtime";
import type {
  RomeAgentTranscriptMessageInput,
  RomeAgentTraceTriggerMetadata,
  WebChatRepository,
} from "../db/repositories/webchat.js";
import type { AgentEvent, MessagePart } from "../types.js";
import type { ThreadContext } from "./types.js";
import { toTraceEvent, type TraceableEvent } from "../api/helpers.js";
import type { Logger } from "../logger.js";
import { isCoreMainAgentId } from "../apps/artifact-id.js";
import { isTransientDelta } from "./agent-message.js";

export interface AgentTraceRecorderInput {
  webchatRepo: WebChatRepository;
  agentName: string;
  agentSessionId?: string;
  /** Explicit Rome session identity shared with the executing AgentSession turn. */
  romeSessionId?: string;
  channelThreadKey?: string;
  turnId: string;
  existingSessionId?: string;
  traceMessageId?: string;
  threadContext?: ThreadContext;
  actionContext?: CurrentActionContext;
  /**
   * Whether to persist user/assistant transcript rows alongside the trace.
   * Defaults to `!existingSessionId`: pre-existing sessions (webchat) own
   * their transcript elsewhere, while recorder-created sessions need it here.
   * Forked runs pass an existing session id AND want the transcript, since no
   * other writer owns their session.
   */
  persistTranscript?: boolean;
  /** Inbound conversation messages are already persisted before dispatch. */
  persistUserTranscript?: boolean;
  /**
   * Explicit trigger metadata stamped on the trace message row. When absent,
   * falls back to the ambient action context.
   */
  trigger?: RomeAgentTraceTriggerMetadata;
}

export interface RomeSessionIdInput {
  agentName: string;
  agentSessionId?: string;
  romeSessionId?: string;
  existingSessionId?: string;
  channelThreadKey?: string;
  threadContext?: ThreadContext;
  actionContext?: CurrentActionContext;
}

export function resolveRomeSessionId(input: RomeSessionIdInput): string {
  if (input.romeSessionId) return input.romeSessionId;
  if (input.existingSessionId) return input.existingSessionId;
  if (input.threadContext) {
    if (input.threadContext.channel === "webchat") {
      return input.threadContext.threadId;
    }
    return `channel:${input.threadContext.channel}:${input.threadContext.threadId}`;
  }
  const actionContext = input.actionContext ?? getCurrentActionContext();
  if (actionContext?.executionId) {
    return `action:${actionContext.executionId}:${input.agentName || "main"}`;
  }
  return `action:${input.channelThreadKey ?? input.agentName}:${input.agentName || "main"}`;
}

export function resolveRomeSessionType(
  input: Pick<RomeSessionIdInput, "threadContext">,
): RomeSessionType {
  if (input.threadContext?.channel === "webchat") return "webchat";
  return input.threadContext ? "channel" : "action";
}

export class AgentTraceRecorder {
  private ensured = false;
  private seq = 0;
  private persistedUserTurnIds = new Set<string>();
  private persistedAssistantTurnIds = new Set<string>();

  constructor(private input: AgentTraceRecorderInput) {}

  async record(msg: AgentEvent & { agent?: string }): Promise<void> {
    await this.recordBatch([msg], this.seq);
  }

  async recordBatch(
    messages: (AgentEvent & { agent?: string })[],
    startSeq = this.seq,
  ): Promise<void> {
    const blocks = messages.flatMap((msg) =>
      isTransientDelta(msg) || msg.type === "input_status"
        ? []
        : [toTraceEvent(msg as TraceableEvent & { agent?: string })],
    );
    if (blocks.length === 0) return;
    await this.ensureSession();
    const sessionId = this.romeSessionId();
    const trigger = this.triggerMetadata();
    const transcriptMessages = this.transcriptMessages(sessionId, messages);
    await this.input.webchatRepo.appendTraceBlocks({
      messageId: this.traceMessageId(sessionId),
      sessionId,
      turnId: this.input.turnId,
      startSeq,
      blocks,
      trigger,
      transcriptMessages,
    });
    this.markTranscriptMessagesPersisted(transcriptMessages);
    this.seq = Math.max(this.seq, startSeq + blocks.length);
  }

  private async ensureSession(): Promise<void> {
    if (this.ensured) return;
    if (this.input.existingSessionId) {
      this.ensured = true;
      return;
    }
    const thread = this.input.threadContext;
    const type = this.sessionType();
    const sourceThreadName = thread?.threadName ?? null;
    const trigger = this.triggerMetadata();
    await this.input.webchatRepo.ensureRomeSession({
      id: this.romeSessionId(),
      type,
      name:
        sourceThreadName ??
        (thread
          ? `${thread.channel}:${thread.threadId}`
          : (this.input.channelThreadKey ?? this.input.agentName)),
      agentName: isCoreMainAgentId(this.input.agentName) ? null : this.input.agentName,
      projectName: thread?.projectName,
      projectPath: thread?.projectPath,
      sourceChannel: thread?.channel ?? null,
      sourceThreadId: thread?.threadId ?? null,
      sourceThreadName,
      sourceThreadType: thread?.threadType ?? null,
      trigger: type === "action" ? trigger : undefined,
    });
    this.ensured = true;
  }

  private romeSessionId(): string {
    return resolveRomeSessionId({
      ...this.input,
      actionContext: this.currentActionContext(),
    });
  }

  private traceMessageId(sessionId: string): string {
    return this.input.traceMessageId ?? `trace-message:${sessionId}:${this.input.turnId}`;
  }

  private sessionType(): RomeSessionType {
    return resolveRomeSessionType(this.input);
  }

  private triggerMetadata(): RomeAgentTraceTriggerMetadata | undefined {
    if (this.input.trigger) return this.input.trigger;
    const ctx = this.currentActionContext();
    if (!ctx?.executionId && !ctx?.actionName) return undefined;
    return {
      triggerKind: "action",
      triggerName: ctx.actionName ?? null,
      triggerActionName: ctx.actionName ?? null,
      triggerExecutionId: ctx.executionId ?? null,
      rootActionExecutionId: ctx.rootExecutionId ?? null,
      parentActionExecutionId: ctx.parentExecutionId ?? null,
    };
  }

  private currentActionContext(): CurrentActionContext | undefined {
    return this.input.actionContext ?? getCurrentActionContext();
  }

  private shouldPersistTranscript(): boolean {
    return this.input.persistTranscript ?? !this.input.existingSessionId;
  }

  private transcriptMessages(
    sessionId: string,
    messages: (AgentEvent & { agent?: string })[],
  ): RomeAgentTranscriptMessageInput[] {
    if (!this.shouldPersistTranscript()) return [];
    const rows: RomeAgentTranscriptMessageInput[] = [];
    if (this.input.persistUserTranscript ?? true) {
      for (const msg of messages) {
        if (msg.type !== "turn_start") continue;
        if (this.persistedUserTurnIds.has(msg.turnId)) continue;
        rows.push({
          id: transcriptMessageId(sessionId, msg.turnId, "user"),
          sessionId,
          role: "user",
          content: textMessageContent(msg.userPrompt),
          turnId: msg.turnId,
        });
      }
    }

    for (const msg of messages) {
      if (msg.type !== "result") continue;
      if (!msg.content.trim()) continue;
      if (this.persistedAssistantTurnIds.has(this.input.turnId)) continue;
      rows.push({
        id: transcriptMessageId(sessionId, this.input.turnId, "assistant"),
        sessionId,
        role: "assistant",
        content: textMessageContent(msg.content),
        turnId: this.input.turnId,
      });
    }
    return rows;
  }

  private markTranscriptMessagesPersisted(messages: RomeAgentTranscriptMessageInput[]): void {
    for (const message of messages) {
      if (!message.turnId) continue;
      if (message.role === "user") {
        this.persistedUserTurnIds.add(message.turnId);
      } else if (message.role === "assistant") {
        this.persistedAssistantTurnIds.add(message.turnId);
      }
    }
  }
}

export function shouldPersistAgentTrace(threadContext?: ThreadContext): boolean {
  return threadContext?.channel !== "webchat";
}

function textMessageContent(content: string): string {
  const parts: MessagePart[] = [{ type: "text", content }];
  return JSON.stringify(parts);
}

function transcriptMessageId(
  sessionId: string,
  turnId: string,
  role: RomeAgentTranscriptMessageInput["role"],
): string {
  return `transcript-message:${sessionId}:${turnId}:${role}`;
}

export async function recordAgentTraceBestEffort(
  recorder: AgentTraceRecorder | null,
  msg: AgentEvent & { agent?: string },
  log: Pick<Logger, "warn">,
  context: { turnId: string; source: string },
): Promise<void> {
  if (!recorder) return;
  try {
    await recorder.record(msg);
  } catch (err) {
    log.warn("failed to persist agent trace", {
      turnId: context.turnId,
      source: context.source,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
