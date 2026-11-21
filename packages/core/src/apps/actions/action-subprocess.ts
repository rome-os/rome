import type { ActionDispatchReceipt, ActionEvent } from "@rome-os/app-runtime";
import type {
  ActionRunObserver,
  ActionInvocationObserver,
  ActionRuntimeEvent,
} from "./runtime-events.js";
import {
  fromWireError,
  toWireError,
  type ActionWorkerPayload,
  type WireError,
} from "./worker-protocol.js";
import type { ActionResult } from "./types.js";
import { ActionCancelledError, ActionWorkerExitError } from "./action-errors.js";
import { getWorkerIpc, type IpcCallContext, type IpcInboundStream, type IpcRpc } from "./ipc.js";
import { actionExecutionContext } from "./context.js";
import { replayContext } from "./replay.js";

export const ACTION_SUBPROCESS_RUN_METHOD = "action.subprocess.run";
export const ACTION_ROOT_DISPATCH_METHOD = "action.root.dispatch";
const ACTION_SUBPROCESS_EVENT_PREFIX = "action.subprocess.events:";

export interface DelegatedActionRunRequest {
  payload: ActionWorkerPayload;
}

export interface DetachedActionDispatchRequest {
  payload: ActionWorkerPayload;
}

export type DelegatedActionRunOutcome =
  | { type: "result"; result: ActionResult }
  | { type: "error"; error: WireError }
  | { type: "cancelled"; message: string }
  | { type: "worker_exit"; message: string };

export interface ActionSubprocessRunner {
  run(
    payload: ActionWorkerPayload,
    observer?: ActionRunObserver,
    actionEventObserver?: ActionInvocationObserver,
  ): Promise<ActionResult>;
  dispatch?(payload: ActionWorkerPayload): Promise<ActionDispatchReceipt>;
}

export interface MainActionWorkerExecution {
  result: Promise<ActionResult>;
  cancel(reason?: string): void;
}

/** Process-only host implemented by the main ActionEngine. */
export interface MainActionWorkerHost {
  startDelegatedAction(
    payload: ActionWorkerPayload,
    observer?: ActionRunObserver,
  ): MainActionWorkerExecution;
  startDetachedAction?(payload: ActionWorkerPayload): Promise<ActionDispatchReceipt>;
}

interface ActiveDelegatedAction {
  executionId: string;
  rootExecutionId: string;
  owner: object;
  execution: MainActionWorkerExecution;
  cancelRequested: boolean;
}

function eventStreamName(executionId: string): string {
  return `${ACTION_SUBPROCESS_EVENT_PREFIX}${executionId}`;
}

/** Main-owned process coordinator and delegated-worker ownership index. */
export class ActionWorkerCoordinator {
  private readonly byExecution = new Map<string, ActiveDelegatedAction>();
  private readonly byOwner = new Map<object, Set<ActiveDelegatedAction>>();
  private readonly byRoot = new Map<string, Set<ActiveDelegatedAction>>();

  constructor(private readonly host: MainActionWorkerHost) {}

  async run(
    owner: object,
    payload: ActionWorkerPayload,
    onRuntimeEvent: (event: ActionRuntimeEvent) => void,
  ): Promise<DelegatedActionRunOutcome> {
    const executionId = payload.context.executionId;
    const rootExecutionId = payload.context.rootExecutionId;
    if (!executionId || !rootExecutionId) {
      return {
        type: "error",
        error: {
          name: "Error",
          message: "Delegated action payload requires executionId and rootExecutionId",
        },
      };
    }
    if (this.byExecution.has(executionId)) {
      return {
        type: "error",
        error: { name: "Error", message: `Delegated action already running: ${executionId}` },
      };
    }

    let execution: MainActionWorkerExecution;
    try {
      execution = this.host.startDelegatedAction(payload, { onRuntimeEvent });
    } catch (err) {
      return this.toOutcome(err);
    }
    const active: ActiveDelegatedAction = {
      executionId,
      rootExecutionId,
      owner,
      execution,
      cancelRequested: false,
    };
    this.byExecution.set(executionId, active);
    this.addIndex(this.byOwner, owner, active);
    this.addIndex(this.byRoot, rootExecutionId, active);

    try {
      return { type: "result", result: await execution.result };
    } catch (err) {
      return this.toOutcome(err);
    } finally {
      this.remove(active);
    }
  }

  cancelRoot(rootExecutionId: string, reason = "Cancelled by user"): number {
    return this.cancelSet(this.byRoot.get(rootExecutionId), reason);
  }

  cancelOwner(owner: object, reason = "Owner worker disconnected"): number {
    return this.cancelSet(this.byOwner.get(owner), reason);
  }

  cancelAll(reason = "Rome main process shutting down"): number {
    return this.cancelSet(new Set(this.byExecution.values()), reason);
  }

  activeCount(): number {
    return this.byExecution.size;
  }

  async dispatch(payload: ActionWorkerPayload): Promise<ActionDispatchReceipt> {
    if (!this.host.startDetachedAction) {
      throw new Error("Main action worker host does not support detached actions");
    }
    return await this.host.startDetachedAction(payload);
  }

  private cancelSet(actions: Set<ActiveDelegatedAction> | undefined, reason: string): number {
    if (!actions) return 0;
    const snapshot = [...actions];
    let cancelled = 0;
    for (const active of snapshot) {
      if (active.cancelRequested) continue;
      active.cancelRequested = true;
      active.execution.cancel(reason);
      cancelled++;
    }
    return cancelled;
  }

  private addIndex<K>(
    index: Map<K, Set<ActiveDelegatedAction>>,
    key: K,
    active: ActiveDelegatedAction,
  ): void {
    let values = index.get(key);
    if (!values) {
      values = new Set();
      index.set(key, values);
    }
    values.add(active);
  }

  private remove(active: ActiveDelegatedAction): void {
    this.byExecution.delete(active.executionId);
    this.removeIndex(this.byOwner, active.owner, active);
    this.removeIndex(this.byRoot, active.rootExecutionId, active);
  }

  private removeIndex<K>(
    index: Map<K, Set<ActiveDelegatedAction>>,
    key: K,
    active: ActiveDelegatedAction,
  ): void {
    const values = index.get(key);
    if (!values) return;
    values.delete(active);
    if (values.size === 0) index.delete(key);
  }

  private toOutcome(err: unknown): DelegatedActionRunOutcome {
    const error = err instanceof Error ? err : new Error(String(err));
    if (error.name === "ActionCancelledError") {
      return { type: "cancelled", message: error.message };
    }
    if (error.name === "ActionWorkerExitError") {
      return { type: "worker_exit", message: error.message };
    }
    return { type: "error", error: toWireError(error) };
  }
}

/** Register main's delegated-action surface on an existing worker control RPC. */
export function registerActionSubprocessHost(
  rpc: IpcRpc,
  coordinator: ActionWorkerCoordinator,
  owner: object,
): () => void {
  rpc.handle<DelegatedActionRunRequest, DelegatedActionRunOutcome>(
    ACTION_SUBPROCESS_RUN_METHOD,
    async ({ payload }, context: IpcCallContext) => {
      const executionId = payload.context.executionId;
      if (!executionId) {
        return {
          type: "error",
          error: { name: "Error", message: "Delegated action payload requires executionId" },
        };
      }
      const stream = context.openStream<ActionRuntimeEvent>(eventStreamName(executionId));
      try {
        return await replayContext.exit(() =>
          actionExecutionContext.exit(() =>
            coordinator.run(owner, payload, (event) => stream.send(event)),
          ),
        );
      } finally {
        stream.close();
      }
    },
  );
  rpc.handle<DetachedActionDispatchRequest, ActionDispatchReceipt>(
    ACTION_ROOT_DISPATCH_METHOD,
    async ({ payload }) =>
      await replayContext.exit(() =>
        actionExecutionContext.exit(() => coordinator.dispatch(payload)),
      ),
  );
  return rpc.onDisconnect(() => {
    coordinator.cancelOwner(owner);
  });
}

interface EventSink {
  onEvent(event: ActionRuntimeEvent): void;
  resolve(): void;
  reject(error: Error): void;
}

class DelegatedEventRouter {
  private readonly sinks = new Map<string, EventSink>();

  constructor(rpc: IpcRpc) {
    rpc.onStream<ActionRuntimeEvent>(/^action\.subprocess\.events:/, async (stream) => {
      await this.consume(stream);
    });
  }

  claim(
    name: string,
    onEvent: (event: ActionRuntimeEvent) => void,
  ): {
    done: Promise<void>;
    release(): void;
  } {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const done = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.sinks.set(name, { onEvent, resolve, reject });
    return {
      done,
      release: () => {
        this.sinks.delete(name);
      },
    };
  }

  private async consume(stream: IpcInboundStream<ActionRuntimeEvent>): Promise<void> {
    const sink = this.sinks.get(stream.name);
    if (!sink) return;
    try {
      for await (const event of stream.iter()) sink.onEvent(event);
      sink.resolve();
    } catch (err) {
      sink.reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.sinks.delete(stream.name);
    }
  }
}

const eventRouters = new WeakMap<IpcRpc, DelegatedEventRouter>();

function routerFor(ipc: IpcRpc): DelegatedEventRouter {
  let router = eventRouters.get(ipc);
  if (!router) {
    router = new DelegatedEventRouter(ipc);
    eventRouters.set(ipc, router);
  }
  return router;
}

/** Worker-side client. It never imports or invokes child_process.fork. */
export class DelegatedActionClient implements ActionSubprocessRunner {
  constructor(private readonly rpc: IpcRpc = getWorkerIpc()) {}

  async run(
    payload: ActionWorkerPayload,
    observer?: ActionRunObserver,
    actionEventObserver?: ActionInvocationObserver,
  ): Promise<ActionResult> {
    const executionId = payload.context.executionId;
    if (!executionId) throw new Error("Delegated action payload requires executionId");
    const streamName = eventStreamName(executionId);
    const claim = routerFor(this.rpc).claim(streamName, (event) => {
      try {
        observer?.onRuntimeEvent?.(event);
      } catch {
        // Match ActionEngine observer semantics: observers cannot fail work.
      }
      if (event.type === "action_event" && event.sourceExecutionId === executionId) {
        try {
          actionEventObserver?.onActionEvent?.(event.event as ActionEvent);
        } catch {
          // Direct action-event observers are isolated from the action result.
        }
      }
    });

    let outcome: DelegatedActionRunOutcome;
    try {
      outcome = await this.rpc.call<DelegatedActionRunRequest, DelegatedActionRunOutcome>(
        ACTION_SUBPROCESS_RUN_METHOD,
        { payload },
        { timeoutMs: null },
      );
      await claim.done;
    } finally {
      claim.release();
    }

    switch (outcome.type) {
      case "result":
        return outcome.result;
      case "cancelled":
        throw new ActionCancelledError(outcome.message);
      case "worker_exit":
        throw new ActionWorkerExitError(outcome.message);
      case "error": {
        throw fromWireError(outcome.error);
      }
    }
  }

  async dispatch(payload: ActionWorkerPayload): Promise<ActionDispatchReceipt> {
    return await this.rpc.call<DetachedActionDispatchRequest, ActionDispatchReceipt>(
      ACTION_ROOT_DISPATCH_METHOD,
      { payload },
    );
  }
}
