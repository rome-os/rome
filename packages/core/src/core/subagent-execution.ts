import {
  refuseResume,
  storedAgentName,
  storeSubagentParent,
  SubagentOutcomeReader,
  subagentRequest,
  subagentSessionName,
  type SubagentOutcome,
} from "../agent/index.js";
import type { StreamAgentEvent } from "@rome-os/app-runtime";
import type { Attributes } from "@opentelemetry/api";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import { openedInChat } from "./session-conversation.js";
import { createLogger } from "../logger.js";
import type { AgentSessionManager } from "./agent-session.js";
import { AgentTraceRecorder, recordAgentTraceBestEffort } from "./agent-trace-recorder.js";
import type { ThreadContext } from "./types.js";
import type { ActiveSubagentRegistry, ParentSubagentRef } from "./active-subagent-registry.js";
import type { AgentTurnStreamRegistry } from "./agent-turn-stream-registry.js";

const log = createLogger("subagent-execution");

export interface ExecuteSubagentInput {
  prompt: string;
  resumeSessionId?: string;
}

/** How a subagent call ended, with the session and turn that answered it. */
export type SubagentCompletion = SubagentOutcome & { sessionId: string; turnId: string };

export interface SubagentExecution {
  sessionId: string;
  turnId: string;
  agentName: string;
  events: AsyncIterable<StreamAgentEvent>;
  completion: Promise<SubagentCompletion>;
  interrupt(reason?: string): Promise<void>;
}

export interface StartSubagentContext {
  /** Durable Rome session id used for persistence and parent ownership. */
  parentSessionId: string;
  /** Runtime AgentSession id used by lifecycle parent references. */
  parentAgentSessionId: string;
  parentTurnId: string;
  parentToolUseId: string;
  parentAgentName: string;
  parentChannelThreadKey: string;
  childManager: AgentSessionManager;
  workingDir: string;
  threadContext?: ThreadContext;
  sharedContext?: Record<string, unknown>;
  /** What the parent's tools run with; the subagent's run with the same. */
  toolEnv?: Record<string, string | undefined>;
  /** What the parent stamps on its turns' spans; the subagent's carry the same. */
  spanAttributes?: Attributes;
}

/** A subagent's session shows no cards and takes no wake-ups; its tools and spans carry its parent's. */
function subagentOpening(context: StartSubagentContext) {
  return {
    drawsCards: false,
    guardianFacing: false,
    toolEnv: context.toolEnv,
    spanAttributes: context.spanAttributes,
  };
}

export interface SubagentExecutionService {
  startSubagent(
    name: string,
    input: ExecuteSubagentInput,
    context: StartSubagentContext,
  ): Promise<SubagentExecution>;
}

export function createSubagentExecutionService(deps: {
  webchatRepo: WebChatRepository;
  activeRegistry: ActiveSubagentRegistry;
  turnStreams: AgentTurnStreamRegistry;
}): SubagentExecutionService {
  return {
    async startSubagent(name, input, context) {
      const request = subagentRequest(input);
      const parentSession = await deps.webchatRepo.getSession(context.parentSessionId);

      let child;
      let isFresh = false;
      if (request.resumeSessionId) {
        const stored = parentSession
          ? await deps.webchatRepo.getSession(request.resumeSessionId)
          : null;
        const refusal = refuseResume(
          stored && {
            type: stored.type,
            agentName: stored.agentName ?? null,
            parentSessionId: stored.parentSessionId ?? null,
            projectPath: stored.projectPath ?? null,
          },
          parentSession && { projectPath: parentSession.projectPath ?? null },
          {
            subagent: name,
            parentRecordId: context.parentSessionId,
            resumeSessionId: request.resumeSessionId,
          },
        );
        if (refusal) throw new Error(refusal);
        child = await context.childManager.acquireBySessionId(request.resumeSessionId, name, {
          workingDir: context.workingDir,
          threadContext: context.threadContext,
          sharedContext: context.sharedContext,
          ...subagentOpening(context),
        });
        // Naming the chat lets the resume fill a row whose record failed when
        // the subagent was minted.
        await openedInChat(deps.webchatRepo, child, request.resumeSessionId);
      } else {
        isFresh = true;
        child = await context.childManager.acquire(
          {
            agentName: name,
            channelThreadKey: storeSubagentParent(context.parentChannelThreadKey),
          },
          {
            workingDir: context.workingDir,
            threadContext: context.threadContext,
            sharedContext: context.sharedContext,
            ...subagentOpening(context),
          },
        );
        await openedInChat(deps.webchatRepo, child, undefined);
      }

      if (isFresh) {
        await deps.webchatRepo.ensureRomeSession({
          id: child.sessionId,
          type: "subagent",
          name: subagentSessionName(name, parentSession?.name, context.parentAgentName),
          agentName: storedAgentName(name),
          projectName: parentSession?.projectName,
          projectPath: parentSession?.projectPath,
          parentSessionId: context.parentSessionId,
          parentTurnId: context.parentTurnId,
        });
        // A subagent's chat is minted under its own session id.
        try {
          await deps.webchatRepo.recordSessionInChat(child.sessionId, child.sessionId);
        } catch (err) {
          log.warn("failed to record the chat that has the subagent's session", {
            agentName: name,
            sessionId: child.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const handle = child.sendTurn(
        { prompt: request.prompt },
        {
          lifecycleParent: {
            sessionId: context.parentAgentSessionId,
            turnId: context.parentTurnId,
            agentName: context.parentAgentName,
          },
          threadContext: context.threadContext,
          sharedContext: context.sharedContext,
          romeSessionId: child.sessionId,
          romeSessionType: "subagent",
          initiatedBy: "system",
        },
      );

      let resolveCompletion!: (completion: SubagentCompletion) => void;
      const completion = new Promise<SubagentCompletion>((resolve) => {
        resolveCompletion = resolve;
      });
      let active = true;
      const interrupt = async (reason?: string): Promise<void> => {
        if (!active) return;
        await child.interrupt(reason);
      };
      const stream = deps.turnStreams.register({
        sessionId: child.sessionId,
        // The subagent's row is saved above, under its own session id.
        chatId: child.sessionId,
        turnId: handle.turnId,
        agentName: name,
        interrupt,
      });

      const events = (): AsyncIterable<StreamAgentEvent> => ({
        [Symbol.asyncIterator]() {
          const queued = [...stream.messages()];
          const waiters: Array<(value: IteratorResult<StreamAgentEvent>) => void> = [];
          let done = stream.finished;
          const unsubscribe = stream.subscribe((message) => {
            const waiter = waiters.shift();
            if (waiter) waiter({ value: message, done: false });
            else queued.push(message);
          });
          void stream.waitForFinish().then(() => {
            done = true;
            unsubscribe();
            while (waiters.length > 0) waiters.shift()?.({ value: undefined, done: true });
          });
          return {
            next(): Promise<IteratorResult<StreamAgentEvent>> {
              const value = queued.shift();
              if (value) return Promise.resolve({ value, done: false });
              if (done) return Promise.resolve({ value: undefined, done: true });
              return new Promise((resolve) => waiters.push(resolve));
            },
            return(): Promise<IteratorResult<StreamAgentEvent>> {
              unsubscribe();
              return Promise.resolve({ value: undefined, done: true });
            },
          };
        },
      });

      const execution: SubagentExecution = {
        sessionId: child.sessionId,
        turnId: handle.turnId,
        agentName: name,
        events: events(),
        completion,
        interrupt,
      };
      const parentRef: ParentSubagentRef = {
        sessionId: context.parentSessionId,
        turnId: context.parentTurnId,
        toolUseId: context.parentToolUseId,
      };
      try {
        deps.activeRegistry.register(
          parentRef,
          { sessionId: child.sessionId, turnId: handle.turnId },
          execution,
        );
      } catch (err) {
        stream.finish();
        await child.interrupt("subagent registration failed").catch(() => undefined);
        throw err;
      }

      const recorder = new AgentTraceRecorder({
        webchatRepo: deps.webchatRepo,
        agentName: name,
        turnId: handle.turnId,
        existingSessionId: child.sessionId,
        threadContext: context.threadContext,
        persistTranscript: true,
      });

      void (async () => {
        const outcome = new SubagentOutcomeReader();
        try {
          for await (const message of handle.events) {
            stream.publish(message);
            await recordAgentTraceBestEffort(recorder, message, log, {
              turnId: handle.turnId,
              source: "subagent-execution",
            });
            outcome.read(message);
          }
          resolveCompletion({
            ...outcome.outcome(),
            sessionId: child.sessionId,
            turnId: handle.turnId,
          });
        } catch (err) {
          resolveCompletion({
            status: "failed",
            sessionId: child.sessionId,
            turnId: handle.turnId,
            error: { message: err instanceof Error ? err.message : String(err) },
          });
        } finally {
          active = false;
          stream.finish();
        }
      })();

      return execution;
    },
  };
}
