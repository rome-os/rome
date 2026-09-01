import { v4 as uuidv4 } from "uuid";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import { createLogger } from "../logger.js";
import type { AgentSessionManager, StreamAgentMessage } from "./agent-session.js";
import { AgentTraceRecorder, recordAgentTraceBestEffort } from "./agent-trace-recorder.js";
import type { ThreadContext } from "./types.js";
import type { ActiveSubagentRegistry, ParentSubagentRef } from "./active-subagent-registry.js";
import type { AgentTurnStreamRegistry } from "./agent-turn-stream-registry.js";
import { isCoreMainAgentId } from "../apps/artifact-id.js";

const log = createLogger("subagent-execution");

export interface ExecuteSubagentInput {
  prompt: string;
  resumeSessionId?: string;
}

export type SubagentCompletion =
  | {
      status: "completed";
      sessionId: string;
      turnId: string;
      output: unknown;
    }
  | {
      status: "failed" | "cancelled";
      sessionId: string;
      turnId: string;
      error: { message: string; code?: string };
    };

export interface SubagentExecution {
  sessionId: string;
  turnId: string;
  agentName: string;
  events: AsyncIterable<StreamAgentMessage>;
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
      if (!input.prompt || typeof input.prompt !== "string") {
        throw new Error("execute_subagent requires a non-empty prompt");
      }
      const parentSession = await deps.webchatRepo.getSession(context.parentSessionId);

      let child;
      let isFresh = false;
      if (input.resumeSessionId) {
        if (!parentSession) {
          throw new Error(`Parent Rome session "${context.parentSessionId}" was not found`);
        }
        const stored = await deps.webchatRepo.getSession(input.resumeSessionId);
        if (!stored || stored.type !== "subagent") {
          throw new Error(`Subagent session "${input.resumeSessionId}" was not found`);
        }
        const storedAgentName = stored.agentName ?? "main";
        if (storedAgentName !== name) {
          throw new Error(
            `Subagent session "${input.resumeSessionId}" belongs to agent "${storedAgentName}", not "${name}"`,
          );
        }
        if (stored.parentSessionId !== context.parentSessionId) {
          throw new Error(
            `Subagent session "${input.resumeSessionId}" belongs to a different Parent session`,
          );
        }
        if ((stored.projectPath ?? null) !== (parentSession?.projectPath ?? null)) {
          throw new Error(
            `Subagent session "${input.resumeSessionId}" belongs to a different project`,
          );
        }
        if (!context.childManager.acquireBySessionId) {
          throw new Error("Child AgentSessionManager cannot resume by session ID");
        }
        child = await context.childManager.acquireBySessionId(input.resumeSessionId, name, {
          workingDir: context.workingDir,
          threadContext: context.threadContext,
          sharedContext: context.sharedContext,
        });
      } else {
        isFresh = true;
        child = await context.childManager.acquire(
          {
            agentName: name,
            channelThreadKey: `${context.parentChannelThreadKey}:subagent:${uuidv4()}`,
          },
          {
            workingDir: context.workingDir,
            threadContext: context.threadContext,
            sharedContext: context.sharedContext,
            forceNewSession: true,
          },
        );
      }

      if (isFresh) {
        await deps.webchatRepo.ensureRomeSession({
          id: child.sessionId,
          type: "subagent",
          name: `${name}: ${parentSession?.name ?? context.parentAgentName}`,
          agentName: isCoreMainAgentId(name) ? null : name,
          projectName: parentSession?.projectName,
          projectPath: parentSession?.projectPath,
          sourceChannel: parentSession?.sourceChannel,
          sourceThreadId: parentSession?.sourceThreadId,
          sourceThreadName: parentSession?.sourceThreadName,
          sourceThreadType: parentSession?.sourceThreadType,
          parentSessionId: context.parentSessionId,
          parentTurnId: context.parentTurnId,
        });
      }

      const handle = child.sendTurn(
        { prompt: input.prompt },
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
        turnId: handle.turnId,
        agentName: name,
        interrupt,
      });

      const events = (): AsyncIterable<StreamAgentMessage> => ({
        [Symbol.asyncIterator]() {
          const queued = [...stream.messages()];
          const waiters: Array<(value: IteratorResult<StreamAgentMessage>) => void> = [];
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
            next(): Promise<IteratorResult<StreamAgentMessage>> {
              const value = queued.shift();
              if (value) return Promise.resolve({ value, done: false });
              if (done) return Promise.resolve({ value: undefined, done: true });
              return new Promise((resolve) => waiters.push(resolve));
            },
            return(): Promise<IteratorResult<StreamAgentMessage>> {
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
        let resultText = "";
        let structuredOutput: unknown;
        let hasStructuredOutput = false;
        let terminalError: Extract<StreamAgentMessage, { type: "error" }> | undefined;
        let cancelled = false;
        try {
          for await (const message of handle.events) {
            stream.publish(message);
            await recordAgentTraceBestEffort(recorder, message, log, {
              turnId: handle.turnId,
              source: "subagent-execution",
            });
            if (message.type === "result") {
              resultText = message.content;
              if (Object.prototype.hasOwnProperty.call(message, "structuredOutput")) {
                structuredOutput = message.structuredOutput;
                hasStructuredOutput = true;
              }
            }
            if (message.type === "error") terminalError = message;
            if (message.type === "turn_end" && message.status === "interrupted") cancelled = true;
          }
          if (cancelled) {
            resolveCompletion({
              status: "cancelled",
              sessionId: child.sessionId,
              turnId: handle.turnId,
              error: { message: terminalError?.error ?? "Subagent execution was cancelled" },
            });
          } else if (terminalError) {
            resolveCompletion({
              status: "failed",
              sessionId: child.sessionId,
              turnId: handle.turnId,
              error: {
                message: terminalError.error,
                ...(terminalError.code ? { code: terminalError.code } : {}),
              },
            });
          } else {
            resolveCompletion({
              status: "completed",
              sessionId: child.sessionId,
              turnId: handle.turnId,
              output: hasStructuredOutput ? structuredOutput : resultText,
            });
          }
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
