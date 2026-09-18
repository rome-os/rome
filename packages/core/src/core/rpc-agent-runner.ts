// Worker-side AgentRunner proxy. Agent model: docs/concepts/agents.md.
//
// This is the implementation used inside action workers (forked subprocess).
// It satisfies AgentRunnerInterface but never owns a ModelProvider locally;
// every turn is an RPC into main where the AgentSessionManager keeps the SDK
// CLI alive across turns.

import { getWorkerIpc, type IpcRpc } from "../actions/ipc.js";
import { getWorkerRpc } from "../actions/worker-rpc-client.js";
import { getCurrentActionContext, type StreamAgentMessage } from "@rome-os/app-runtime";
import type { AgentMessage } from "../types.js";
import type { AgentRunnerInterface, RunParams } from "./types.js";
import {
  AGENT_SESSION_RUN_TURN_TIMEOUT_MS,
  type RunTurnRequest,
  type RunTurnResponse,
} from "./agent-session-bridge.js";
import { createLogger } from "../logger.js";
import { getCurrentHookInvocationContext } from "./hook-recursion.js";
import { agentTurnStreamRouterFor } from "./agent-turn-stream-router.js";

const log = createLogger("rpc-agent-runner");

export class RpcAgentRunner implements AgentRunnerInterface {
  /** `ipc` is injectable for tests; production uses the worker singleton. */
  constructor(private readonly ipc?: IpcRpc) {}

  private getIpc(): IpcRpc {
    return this.ipc ?? getWorkerIpc();
  }

  async admitConversationInput(params: RunParams): Promise<{ turnId: string } | null> {
    if (!params.channelThreadKey || !params.platformMessageId) return null;
    const response = await this.getIpc().call<RunTurnRequest, RunTurnResponse>(
      "agent.session.runTurn",
      {
        admissionOnly: true,
        key: { agentName: params.agentName, channelThreadKey: params.channelThreadKey },
        init: {
          workingDir: params.workingDir,
          threadContext: params.threadContext,
          romeSessionId: params.romeSessionId,
          sharedContext: params.sharedContext,
          contextSuffix: params.contextSuffix,
        },
        input: { prompt: params.prompt, images: params.images },
        platformMessageId: params.platformMessageId,
        replyTo: params.replyTo,
        hookInvocationContext: getCurrentHookInvocationContext(),
        actionContext: getCurrentActionContext(),
      },
      { timeoutMs: AGENT_SESSION_RUN_TURN_TIMEOUT_MS },
    );
    return response.admitted ? { turnId: response.turnId } : null;
  }

  /**
   * Catalog membership check, bridged to main via worker RPC. The worker has no
   * local `AgentLoader`, so this answers truthfully or throws — a transport
   * failure must not be reported as "agent exists", because validation callers
   * (for example, settings-management writes) rely on a fail-closed answer.
   * Callers that prefer leniency (e.g. routing fallback) catch and decide
   * locally.
   */
  async hasAgent(name: string): Promise<boolean> {
    const res = await getWorkerRpc().call<{ hasAgent: boolean }>("agent.hasAgent", { name });
    return res.hasAgent;
  }

  /**
   * Capability check, bridged to main via worker RPC. The worker has no local
   * `AgentLoader` / `ActionRegistry`, so this asks main whether the agent's
   * allow-list resolves the action. A transport failure throws — callers that
   * prefer leniency catch and decide locally (the inbox cue treats a thrown or
   * absent answer as "cannot", which is the safe default for guidance).
   */
  async hasAction(agentName: string, actionName: string): Promise<boolean> {
    const res = await getWorkerRpc().call<{ hasAction: boolean }>("agent.hasAction", {
      agentName,
      actionName,
    });
    return res.hasAction;
  }

  async *run(params: RunParams): AsyncIterable<AgentMessage> {
    const ipc = this.getIpc();
    const router = agentTurnStreamRouterFor(ipc);
    const channelThreadKey =
      params.channelThreadKey ?? `${params.agentName}:${Date.now()}-${Math.random()}`;

    const req: RunTurnRequest = {
      key: { agentName: params.agentName, channelThreadKey },
      init: {
        workingDir: params.workingDir,
        threadContext: params.threadContext,
        romeSessionId: params.romeSessionId,
        sharedContext: params.sharedContext,
        contextSuffix: params.contextSuffix,
      },
      input: { prompt: params.prompt, images: params.images },
      platformMessageId: params.platformMessageId,
      replyTo: params.replyTo,
      sessionId: params.sessionId,
      hookInvocationContext: getCurrentHookInvocationContext(),
      actionContext: getCurrentActionContext(),
    };

    let response: RunTurnResponse;
    try {
      response = await ipc.call<RunTurnRequest, RunTurnResponse>("agent.session.runTurn", req, {
        timeoutMs: AGENT_SESSION_RUN_TURN_TIMEOUT_MS,
      });
    } catch (err) {
      log.warn("agent.session.runTurn failed", {
        agent: params.agentName,
        error: err instanceof Error ? err.message : String(err),
      });
      yield { type: "error", error: err instanceof Error ? err.message : String(err) };
      return;
    }

    log.debug("agent turn started", {
      turnId: response.turnId,
      sessionId: response.sessionId,
      agent: params.agentName,
    });

    const streamName = `agent.turn:${response.turnId}`;
    const values: StreamAgentMessage[] = [];
    const resolvers: Array<(item: IteratorResult<StreamAgentMessage>) => void> = [];
    let done = false;
    let error: Error | undefined;

    router.claim(streamName, {
      push(msg) {
        if (resolvers.length > 0) {
          resolvers.shift()!({ value: msg, done: false });
        } else {
          values.push(msg);
        }
      },
      end(err) {
        done = true;
        error = err;
        while (resolvers.length > 0) {
          resolvers.shift()!({ value: undefined as never, done: true });
        }
      },
    });

    try {
      while (true) {
        if (values.length > 0) {
          yield attachRomeSession(values.shift()!, response.romeSession);
          continue;
        }
        if (done) {
          if (error) throw error;
          return;
        }
        const next = await new Promise<IteratorResult<StreamAgentMessage>>((resolve) => {
          resolvers.push(resolve);
        });
        if (next.done) {
          if (error) throw error;
          return;
        }
        yield attachRomeSession(next.value, response.romeSession);
      }
    } finally {
      router.release(streamName);
    }
  }
}

function attachRomeSession(
  message: StreamAgentMessage,
  romeSession: RunTurnResponse["romeSession"],
): StreamAgentMessage {
  return message.type === "session_init" ? { ...message, romeSession } : message;
}
