import {
  getCurrentActionContext,
  type CurrentActionContext,
  type RomeSessionType,
} from "@rome-os/app-runtime";
import { channelChatId } from "../../db/session-kind.js";
import type {
  RomeAgentTranscriptMessageInput,
  RomeAgentTraceTriggerMetadata,
  WebChatRepository,
} from "../../db/repositories/webchat.js";
import type { AgentEvent } from "../../types.js";
import { textMessageContent, transcriptMessageId } from "../../chats/storage/transcript-rows.js";
import type { ThreadContext } from "../../core/types.js";
import { toTraceEvent, type TraceableEvent } from "../../api/helpers.js";
import type { Logger } from "../../logger.js";
import { isCoreMainAgentId } from "../../apps/artifact-id.js";
import { isTransientDelta } from "../../core/agent-message.js";
import type { SessionConversation } from "./session-conversation.js";

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
  /** A reply the host streams records its own assistant row, as the text it
   *  showed, so the turn's answer is not recorded twice. */
  persistAssistantTranscript?: boolean | (() => boolean);
  /** Keep the turn's prompt and answer in the session's own rows too, whatever
   *  of them the caller writes itself. Set by the session's log. */
  keepSessionMessages?: boolean;
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
    if (input.threadContext.romeSessionId) return input.threadContext.romeSessionId;
    return channelChatId(input.threadContext.channel, input.threadContext.threadId);
  }
  const actionContext = input.actionContext ?? getCurrentActionContext();
  if (actionContext?.executionId) {
    return `action:${actionContext.executionId}:${input.agentName || "main"}`;
  }
  return `action:${input.channelThreadKey ?? input.agentName}:${input.agentName || "main"}`;
}

export interface TurnConversationInput extends RomeSessionIdInput {
  /** The conversation the session serves, as it stood when the turn started. */
  sessionConversation?: SessionConversation;
}

// Conversations whose turns only the recorder writes. A webchat conversation
// belongs to the webchat route, and a channel one to the inbox, which also
// injects its pending context on a channel turn.
const RECORDER_OWNED_CONVERSATION_TYPES: ReadonlySet<RomeSessionType> = new Set([
  "subagent",
  "fork",
]);

/**
 * The conversation a turn records into, and its type. A conversation the
 * caller named wins. Otherwise a recorded subagent or fork conversation is
 * used, and the id is derived as before for anything else. `existing` is true
 * for a named or recorded conversation, which needs no creating.
 * `promptPersisted` is true only for a named one, whose caller owns the prompt.
 * `recorderOwned` is true for a recorded one, which only the recorder writes.
 *
 * A turn under a thread stays with that thread's conversation, as before. Its
 * reply is delivered and recorded there under the turn's id, so the trace has
 * to be found there too, and a webchat card is answered by looking its turn up
 * in that chat. That covers backend and approval turns on a subagent or side
 * chat.
 */
export function resolveTurnConversation(input: TurnConversationInput): {
  romeSessionId: string;
  romeSessionType: RomeSessionType;
  existing: boolean;
  promptPersisted: boolean;
  recorderOwned: boolean;
} {
  const conversation = input.sessionConversation;
  // The opener's named conversation wins over the one this turn's caller names.
  const named = conversation?.origin === "named" ? conversation.id : input.romeSessionId;
  const found = !named && conversation?.origin === "recorded" ? conversation : undefined;
  const ownedByRecorder =
    found !== undefined &&
    RECORDER_OWNED_CONVERSATION_TYPES.has(found.type) &&
    !input.threadContext;
  const recorded = ownedByRecorder ? found : undefined;
  return {
    romeSessionId: resolveRomeSessionId({
      ...input,
      romeSessionId: named ?? recorded?.id,
    }),
    romeSessionType: recorded?.type ?? resolveRomeSessionType(input),
    existing: Boolean(named ?? recorded),
    promptPersisted: Boolean(named),
    recorderOwned: Boolean(recorded),
  };
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
  private keptSessionMessageIds = new Set<string>();

  constructor(private input: AgentTraceRecorderInput) {}

  async record(msg: AgentEvent & { agent?: string }): Promise<void> {
    await this.recordBatch([msg], this.seq);
  }

  /** Keeps what a system turn was handed, under its label, as one trace block. */
  async recordSystemInput(label: string, content: string): Promise<void> {
    await this.ensureSession();
    const sessionId = this.romeSessionId();
    await this.input.webchatRepo.appendTraceBlocks({
      messageId: this.traceMessageId(sessionId),
      sessionId,
      turnId: this.input.turnId,
      startSeq: this.seq,
      blocks: [{ type: "system_input", label, content }],
      trigger: this.triggerMetadata(),
      transcriptMessages: [],
    });
    this.seq += 1;
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
    const sessionMessages = this.sessionMessages(sessionId, messages);
    await this.input.webchatRepo.appendTraceBlocks({
      messageId: this.traceMessageId(sessionId),
      sessionId,
      turnId: this.input.turnId,
      startSeq,
      blocks,
      trigger,
      transcriptMessages,
      ...(sessionMessages.length > 0 ? { sessionMessages } : {}),
    });
    this.markTranscriptMessagesPersisted(transcriptMessages);
    for (const message of sessionMessages) this.keptSessionMessageIds.add(message.id);
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

    const persistAnswer = this.input.persistAssistantTranscript;
    if (typeof persistAnswer === "function" ? persistAnswer() : (persistAnswer ?? true)) {
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
    }
    return rows;
  }

  /**
   * The turn's prompt and answer as the session keeps them, beside its trace,
   * whatever the caller writes of them itself. Where the session stands in a
   * chat they are its own copy; Chats keeps its own in the chat.
   */
  private sessionMessages(
    sessionId: string,
    messages: (AgentEvent & { agent?: string })[],
  ): RomeAgentTranscriptMessageInput[] {
    if (!this.input.keepSessionMessages) return [];
    const rows: RomeAgentTranscriptMessageInput[] = [];
    const keep = (turnId: string, role: "user" | "assistant", text: string) => {
      const id = transcriptMessageId(sessionId, turnId, role);
      if (this.keptSessionMessageIds.has(id)) return;
      rows.push({ id, sessionId, role, content: textMessageContent(text), turnId });
    };
    for (const msg of messages) {
      if (msg.type === "turn_start") keep(msg.turnId, "user", msg.userPrompt);
      else if (msg.type === "result" && msg.content.trim())
        keep(this.input.turnId, "assistant", msg.content);
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
