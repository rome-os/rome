import type { StreamAgentEvent } from "@rome-os/app-runtime";
import type { AgentSessionManager, CallerId, SessionLog, SessionSurface } from "./agent-session.js";
import type { ThreadContext } from "../core/types.js";
import type { ActiveSubagentRegistry, ParentSubagentRef } from "./active-subagent-registry.js";
import type { AgentTurnStreamRegistry } from "./agent-turn-stream-registry.js";

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
  /** The caller a fresh child opens under, which the parent's session named. */
  childCaller: CallerId;
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
  /** Where a child's conversation is kept under its parent's. */
  log?: SessionLog;
  activeRegistry: ActiveSubagentRegistry;
  turnStreams: AgentTurnStreamRegistry;
}): SubagentExecutionService {
  return {
    async startSubagent(name, input, context) {
      if (!input.prompt || typeof input.prompt !== "string") {
        throw new Error("execute_subagent requires a non-empty prompt");
      }
      // A child shows nothing and cannot be woken; its tools still deliver
      // where the parent's do.
      const surface: SessionSurface = {
        cards: false,
        ...(context.threadContext ? { replies: context.threadContext } : {}),
      };
      let child;
      let isFresh = false;
      if (input.resumeSessionId) {
        await deps.log?.resumableChild?.({
          id: input.resumeSessionId,
          agentName: name,
          parent: context.parentSessionId,
        });
        // Naming the conversation lets the resume fill a row whose record
        // failed when the subagent was minted.
        // The child's conversation is its own session, which the resume
        // fills in when its record failed at mint.
        child = await context.childManager.session(input.resumeSessionId, name, surface, {
          workingDir: context.workingDir,
        });
      } else {
        isFresh = true;
        child = await context.childManager.open(name, context.childCaller, surface, {
          workingDir: context.workingDir,
        });
      }

      if (isFresh) {
        await deps.log?.childStarted?.({
          id: child.sessionId,
          agentName: name,
          parent: context.parentSessionId,
          parentAgentName: context.parentAgentName,
          parentTurnId: context.parentTurnId,
        });
        // The child records its turns under its own session id, which names
        // the conversation made here.
      }

      const handle = child.sendTurn(
        { prompt: input.prompt, sharedContext: context.sharedContext },
        {
          initiatedBy: {
            parentTurn: {
              sessionId: context.parentAgentSessionId,
              turnId: context.parentTurnId,
              agentName: context.parentAgentName,
            },
          },
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

      void (async () => {
        let resultText = "";
        let structuredOutput: unknown;
        let hasStructuredOutput = false;
        let terminalError: Extract<StreamAgentEvent, { type: "error" }> | undefined;
        let cancelled = false;
        try {
          for await (const message of handle.events) {
            stream.publish(message);
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
