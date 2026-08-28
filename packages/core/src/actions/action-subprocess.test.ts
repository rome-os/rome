import { EventEmitter } from "node:events";
import type { ChildProcess, ForkOptions } from "node:child_process";
import { describe, expect, it, rs } from "@rstest/core";
import type { ActionEvent, StreamAgentMessage } from "@rome-os/app-runtime";
import { ActionEngine } from "./engine.js";
import { ActionCancelledError, ActionWorkerExitError } from "./action-errors.js";
import {
  ActionWorkerCoordinator,
  DelegatedActionClient,
  registerActionSubprocessHost,
  type MainActionWorkerExecution,
  type MainActionWorkerHost,
} from "./action-subprocess.js";
import { callAction } from "./call-action.js";
import { IpcRpc, type IpcMessage, type IpcTransport } from "./ipc.js";
import { ActionRegistryImpl } from "./registry.js";
import type { ActionRuntimeEvent } from "./runtime-events.js";
import type { ActionWorkerPayload } from "./worker-protocol.js";
import { buildAction, createTestRome } from "../test/kit/index.js";
import {
  AGENT_SESSION_RUN_TURN_TIMEOUT_MS,
  type RunTurnRequest,
  type RunTurnResponse,
} from "../core/agent-session-bridge.js";
import { RpcAgentRunner } from "../core/rpc-agent-runner.js";
import {
  createRomeAppContext,
  type RomeAppContext,
  type RomeAppRuntimeServices,
} from "../apps/context.js";
import type { AppCatalog } from "../apps/catalog.js";
import type { ResolvedApp } from "../apps/state.js";

interface TransportPair {
  a: IpcTransport;
  b: IpcTransport;
  disconnect(): void;
}

/** In-memory equivalent of one ordered Node IPC pipe. */
function createTransportPair(): TransportPair {
  const aMessages = new Set<(message: IpcMessage) => void>();
  const bMessages = new Set<(message: IpcMessage) => void>();
  const aDisconnects = new Set<() => void>();
  const bDisconnects = new Set<() => void>();
  let connected = true;
  const make = (
    mine: Set<(message: IpcMessage) => void>,
    theirs: Set<(message: IpcMessage) => void>,
    disconnects: Set<() => void>,
  ): IpcTransport => ({
    get connected() {
      return connected;
    },
    send(message) {
      if (!connected) return;
      queueMicrotask(() => {
        if (!connected) return;
        for (const listener of theirs) listener(message);
      });
    },
    onMessage(listener) {
      mine.add(listener);
      return () => mine.delete(listener);
    },
    onDisconnect(listener) {
      disconnects.add(listener);
      return () => disconnects.delete(listener);
    },
  });
  return {
    a: make(aMessages, bMessages, aDisconnects),
    b: make(bMessages, aMessages, bDisconnects),
    disconnect() {
      if (!connected) return;
      connected = false;
      for (const listener of aDisconnects) listener();
      for (const listener of bDisconnects) listener();
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function payload(
  executionId: string,
  rootExecutionId = "root-a",
  parentExecutionId = "action-a",
): ActionWorkerPayload {
  return {
    actionName: executionId,
    args: { input: executionId },
    context: {
      executionId,
      rootExecutionId,
      parentExecutionId,
      parentActionName: "action_a",
      actionName: executionId,
      initiator: "test",
    },
    forkStartedAt: Date.now(),
  };
}

async function collect(run: AsyncIterable<unknown>): Promise<StreamAgentMessage[]> {
  const messages: StreamAgentMessage[] = [];
  for await (const message of run) messages.push(message as StreamAgentMessage);
  return messages;
}

async function collectValues<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const value of values) collected.push(value);
  return collected;
}

function contents(messages: StreamAgentMessage[]): Array<string | undefined> {
  return messages.map((message) => (message as { content?: string }).content);
}

function appContextFor(engine: ActionEngine): RomeAppContext {
  const app = {
    appId: "dispatch-test",
    manifest: {
      id: "dispatch-test",
      version: "1.0.0",
      description: "Detached runAction test",
    },
    db: null,
  } as ResolvedApp;
  return createRomeAppContext(app, {
    catalog: { get: () => app } as unknown as AppCatalog,
    db: {} as RomeAppRuntimeServices["db"],
    actionEngine: engine,
    repositories: {} as RomeAppRuntimeServices["repositories"],
  });
}

describe("main-owned action subprocess", () => {
  it("uses main's process factory and attaches every main-owned service to delegated W2", async () => {
    class FakeChild extends EventEmitter {
      pid = 987_654;
      connected = true;
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      sent: unknown[] = [];

      send(message: unknown, callback?: (error: Error | null) => void): boolean {
        this.sent.push(message);
        callback?.(null);
        if ((message as { actionName?: string }).actionName) {
          queueMicrotask(() => {
            this.emit("message", {
              type: "runtime_event",
              event: {
                type: "agent_message",
                message: { type: "text", content: "from-w2" },
              },
            });
            this.emit("message", { type: "result", result: { status: "ok", data: "w2-result" } });
          });
        }
        if ((message as { type?: string }).type === "shutdown") {
          this.connected = false;
          this.exitCode = 0;
          queueMicrotask(() => this.emit("exit", 0, null));
        }
        return true;
      }
    }

    const child = new FakeChild();
    const processFactory = rs.fn(
      (_entryPath: string, _options: ForkOptions) => child as unknown as ChildProcess,
    );
    const workerRpcAttach = rs.fn();
    const sessionDispose = rs.fn();
    const sessionAttach = rs.fn(() => ({ dispose: sessionDispose }));
    const engine = new ActionEngine(
      new ActionRegistryImpl([]),
      undefined,
      undefined,
      undefined,
      undefined,
      {
        processRole: "main",
        workerWarmPoolSize: 0,
        actionWorkerFork: processFactory,
      },
    );
    engine.setWorkerRpcServer({ attach: workerRpcAttach } as never);
    engine.setAgentSessionBridge({ attach: sessionAttach } as never);
    const events: ActionRuntimeEvent[] = [];

    const execution = engine.startDelegatedAction(payload("delegated-w2"), {
      onRuntimeEvent: (event) => events.push(event),
    });

    await expect(execution.result).resolves.toEqual({ status: "ok", data: "w2-result" });
    expect(processFactory).toHaveBeenCalledTimes(1);
    expect(processFactory.mock.calls[0][1]).toMatchObject({ detached: false });
    expect(workerRpcAttach).toHaveBeenCalledWith(child);
    expect(sessionAttach).toHaveBeenCalledWith(child);
    expect(events).toEqual([
      { type: "agent_message", message: { type: "text", content: "from-w2" } },
    ]);
    expect(child.sent[0]).toMatchObject({ actionName: "delegated-w2" });
  });

  it("runs action A -> cancellable B -> agent turn directly against main and returns B's result", async () => {
    const w1Link = createTransportPair();
    const mainForW1 = new IpcRpc(w1Link.a, "main-w1");
    const w1 = new IpcRpc(w1Link.b, "w1");

    const w2Link = createTransportPair();
    const mainForW2 = new IpcRpc(w2Link.a, "main-w2");
    const w2 = new IpcRpc(w2Link.b, "w2");
    const agentRequests: RunTurnRequest[] = [];
    mainForW2.handle<RunTurnRequest, RunTurnResponse>(
      "agent.session.runTurn",
      async (request, context) => {
        agentRequests.push(request);
        const stream = context.openStream<StreamAgentMessage>("agent.turn:turn-b");
        stream.send({ type: "text", content: "agent-chunk" } as StreamAgentMessage);
        stream.send({ type: "result", content: "agent-result" } as StreamAgentMessage);
        stream.close();
        return {
          turnId: "turn-b",
          sessionId: "session-b",
          romeSession: { _romeSessionId: "action:test:b", _type: "action" },
        };
      },
    );

    const starts: ActionWorkerPayload[] = [];
    const host: MainActionWorkerHost = {
      startDelegatedAction(actionPayload): MainActionWorkerExecution {
        starts.push(actionPayload);
        return {
          result: (async () => {
            const messages = await collect(
              new RpcAgentRunner(w2).run({
                agentName: "reviewer",
                prompt: "review-pr",
                channelThreadKey: "action:review-b",
              }),
            );
            return { status: "ok", data: contents(messages) };
          })(),
          cancel() {},
        };
      },
    };
    const coordinator = new ActionWorkerCoordinator(host);
    registerActionSubprocessHost(mainForW1, coordinator, { worker: "w1" });

    const registry = new ActionRegistryImpl([]);
    const localB = rs.fn(async () => ({ status: "ok" as const, data: "wrong-process" }));
    registry.register(buildAction("action_b", { cancellable: true, execute: localB }));
    registry.register(
      buildAction("action_a", {
        execute: async () => await callAction("action_b", { pullRequest: 42 }),
      }),
    );
    const engine = new ActionEngine(registry, undefined, undefined, undefined, undefined, {
      processRole: "worker",
      actionSubprocessRunner: new DelegatedActionClient(w1),
    });

    await expect(engine.run("action_a", {})).resolves.toEqual({
      status: "ok",
      data: ["agent-chunk", "agent-result"],
    });
    expect(localB).not.toHaveBeenCalled();
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      actionName: "action_b",
      args: { pullRequest: 42 },
      context: {
        parentActionName: "action_a",
        actionName: "action_b",
      },
    });
    expect(starts[0].context.rootExecutionId).toBe(starts[0].context.parentExecutionId);
    expect(agentRequests).toHaveLength(1);
    expect(agentRequests[0].input.prompt).toBe("review-pr");
    expect(coordinator.activeCount()).toBe(0);
  });

  it("preserves invokeAction events and result across W1 -> main -> W2", async () => {
    const link = createTransportPair();
    const mainForW1 = new IpcRpc(link.a, "main-w1");
    const w1 = new IpcRpc(link.b, "w1");
    const delegatedPayloads: ActionWorkerPayload[] = [];

    const w2Registry = new ActionRegistryImpl([]);
    const actionBInW2 = buildAction("action_b", { cancellable: true });
    actionBInW2.execute = async (args, execution) => {
      execution?.emitActionEvent({ type: "progress", sequence: 1 });
      await Promise.resolve();
      execution?.emitActionEvent({ type: "progress", sequence: 2 });
      return { status: "ok", data: { echoed: args.input } };
    };
    w2Registry.register(actionBInW2);
    const w2Engine = new ActionEngine(w2Registry, undefined, undefined, undefined, undefined, {
      processRole: "worker",
    });
    const coordinator = new ActionWorkerCoordinator({
      startDelegatedAction(actionPayload, observer) {
        delegatedPayloads.push(actionPayload);
        return {
          result: w2Engine.run(
            actionPayload.actionName,
            actionPayload.args,
            actionPayload.context,
            observer,
          ),
          cancel() {},
        };
      },
    });
    registerActionSubprocessHost(mainForW1, coordinator, { worker: "w1" });

    let appContext!: RomeAppContext;
    const localB = rs.fn(async () => ({ status: "ok" as const, data: "wrong-process" }));
    const w1Registry = new ActionRegistryImpl([]);
    w1Registry.register(buildAction("action_b", { cancellable: true, execute: localB }));
    w1Registry.register(
      buildAction("action_a", {
        execute: async () => {
          const invocation = appContext.invokeAction<{
            type: "progress";
            sequence: number;
          }>("action_b", { input: "from-a" });
          const deliveryOrder: string[] = [];
          const events = (async () => {
            const values: number[] = [];
            for await (const event of invocation.events) {
              values.push(event.sequence);
              deliveryOrder.push(`event:${event.sequence}`);
            }
            return values;
          })();
          const result = await invocation.result;
          deliveryOrder.push("result");
          return {
            status: "ok",
            data: { childEvents: await events, childResult: result, deliveryOrder },
          };
        },
      }),
    );
    const w1Engine = new ActionEngine(w1Registry, undefined, undefined, undefined, undefined, {
      processRole: "worker",
      actionSubprocessRunner: new DelegatedActionClient(w1),
    });
    const app = {
      appId: "invoke-action-test",
      manifest: {
        id: "invoke-action-test",
        version: "1.0.0",
        description: "invokeAction delegation test",
      },
      db: null,
    } as ResolvedApp;
    appContext = createRomeAppContext(app, {
      catalog: { get: () => app } as unknown as AppCatalog,
      db: {} as RomeAppRuntimeServices["db"],
      actionEngine: w1Engine,
      repositories: {} as RomeAppRuntimeServices["repositories"],
    });

    const outerInvocation = appContext.invokeAction("action_a", {});

    await expect(outerInvocation.result).resolves.toEqual({
      status: "ok",
      data: {
        childEvents: [1, 2],
        childResult: { status: "ok", data: { echoed: "from-a" } },
        deliveryOrder: ["event:1", "event:2", "result"],
      },
    });
    await expect(collectValues(outerInvocation.events)).resolves.toEqual([]);
    expect(localB).not.toHaveBeenCalled();
    expect(delegatedPayloads).toHaveLength(1);
    expect(delegatedPayloads[0]).toMatchObject({
      actionName: "action_b",
      args: { input: "from-a" },
      context: { parentActionName: "action_a" },
    });
    expect(coordinator.activeCount()).toBe(0);
  });

  it("characterizes the former W1 -> W2 agent call as a 600-second timeout failure", async () => {
    rs.useFakeTimers();
    try {
      const delegationLink = createTransportPair();
      const mainForW1 = new IpcRpc(delegationLink.a, "main-w1");
      const w1 = new IpcRpc(delegationLink.b, "w1");

      // This second link recreates the pre-fix topology: W2 can only address
      // W1, and W1 has no IpcRpc listener, runTurn handler, or relay.
      const oldNestedLink = createTransportPair();
      const oldW2 = new IpcRpc(oldNestedLink.b, "w2");
      const host: MainActionWorkerHost = {
        startDelegatedAction() {
          return {
            result: (async () => {
              const messages = await collect(
                new RpcAgentRunner(oldW2).run({
                  agentName: "reviewer",
                  prompt: "review-pr",
                  channelThreadKey: "action:old-review-b",
                }),
              );
              const failure = messages[0] as { type: "error"; error: string };
              return { status: "error", error: failure.error };
            })(),
            cancel() {},
          };
        },
      };
      registerActionSubprocessHost(mainForW1, new ActionWorkerCoordinator(host), { worker: "w1" });

      const registry = new ActionRegistryImpl([]);
      registry.register(buildAction("action_b", { cancellable: true }));
      registry.register(
        buildAction("action_a", { execute: async () => await callAction("action_b", {}) }),
      );
      const engine = new ActionEngine(registry, undefined, undefined, undefined, undefined, {
        processRole: "worker",
        actionSubprocessRunner: new DelegatedActionClient(w1),
      });

      const run = engine.run("action_a", {});
      await rs.advanceTimersByTimeAsync(AGENT_SESSION_RUN_TURN_TIMEOUT_MS);

      await expect(run).resolves.toEqual({
        status: "error",
        error: `IpcRpc timeout: agent.session.runTurn (${AGENT_SESSION_RUN_TURN_TIMEOUT_MS}ms)`,
      });
    } finally {
      rs.useRealTimers();
    }
  });

  it("returns ordered runtime events exactly once before the delegated result", async () => {
    const link = createTransportPair();
    const main = new IpcRpc(link.a, "main");
    const worker = new IpcRpc(link.b, "worker");
    const actionPayload = payload("action-b-exec");
    const first: ActionRuntimeEvent = {
      type: "agent_message",
      message: { type: "text", content: "first" },
    };
    const second: ActionRuntimeEvent = {
      type: "action_event",
      sourceExecutionId: "action-b-exec",
      event: { type: "progress", current: 2, total: 2 } as ActionEvent,
    };
    const host: MainActionWorkerHost = {
      startDelegatedAction(_payload, observer) {
        return {
          result: Promise.resolve().then(() => {
            observer?.onRuntimeEvent?.(first);
            observer?.onRuntimeEvent?.(second);
            return { status: "ok", data: "done" };
          }),
          cancel() {},
        };
      },
    };
    registerActionSubprocessHost(main, new ActionWorkerCoordinator(host), { worker: "w1" });
    const runtimeEvents: ActionRuntimeEvent[] = [];
    const actionEvents: unknown[] = [];

    const result = await new DelegatedActionClient(worker).run(
      actionPayload,
      { onRuntimeEvent: (event) => runtimeEvents.push(event) },
      { onActionEvent: (event) => actionEvents.push(event) },
    );

    expect(result).toEqual({ status: "ok", data: "done" });
    expect(runtimeEvents).toEqual([first, second]);
    expect(actionEvents).toEqual([{ type: "progress", current: 2, total: 2 }]);
  });

  it("cancels W2 when W1's root execution is cancelled", async () => {
    const link = createTransportPair();
    const main = new IpcRpc(link.a, "main");
    const w1 = new IpcRpc(link.b, "w1");
    const running = deferred<never>();
    const cancellations: string[] = [];
    const host: MainActionWorkerHost = {
      startDelegatedAction() {
        return {
          result: running.promise,
          cancel(reason) {
            cancellations.push(reason ?? "");
            running.reject(new ActionCancelledError(reason));
          },
        };
      },
    };
    const coordinator = new ActionWorkerCoordinator(host);
    registerActionSubprocessHost(main, coordinator, { worker: "w1" });

    const registry = new ActionRegistryImpl([]);
    registry.register(buildAction("action_b", { cancellable: true }));
    registry.register(
      buildAction("action_a", { execute: async () => await callAction("action_b", {}) }),
    );
    const engine = new ActionEngine(registry, undefined, undefined, undefined, undefined, {
      processRole: "worker",
      actionSubprocessRunner: new DelegatedActionClient(w1),
    });
    const run = engine.run("action_a", {}, { executionId: "root-cancel" });
    await rs.waitFor(() => expect(coordinator.activeCount()).toBe(1));

    expect(coordinator.cancelRoot("root-cancel", "cancel A")).toBe(1);

    await expect(run).rejects.toMatchObject({ name: "ActionCancelledError", message: "cancel A" });
    expect(cancellations).toEqual(["cancel A"]);
    expect(coordinator.activeCount()).toBe(0);
  });

  it("ActionEngine.cancel terminates root W1 and fans cancellation out to delegated W2", async () => {
    class PendingChild extends EventEmitter {
      connected = true;
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      sent: unknown[] = [];

      constructor(public pid: number | undefined) {
        super();
      }

      send(message: unknown, callback?: (error: Error | null) => void): boolean {
        this.sent.push(message);
        callback?.(null);
        return true;
      }
    }

    const rootChild = new PendingChild(456_789);
    const delegatedChild = new PendingChild(567_890);
    const children = [rootChild, delegatedChild];
    const registry = new ActionRegistryImpl([]);
    registry.register(buildAction("action_a"));
    const engine = new ActionEngine(registry, undefined, undefined, undefined, undefined, {
      processRole: "main",
      workerWarmPoolSize: 0,
      actionWorkerFork: () => children.shift() as unknown as ChildProcess,
    });
    const coordinator = new ActionWorkerCoordinator(engine);
    engine.setActionWorkerCoordinator(coordinator);
    const kill = rs.spyOn(process, "kill").mockImplementation((pid, signal) => {
      const child = pid === -456_789 ? rootChild : pid === -567_890 ? delegatedChild : undefined;
      if (child && signal === "SIGTERM") {
        child.signalCode = "SIGTERM";
        child.pid = undefined;
        queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
      }
      return true;
    });

    try {
      const rootRun = engine.run("action_a", {}, { executionId: "root-main-cancel" });
      await rs.waitFor(() => expect(rootChild.sent).toHaveLength(1));
      const delegatedRun = coordinator.run(
        { worker: "w1" },
        payload("action-b-main-cancel", "root-main-cancel"),
        () => undefined,
      );
      await rs.waitFor(() => expect(coordinator.activeCount()).toBe(1));

      await expect(engine.cancel("root-main-cancel")).resolves.toBe(true);

      await expect(rootRun).rejects.toMatchObject({ name: "ActionCancelledError" });
      await expect(delegatedRun).resolves.toEqual({
        type: "cancelled",
        message: "Cancelled by user",
      });
      expect(kill).toHaveBeenCalledWith(-456_789, "SIGTERM");
      expect(kill).toHaveBeenCalledWith(-567_890, "SIGTERM");
      expect(coordinator.activeCount()).toBe(0);
    } finally {
      kill.mockRestore();
    }
  });

  it("uses the detached receipt id to cancel W2 as an independent root", async () => {
    class PendingChild extends EventEmitter {
      connected = true;
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      sent: unknown[] = [];

      constructor(public pid: number | undefined) {
        super();
      }

      send(message: unknown, callback?: (error: Error | null) => void): boolean {
        this.sent.push(message);
        callback?.(null);
        return true;
      }
    }

    const detachedChild = new PendingChild(678_901);
    const registry = new ActionRegistryImpl([]);
    registry.register(buildAction("action_b"));
    const engine = new ActionEngine(registry, undefined, undefined, undefined, undefined, {
      processRole: "main",
      workerWarmPoolSize: 0,
      actionWorkerFork: () => detachedChild as unknown as ChildProcess,
    });
    const kill = rs.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === -678_901 && signal === "SIGTERM") {
        detachedChild.signalCode = "SIGTERM";
        detachedChild.pid = undefined;
        queueMicrotask(() => detachedChild.emit("exit", null, "SIGTERM"));
      }
      return true;
    });

    try {
      const receipt = await engine.dispatch(
        "action_b",
        { pullRequest: 42 },
        {
          executionId: "caller-execution",
          rootExecutionId: "caller-root",
          parentExecutionId: "caller-execution",
        },
      );
      expect(detachedChild.sent).toHaveLength(1);
      expect(receipt.executionId).not.toBe("caller-execution");
      expect(detachedChild.sent[0]).toMatchObject({
        actionName: "action_b",
        args: { pullRequest: 42 },
        context: {
          executionId: receipt.executionId,
          rootExecutionId: receipt.executionId,
        },
      });
      expect(
        (detachedChild.sent[0] as ActionWorkerPayload).context.parentExecutionId,
      ).toBeUndefined();

      await expect(engine.cancel(receipt.executionId)).resolves.toBe(true);
      expect(kill).toHaveBeenCalledWith(-678_901, "SIGTERM");
      await rs.waitFor(() => expect(engine.cancel(receipt.executionId)).resolves.toBe(false));
    } finally {
      kill.mockRestore();
    }
  });

  it("cancels every delegated W2 when owner W1 disconnects", async () => {
    const link = createTransportPair();
    const main = new IpcRpc(link.a, "main");
    const w1 = new IpcRpc(link.b, "w1");
    const cancel = rs.fn();
    const host: MainActionWorkerHost = {
      startDelegatedAction() {
        const current = deferred<never>();
        return {
          result: current.promise,
          cancel(reason) {
            cancel(reason);
            current.reject(new ActionCancelledError(reason));
          },
        };
      },
    };
    const coordinator = new ActionWorkerCoordinator(host);
    registerActionSubprocessHost(main, coordinator, { worker: "w1" });
    const client = new DelegatedActionClient(w1);
    const runB = client.run(payload("b", "root-disconnect"));
    await rs.waitFor(() => expect(coordinator.activeCount()).toBe(1));
    // Start a second execution after the first has been indexed.
    const runC = client.run(payload("c", "root-disconnect"));
    await rs.waitFor(() => expect(coordinator.activeCount()).toBe(2));

    link.disconnect();

    await expect(runB).rejects.toMatchObject({ name: "IpcRpcDisconnectError" });
    await expect(runC).rejects.toMatchObject({ name: "IpcRpcDisconnectError" });
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledWith("Owner worker disconnected");
    await rs.waitFor(() => expect(coordinator.activeCount()).toBe(0));
  });

  it("keeps a detached runAction alive when W1 is cancelled", async () => {
    const link = createTransportPair();
    const main = new IpcRpc(link.a, "main");
    const w1 = new IpcRpc(link.b, "w1");
    const detachedPayloads: ActionWorkerPayload[] = [];
    const w2 = deferred<{ status: "ok"; data: string }>();
    let w2Completed = false;
    const startDelegatedAction = rs.fn<MainActionWorkerHost["startDelegatedAction"]>();
    const coordinator = new ActionWorkerCoordinator({
      startDelegatedAction,
      async startDetachedAction(actionPayload) {
        detachedPayloads.push(actionPayload);
        void w2.promise.then(() => {
          w2Completed = true;
        });
        return { executionId: actionPayload.context.executionId! };
      },
    });
    registerActionSubprocessHost(main, coordinator, { worker: "w1" });

    const registry = new ActionRegistryImpl([]);
    registry.register(buildAction("action_b", { cancellable: true }));
    let appContext!: RomeAppContext;
    registry.register(
      buildAction("action_a", {
        execute: async () => {
          const receipt = await appContext.runAction(
            "action_b",
            { pullRequest: 42 },
            { detached: true },
          );
          return { status: "ok", data: receipt };
        },
      }),
    );
    const engine = new ActionEngine(registry, undefined, undefined, undefined, undefined, {
      processRole: "worker",
      actionSubprocessRunner: new DelegatedActionClient(w1),
    });
    appContext = appContextFor(engine);

    const parent = await engine.run("action_a", {}, { executionId: "root-a" });

    expect(parent).toMatchObject({
      status: "ok",
      data: { executionId: expect.any(String) },
    });
    expect(detachedPayloads).toHaveLength(1);
    expect(detachedPayloads[0]).toMatchObject({
      actionName: "action_b",
      args: { pullRequest: 42 },
      context: {
        actionName: "action_b",
        executionId: expect.any(String),
        rootExecutionId: expect.any(String),
      },
    });
    expect(detachedPayloads[0].context.executionId).toBe(
      detachedPayloads[0].context.rootExecutionId,
    );
    expect(detachedPayloads[0].context.executionId).not.toBe("root-a");
    expect(detachedPayloads[0].context.parentExecutionId).toBeUndefined();
    expect(startDelegatedAction).not.toHaveBeenCalled();
    expect(coordinator.activeCount()).toBe(0);
    expect(coordinator.cancelRoot("root-a", "cancel W1")).toBe(0);

    link.disconnect();
    expect(w2Completed).toBe(false);
    w2.resolve({ status: "ok", data: "review complete" });
    await rs.waitFor(() => expect(w2Completed).toBe(true));
  });

  it("cancels an awaited nested runAction when W1 is cancelled", async () => {
    const link = createTransportPair();
    const main = new IpcRpc(link.a, "main");
    const w1 = new IpcRpc(link.b, "w1");
    const cancellations: string[] = [];
    const delegatedPayloads: ActionWorkerPayload[] = [];
    const coordinator = new ActionWorkerCoordinator({
      startDelegatedAction(actionPayload) {
        delegatedPayloads.push(actionPayload);
        const w2 = deferred<never>();
        return {
          result: w2.promise,
          cancel(reason) {
            cancellations.push(reason ?? "");
            w2.reject(new ActionCancelledError(reason));
          },
        };
      },
    });
    registerActionSubprocessHost(main, coordinator, { worker: "w1" });

    const registry = new ActionRegistryImpl([]);
    registry.register(buildAction("action_b", { cancellable: true }));
    let appContext!: RomeAppContext;
    registry.register(
      buildAction("action_a", {
        execute: async () =>
          await appContext.runAction("action_b", { pullRequest: 42 }, { detached: false }),
      }),
    );
    const engine = new ActionEngine(registry, undefined, undefined, undefined, undefined, {
      processRole: "worker",
      actionSubprocessRunner: new DelegatedActionClient(w1),
    });
    appContext = appContextFor(engine);

    const parent = engine.run("action_a", {}, { executionId: "root-a" });
    await rs.waitFor(() => expect(coordinator.activeCount()).toBe(1));

    expect(coordinator.cancelRoot("root-a", "cancel W1")).toBe(1);

    await expect(parent).rejects.toMatchObject({
      name: "ActionCancelledError",
      message: "cancel W1",
    });
    expect(cancellations).toEqual(["cancel W1"]);
    expect(delegatedPayloads).toHaveLength(1);
    expect(delegatedPayloads[0].context.rootExecutionId).toBe("root-a");
    expect(delegatedPayloads[0].context.parentExecutionId).toBe("root-a");
    await rs.waitFor(() => expect(coordinator.activeCount()).toBe(0));
  });

  it("keeps concurrent delegated results and event streams isolated by execution id", async () => {
    const link = createTransportPair();
    const main = new IpcRpc(link.a, "main");
    const worker = new IpcRpc(link.b, "worker");
    const executions = new Map<
      string,
      ReturnType<typeof deferred<{ status: "ok"; data: string }>>
    >();
    const observers = new Map<string, (event: ActionRuntimeEvent) => void>();
    const host: MainActionWorkerHost = {
      startDelegatedAction(actionPayload, observer) {
        const id = actionPayload.context.executionId!;
        const result = deferred<{ status: "ok"; data: string }>();
        executions.set(id, result);
        observers.set(id, (event) => observer?.onRuntimeEvent?.(event));
        return { result: result.promise, cancel() {} };
      },
    };
    registerActionSubprocessHost(main, new ActionWorkerCoordinator(host), { worker: "w1" });
    const client = new DelegatedActionClient(worker);
    const bEvents: string[] = [];
    const cEvents: string[] = [];
    const runB = client.run(payload("b"), {
      onRuntimeEvent: (event) =>
        bEvents.push((event as { message: { content: string } }).message.content),
    });
    const runC = client.run(payload("c"), {
      onRuntimeEvent: (event) =>
        cEvents.push((event as { message: { content: string } }).message.content),
    });
    await rs.waitFor(() => expect(executions.size).toBe(2));

    observers.get("c")?.({ type: "agent_message", message: { type: "text", content: "c-event" } });
    executions.get("c")?.resolve({ status: "ok", data: "c-result" });
    observers.get("b")?.({ type: "agent_message", message: { type: "text", content: "b-event" } });
    executions.get("b")?.resolve({ status: "ok", data: "b-result" });

    await expect(runB).resolves.toEqual({ status: "ok", data: "b-result" });
    await expect(runC).resolves.toEqual({ status: "ok", data: "c-result" });
    expect(bEvents).toEqual(["b-event"]);
    expect(cEvents).toEqual(["c-event"]);
  });

  it("supports recursive A -> cancellable B -> cancellable C without worker-to-worker forks", async () => {
    const w1Link = createTransportPair();
    const mainForW1 = new IpcRpc(w1Link.a, "main-w1");
    const w1 = new IpcRpc(w1Link.b, "w1");
    const w2Link = createTransportPair();
    const mainForW2 = new IpcRpc(w2Link.a, "main-w2");
    const w2 = new IpcRpc(w2Link.b, "w2");
    const starts: ActionWorkerPayload[] = [];

    const w2Registry = new ActionRegistryImpl([]);
    w2Registry.register(buildAction("action_c", { cancellable: true }));
    w2Registry.register(
      buildAction("action_b", { execute: async () => await callAction("action_c", {}) }),
    );
    const w2Engine = new ActionEngine(w2Registry, undefined, undefined, undefined, undefined, {
      processRole: "worker",
      actionSubprocessRunner: new DelegatedActionClient(w2),
    });
    const host: MainActionWorkerHost = {
      startDelegatedAction(actionPayload) {
        starts.push(actionPayload);
        if (actionPayload.actionName === "action_b") {
          return {
            result: w2Engine.run("action_b", actionPayload.args, actionPayload.context),
            cancel() {},
          };
        }
        return {
          result: Promise.resolve({ status: "ok", data: "c-result" }),
          cancel() {},
        };
      },
    };
    const coordinator = new ActionWorkerCoordinator(host);
    registerActionSubprocessHost(mainForW1, coordinator, { worker: "w1" });
    registerActionSubprocessHost(mainForW2, coordinator, { worker: "w2" });

    const w1Registry = new ActionRegistryImpl([]);
    w1Registry.register(buildAction("action_b", { cancellable: true }));
    w1Registry.register(
      buildAction("action_a", { execute: async () => await callAction("action_b", {}) }),
    );
    const w1Engine = new ActionEngine(w1Registry, undefined, undefined, undefined, undefined, {
      processRole: "worker",
      actionSubprocessRunner: new DelegatedActionClient(w1),
    });

    await expect(w1Engine.run("action_a", {}, { executionId: "root-a" })).resolves.toEqual({
      status: "ok",
      data: "c-result",
    });
    expect(starts.map((entry) => entry.actionName)).toEqual(["action_b", "action_c"]);
    expect(starts[0].context.rootExecutionId).toBe("root-a");
    expect(starts[0].context.parentExecutionId).toBe("root-a");
    expect(starts[1].context.rootExecutionId).toBe("root-a");
    expect(starts[1].context.parentExecutionId).toBe(starts[0].context.executionId);
  });

  it("persists A -> B -> C with one root id and the logical parent ids", async () => {
    const w1Link = createTransportPair();
    const mainForW1 = new IpcRpc(w1Link.a, "main-w1");
    const w1 = new IpcRpc(w1Link.b, "w1");
    const w2Link = createTransportPair();
    const mainForW2 = new IpcRpc(w2Link.a, "main-w2");
    const w2 = new IpcRpc(w2Link.b, "w2");
    let w2Engine: ActionEngine;
    const host: MainActionWorkerHost = {
      startDelegatedAction(actionPayload) {
        if (actionPayload.actionName === "action_b") {
          return {
            result: w2Engine.run("action_b", actionPayload.args, actionPayload.context),
            cancel() {},
          };
        }
        return {
          result: Promise.resolve({ status: "ok", data: "c-result" }),
          cancel() {},
        };
      },
    };
    const coordinator = new ActionWorkerCoordinator(host);
    registerActionSubprocessHost(mainForW1, coordinator, { worker: "w1" });
    registerActionSubprocessHost(mainForW2, coordinator, { worker: "w2" });

    const actionC = buildAction("action_c", { cancellable: true });
    const actionB = buildAction("action_b", {
      cancellable: true,
      execute: async () => await callAction("action_c", {}),
    });
    const actionA = buildAction("action_a", {
      execute: async () => await callAction("action_b", {}),
    });
    const rome = await createTestRome({
      actions: [actionA, actionB, actionC],
      engine: { actionSubprocessRunner: new DelegatedActionClient(w1) },
    });
    const w2Registry = new ActionRegistryImpl([]);
    w2Registry.register(actionB);
    w2Registry.register(actionC);
    w2Engine = new ActionEngine(
      w2Registry,
      undefined,
      rome.repos.actionExecutions,
      rome.repos.approvals,
      rome.repos.executionJournal,
      {
        processRole: "worker",
        actionSubprocessRunner: new DelegatedActionClient(w2),
      },
    );

    try {
      await expect(
        rome.actionEngine.run("action_a", {}, { executionId: "root-persist" }),
      ).resolves.toEqual({ status: "ok", data: "c-result" });

      const [a] = await rome.repos.actionExecutions.findByAction("action_a");
      const [b] = await rome.repos.actionExecutions.findByAction("action_b");
      const [c] = await rome.repos.actionExecutions.findByAction("action_c");
      expect(a).toMatchObject({ id: "root-persist", rootExecutionId: "root-persist" });
      expect(b).toMatchObject({ rootExecutionId: "root-persist", parentId: "root-persist" });
      expect(c).toMatchObject({
        rootExecutionId: "root-persist",
        parentId: b.id,
      });
      const journal = await rome.repos.executionJournal.loadJournal("root-persist");
      expect(journal).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ actionName: "action_b", status: "completed" }),
          expect.objectContaining({ actionName: "action_c", status: "completed" }),
        ]),
      );
    } finally {
      await rome.cleanup();
    }
  });

  it("does not persist a cancelled delegated B as a completed replay entry", async () => {
    const actionB = buildAction("action_b", { cancellable: true });
    const actionA = buildAction("action_a", {
      execute: async () => await callAction("action_b", {}),
    });
    const runner = {
      run: rs.fn(async () => {
        throw new ActionCancelledError("cancel B");
      }),
    };
    const rome = await createTestRome({
      actions: [actionA, actionB],
      engine: { actionSubprocessRunner: runner },
    });

    try {
      await expect(
        rome.actionEngine.run("action_a", {}, { executionId: "root-cancel-persist" }),
      ).rejects.toMatchObject({ name: "ActionCancelledError", message: "cancel B" });

      const journal = await rome.repos.executionJournal.loadJournal("root-cancel-persist");
      expect(journal).toEqual([]);
      const [a] = await rome.repos.actionExecutions.findByAction("action_a");
      const [b] = await rome.repos.actionExecutions.findByAction("action_b");
      expect(a.status).toBe("cancelled");
      expect(b.status).toBe("cancelled");
    } finally {
      await rome.cleanup();
    }
  });

  it("keeps non-cancellable B inside W1 and sends no delegated request", async () => {
    const runner = { run: rs.fn() };
    const registry = new ActionRegistryImpl([]);
    registry.register(
      buildAction("action_b", { execute: async () => ({ status: "ok", data: "local" }) }),
    );
    registry.register(
      buildAction("action_a", { execute: async () => await callAction("action_b", {}) }),
    );
    const engine = new ActionEngine(registry, undefined, undefined, undefined, undefined, {
      processRole: "worker",
      actionSubprocessRunner: runner,
    });

    await expect(engine.run("action_a", {})).resolves.toEqual({ status: "ok", data: "local" });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it.each([
    [new TypeError("handler failed"), "TypeError", "handler failed"],
    [new ActionWorkerExitError("worker crashed"), "ActionWorkerExitError", "worker crashed"],
  ])("preserves delegated error identity for %s", async (failure, name, message) => {
    const link = createTransportPair();
    const main = new IpcRpc(link.a, "main");
    const worker = new IpcRpc(link.b, "worker");
    const host: MainActionWorkerHost = {
      startDelegatedAction() {
        return { result: Promise.reject(failure), cancel() {} };
      },
    };
    registerActionSubprocessHost(main, new ActionWorkerCoordinator(host), { worker: "w1" });

    await expect(new DelegatedActionClient(worker).run(payload("failed"))).rejects.toMatchObject({
      name,
      message,
    });
  });

  it("allows a delegated request to outlive the ordinary 30-second RPC deadline", async () => {
    rs.useFakeTimers();
    try {
      const link = createTransportPair();
      const main = new IpcRpc(link.a, "main");
      const worker = new IpcRpc(link.b, "worker");
      const result = deferred<{ status: "ok"; data: string }>();
      const host: MainActionWorkerHost = {
        startDelegatedAction() {
          return { result: result.promise, cancel() {} };
        },
      };
      registerActionSubprocessHost(main, new ActionWorkerCoordinator(host), { worker: "w1" });
      const run = new DelegatedActionClient(worker).run(payload("long-running"));
      await rs.advanceTimersByTimeAsync(31_000);
      result.resolve({ status: "ok", data: "late-result" });

      await expect(run).resolves.toEqual({ status: "ok", data: "late-result" });
    } finally {
      rs.useRealTimers();
    }
  });
});
