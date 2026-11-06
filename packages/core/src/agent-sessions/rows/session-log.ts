import { AsyncLocalStorage } from "node:async_hooks";
import type { StreamAgentEvent } from "@rome-os/app-runtime";
import type { WebChatRepository } from "../../db/repositories/webchat.js";
import { channelChatId } from "../../db/session-kind.js";
import { createLogger } from "../../logger.js";
import { isCoreMainAgentId } from "../../apps/artifact-id.js";
import type {
  LoggedFork,
  LoggedTurn,
  SessionLog,
  TurnConversation,
  TurnLogEntry,
  TurnLogWriter,
} from "../agent-session.js";
import { AgentTraceRecorder, resolveTurnConversation } from "./agent-trace-recorder.js";
import { findRecordedConversation } from "./session-conversation.js";
import { callerFromKey, chatOfCaller } from "../../core/session-caller.js";

const log = createLogger("session-log");

/**
 * The conversation Chats named for the session an opener is opening, held
 * for that open's own async work only, so overlapping opens never read each
 * other's. A chat's own caller names its chat; a place or a run that Chats
 * keeps in a conversation is named here.
 */
const named = new AsyncLocalStorage<{ opener?: string; chatId: string }>();

/**
 * Opens a session, by its caller, by its id, or with no opener for one
 * `create` makes, with `chatId` as the
 * conversation today's rows keep its turns in. Storage keeps that link on the
 * session's row, so it is only needed while the session opens.
 */
export async function openNamed<T>(
  opener: string | undefined,
  chatId: string | undefined,
  open: () => Promise<T>,
): Promise<T> {
  if (!chatId) return await open();
  return await named.run({ opener, chatId }, open);
}

function namedFor(opener: string | undefined): string | undefined {
  const scope = named.getStore();
  return scope && scope.opener === opener ? scope.chatId : undefined;
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
    conversationOf: (opener) =>
      namedFor(opener) ?? (opener ? chatOfCaller(callerFromKey(opener)) : undefined),
    turn: (turn) => turnEntry(webchatRepo, turn),
    fork: webchatRepo ? (fork) => forkWriter(webchatRepo, fork) : undefined,
    resumableChild: webchatRepo ? (child) => resumableChild(webchatRepo, child) : undefined,
    childStarted: webchatRepo ? (child) => childStarted(webchatRepo, child) : undefined,
    endInterrupted: webchatRepo
      ? (windowMs) => webchatRepo.endInterruptedTurns(windowMs)
      : undefined,
  };
}

const MAX_WRITE_ATTEMPTS = 3;
const FINAL_RETRY_PAUSES_MS = [25, 100];

function writerOf(recorder: AgentTraceRecorder, turnId: string, source: string): TurnLogWriter {
  // Events a write failed to keep. Each write tries them again ahead of its
  // own, at the sequence the failed one would have taken, so a transient
  // failure drops no block and the turn goes on either way. After
  // MAX_WRITE_ATTEMPTS failures in a row the oldest is given up, so one block
  // that can never be written does not hold back the rest of the turn.
  let pending: StreamAgentEvent[] = [];
  let failures = 0;
  const writePending = async () => {
    try {
      await recorder.recordBatch(pending);
      pending = [];
      failures = 0;
    } catch (err) {
      failures += 1;
      const dropped = failures >= MAX_WRITE_ATTEMPTS ? pending.shift() : undefined;
      if (dropped) failures = 0;
      log.warn("failed to persist agent trace", {
        turnId,
        source,
        pending: pending.length,
        ...(dropped ? { dropped: dropped.type } : {}),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  const record = async (event: StreamAgentEvent) => {
    pending.push(event);
    await writePending();
  };
  // Nothing follows a turn's end to carry what is still pending, so the end
  // retries on its own, a few times with a short pause.
  const finish = async () => {
    for (const pause of FINAL_RETRY_PAUSES_MS) {
      if (pending.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, pause));
      await writePending();
    }
  };
  // Text streamed since the last complete text block. A turn that ends before
  // that block completes, an interrupt mid-answer, keeps what was streamed as
  // its final text, so the trace shows what the guardian saw.
  let streamed = "";
  let streamedBlockId: string | undefined;
  const keep = async (event: StreamAgentEvent) => {
    if (event.type === "text") {
      streamed = "";
      streamedBlockId = undefined;
    } else if (event.type === "turn_end" && streamed) {
      await record({
        type: "text",
        content: streamed,
        turnPhase: "final",
        ...(streamedBlockId ? { blockId: streamedBlockId } : {}),
        ...(event.agent ? { agent: event.agent } : {}),
      } as StreamAgentEvent);
      streamed = "";
      streamedBlockId = undefined;
    }
    await record(event);
    if (event.type === "turn_end") await finish();
  };
  return {
    write: (event) => {
      if (event.type === "text_delta") {
        streamed += event.content;
        if (event.blockId) streamedBlockId = event.blockId;
        return;
      }
      // Deltas and input statuses never reach the trace.
      if (event.type.endsWith("_delta") || event.type === "input_status") return;
      return keep(event);
    },
    input: (label, prompt) =>
      recorder.recordSystemInput(label, prompt).catch((error: unknown) =>
        log.warn("system input not recorded", {
          turnId,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
  };
}

/**
 * Where today's rows keep a turn. A child's turns go to its own conversation,
 * minted under its session id. Otherwise the conversation its opener named
 * wins, then a subagent or fork conversation the session's row recorded, then
 * the one its reply address or execution derives.
 */
export function conversationOfTurn(turn: LoggedTurn) {
  if (turn.child) {
    return {
      romeSessionId: turn.sessionId,
      romeSessionType: "subagent" as const,
      existing: true,
    };
  }
  const served = turn.served;
  const resolved = resolveTurnConversation({
    agentName: turn.agentName,
    agentSessionId: turn.sessionId,
    sessionConversation: served,
    channelThreadKey: turn.caller,
    threadContext: turn.replies,
    actionContext: turn.execution,
  });
  // A chat keeps its turns as the kind of chat its own record says.
  const named = served?.origin === "named" ? served : undefined;
  return named?.type && resolved.romeSessionId === named.id
    ? { ...resolved, romeSessionType: named.type }
    : resolved;
}

function turnEntry(webchatRepo: WebChatRepository | undefined, turn: LoggedTurn): TurnLogEntry {
  const conversation = conversationOfTurn(turn);
  const kept: TurnConversation = {
    romeSessionId: conversation.romeSessionId,
    romeSessionType: conversation.romeSessionType,
  };
  if (!webchatRepo) return { conversation: kept };
  // The session keeps the whole turn: its prompt, its trace and its answer,
  // whatever a caller keeps of them in its own record.
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
  });
  return { conversation: kept, writer: writerOf(recorder, turn.turnId, "agent-session") };
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

async function resumableChild(
  webchatRepo: WebChatRepository,
  child: { id: string; agentName: string; parent: string },
): Promise<void> {
  const parent = await webchatRepo.getSession(child.parent);
  if (!parent) throw new Error(`Parent Rome session "${child.parent}" was not found`);
  const stored = await webchatRepo.getSession(child.id);
  if (!stored || stored.type !== "subagent") {
    throw new Error(`Subagent session "${child.id}" was not found`);
  }
  const storedAgentName = stored.agentName ?? "main";
  if (storedAgentName !== child.agentName) {
    throw new Error(
      `Subagent session "${child.id}" belongs to agent "${storedAgentName}", not "${child.agentName}"`,
    );
  }
  if (stored.parentSessionId !== child.parent) {
    throw new Error(`Subagent session "${child.id}" belongs to a different Parent session`);
  }
  if ((stored.projectPath ?? null) !== (parent.projectPath ?? null)) {
    throw new Error(`Subagent session "${child.id}" belongs to a different project`);
  }
}

async function childStarted(
  webchatRepo: WebChatRepository,
  child: {
    id: string;
    agentName: string;
    parent: string;
    parentAgentName: string;
    parentTurnId: string;
  },
): Promise<void> {
  const parent = await webchatRepo.getSession(child.parent);
  await webchatRepo.ensureRomeSession({
    id: child.id,
    type: "subagent",
    name: `${child.agentName}: ${parent?.name ?? child.parentAgentName}`,
    agentName: isCoreMainAgentId(child.agentName) ? null : child.agentName,
    projectName: parent?.projectName,
    projectPath: parent?.projectPath,
    parentSessionId: child.parent,
    parentTurnId: child.parentTurnId,
  });
}
