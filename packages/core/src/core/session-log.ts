import type { WebChatRepository } from "../db/repositories/webchat.js";
import { channelChatId } from "../db/session-kind.js";
import { createLogger } from "../logger.js";
import { isCoreMainAgentId } from "../apps/artifact-id.js";
import type { LoggedFork, LoggedTurn, SessionLog, TurnLogWriter } from "./agent-session.js";
import { AgentTraceRecorder, recordAgentTraceBestEffort } from "./agent-trace-recorder.js";
import { findRecordedConversation } from "./session-conversation.js";
import { callerChatId, callerFromKey } from "./session-caller.js";

const log = createLogger("session-log");

/**
 * Conversations Chats named for callers whose stored form carries none, held
 * while their session opens. A chat's own caller names its chat; a place or a
 * run that Chats keeps in a conversation is named here.
 */
const named = new Map<string, string>();

/**
 * Opens a session of `caller` with `chatId` as the conversation today's rows
 * keep its turns in. Storage keeps that link on the session's row, so it is
 * only needed while the session opens.
 */
export async function openNamed<T>(
  caller: string,
  chatId: string | undefined,
  open: () => Promise<T>,
): Promise<T> {
  if (!chatId) return await open();
  named.set(caller, chatId);
  try {
    return await open();
  } finally {
    if (named.get(caller) === chatId) named.delete(caller);
  }
}

/**
 * The sessions' log over today's rows. A turn is written into the
 * conversation the session resolved for it, through the trace recorder, and a
 * fork registers a conversation of its own under its parent's. Storage is
 * unchanged, so this is where a session's id meets the rows that keep it.
 */
export function createSessionLog(webchatRepo: WebChatRepository | undefined): SessionLog {
  return {
    findConversation: (id) => findRecordedConversation(webchatRepo, id),
    conversationOf: (caller) => named.get(caller) ?? callerChatId(callerFromKey(caller)),
    turn: webchatRepo ? (turn) => turnWriter(webchatRepo, turn) : undefined,
    fork: webchatRepo ? (fork) => forkWriter(webchatRepo, fork) : undefined,
  };
}

function writerOf(recorder: AgentTraceRecorder, turnId: string, source: string): TurnLogWriter {
  return {
    write: (event) => recordAgentTraceBestEffort(recorder, event, log, { turnId, source }),
    input: (label, prompt) =>
      recorder.recordSystemInput(label, prompt).catch((error: unknown) =>
        log.warn("system input not recorded", {
          turnId,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
  };
}

function turnWriter(webchatRepo: WebChatRepository, turn: LoggedTurn): TurnLogWriter {
  const { conversation } = turn;
  const recorder = new AgentTraceRecorder({
    webchatRepo,
    agentName: turn.agentName,
    agentSessionId: turn.sessionId,
    romeSessionId: conversation.romeSessionId,
    existingSessionId: conversation.existing ? conversation.romeSessionId : undefined,
    channelThreadKey: turn.caller,
    turnId: turn.turnId,
    threadContext: turn.replies,
    ...(turn.execution ? { actionContext: turn.execution } : {}),
    persistTranscript: true,
    persistUserTranscript: turn.writes.prompt,
    persistAssistantTranscript: turn.writes.answer,
  });
  return writerOf(recorder, turn.turnId, "agent-session");
}

/**
 * Registers the fork's conversation, under its source's, and writes the fork's
 * turn there. A failure to register degrades to no record, with a warning.
 */
async function forkWriter(
  webchatRepo: WebChatRepository,
  fork: LoggedFork,
): Promise<TurnLogWriter | undefined> {
  try {
    const thread = fork.replies;
    // Prefer the source's conversation while it exists. Read again rather
    // than trusting the session's cached row, which can outlive a deletion.
    // The fallbacks cover rows that recorded none, or one since deleted.
    const recorded = await findRecordedConversation(webchatRepo, fork.sourceConversation);
    const parentSessionId =
      recorded?.id ??
      thread?.romeSessionId ??
      (thread ? channelChatId(thread.channel, thread.threadId) : null);
    const parent =
      recorded ?? (parentSessionId ? await webchatRepo.getSession(parentSessionId) : null);
    const parentName = parent?.name ?? thread?.threadName ?? fork.sourceSessionId;
    const label = fork.label ?? "fork";
    const trigger = { triggerKind: "fork", triggerName: label };
    await webchatRepo.ensureRomeSession({
      id: fork.forkSessionId,
      type: "fork",
      name: `${label}: ${parentName}`,
      agentName: isCoreMainAgentId(fork.agentName) ? null : fork.agentName,
      projectName: thread?.projectName,
      projectPath: thread?.projectPath,
      // Later turns of the side chat read the folder from this row.
      deviceFolder: thread?.deviceFolder ?? null,
      trigger,
      parentSessionId: parent ? parentSessionId : null,
      parentTurnId: parent ? (fork.parentTurnId ?? null) : null,
    });
    const recorder = new AgentTraceRecorder({
      webchatRepo,
      agentName: fork.agentName,
      channelThreadKey: fork.caller,
      turnId: fork.turnId,
      existingSessionId: fork.forkSessionId,
      threadContext: fork.replies,
      persistTranscript: true,
      trigger,
    });
    return writerOf(recorder, fork.turnId, "agent-session:fork");
  } catch (err) {
    log.warn("failed to register forked run session; skipping trace persistence", {
      agent: fork.agentName,
      sourceSessionId: fork.sourceSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
