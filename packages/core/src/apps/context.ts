import { AsyncLocalStorage } from "node:async_hooks";
import { actionExecutionContext } from "../actions/context.js";
import {
  type ActionDispatchReceipt,
  ActionInvocationError,
  ActionInvocationEventOverflowError,
  type ActionEvent,
  type ActionInvocation,
  type AppFavorCapability,
  type AppRuntimeRepositories,
  type DetachedRunActionOptions,
  type RunActionOptions,
  type RomeAppDefinition as SdkRomeAppDefinition,
} from "@rome-os/app-runtime";
import type { ActionEngine } from "../actions/engine.js";
import { callAction } from "../actions/call-action.js";
import type { ActionInvocationObserver } from "../actions/runtime-events.js";
import type { ActionResult } from "../actions/types.js";
import type { DrizzleDb } from "../db/index.js";
import { toRoutine } from "../db/repositories/routines.js";
import type { RoutinesRepository } from "../db/repositories/routines.js";
import type { Routine } from "../routines/types.js";
import { createAppLogger, type Logger } from "../logger.js";
import type { AppCatalog } from "./catalog.js";
import type { ResolvedApp } from "./state.js";
import type { AgentRunnerInterface } from "../core/types.js";
import type { RomeAppViewer } from "../lib/visitor-session.js";
import type { FavorService } from "../favors/types.js";

export interface AppDbContext {
  connection: DrizzleDb;
  tablePrefix: string;
  tableName(name: string): string;
}

export interface RomeAppContext {
  app: SdkRomeAppDefinition;
  catalog: AppCatalog;
  controller: unknown;
  db: AppDbContext;
  log: Logger;
  repositories: AppRuntimeRepositories;
  favors: AppFavorCapability;
  runAction(
    name: string,
    args: Record<string, unknown>,
    options?: RunActionOptions,
  ): Promise<ActionResult>;
  runAction(
    name: string,
    args: Record<string, unknown>,
    options: DetachedRunActionOptions,
  ): Promise<ActionDispatchReceipt>;
  invokeAction<TEvent extends ActionEvent = ActionEvent, TOutput = unknown>(
    name: string,
    args: Record<string, unknown>,
  ): ActionInvocation<TEvent, TOutput>;
  listRoutines(): Promise<Routine[]>;
}

export interface RomeAppRuntimeServices {
  catalog: AppCatalog;
  db: DrizzleDb;
  actionEngine: ActionEngine;
  agentRunner?: AgentRunnerInterface;
  routinesRepo?: RoutinesRepository;
  repositories: AppRuntimeRepositories;
  favorService?: FavorService;
}

interface AppApiRequestContext {
  viewer?: RomeAppViewer;
}

const appApiRequestContext = new AsyncLocalStorage<AppApiRequestContext>();

export function runWithRomeAppApiRequestContext<T>(
  context: AppApiRequestContext,
  fn: () => Promise<T>,
): Promise<T> {
  return appApiRequestContext.run(context, fn);
}

export function createAppDbContext(app: ResolvedApp, connection: DrizzleDb): AppDbContext {
  const tablePrefix = app.db?.tablePrefix ?? app.manifest.db?.tablePrefix ?? app.appId;
  return {
    connection,
    tablePrefix,
    tableName(name: string) {
      return `${tablePrefix}__${name}`;
    },
  };
}

/**
 * Force `value` through the same JSON serialization Node's fork IPC applies on
 * the subprocess path, so an in-process invocation observes identical data to
 * a cross-process one: `Date` → ISO string, `undefined` fields
 * dropped, no shared references, circular/BigInt input rejected loudly.
 */
function toWireShape<T>(
  value: T,
  actionName: string,
  what: "args" | "result" | "dispatch receipt",
): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch (err) {
    throw new ActionInvocationError(
      actionName,
      "unserializable",
      `Action ${what} for "${actionName}" cannot cross a process boundary: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

const ACTION_EVENT_BUFFER_CAPACITY = 32;

class ActionEventQueue<TEvent extends ActionEvent> implements AsyncIterable<TEvent> {
  private values: TEvent[] = [];
  private waiters: Array<{
    resolve: (result: IteratorResult<TEvent>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private ended = false;
  private disposed = false;
  private claimed = false;
  private failure: Error | undefined;

  push(event: TEvent): void {
    if (this.ended || this.disposed || this.failure) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: event, done: false });
      return;
    }
    if (this.values.length >= ACTION_EVENT_BUFFER_CAPACITY) {
      this.fail(new ActionInvocationEventOverflowError(ACTION_EVENT_BUFFER_CAPACITY));
      return;
    }
    this.values.push(event);
  }

  close(): void {
    if (this.ended || this.disposed || this.failure) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<TEvent> {
    if (this.claimed) {
      throw new Error("Action invocation events can only be consumed once");
    }
    this.claimed = true;
    return {
      next: () => this.next(),
      return: async () => {
        this.disposed = true;
        this.values = [];
        for (const waiter of this.waiters.splice(0)) {
          waiter.resolve({ value: undefined as never, done: true });
        }
        return { value: undefined as never, done: true };
      },
    };
  }

  private next(): Promise<IteratorResult<TEvent>> {
    if (this.values.length > 0) {
      return Promise.resolve({ value: this.values.shift()!, done: false });
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.ended || this.disposed) {
      return Promise.resolve({ value: undefined as never, done: true });
    }
    return new Promise<IteratorResult<TEvent>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  private fail(error: Error): void {
    this.failure = error;
    this.values = [];
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }
}

export function createRomeAppContext(
  app: ResolvedApp,
  services: RomeAppRuntimeServices,
): RomeAppContext {
  const log = createAppLogger(`app:${app.appId}`, app.appId);
  const invokeActionResult = async (
    name: string,
    args: Record<string, unknown>,
    actionEventObserver?: ActionInvocationObserver,
  ): Promise<ActionResult> => {
    const wireArgs = toWireShape(args ?? {}, name, "args");
    let result: ActionResult;
    try {
      const store = actionExecutionContext.getStore();
      // Stamp the calling app on the invocation so the callee can attribute
      // the work to it. The direct event observer is bound only to this hop.
      result = store?.engine
        ? await callAction(name, wireArgs, {
            callerAppId: app.appId,
            actionEventObserver,
          })
        : await services.actionEngine.run(
            name,
            wireArgs,
            {
              initiator: `app:${app.appId}`,
              callerAppId: app.appId,
            },
            undefined,
            actionEventObserver,
          );
    } catch (err) {
      if (err instanceof Error && err.name === "ActionCancelledError") {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      log.warn("action invocation failed", {
        action: name,
        error: message,
        stack: err instanceof Error ? err.stack : undefined,
      });
      if (err instanceof Error && err.name === "ActionNotFoundError") {
        throw new ActionInvocationError(name, "not_found", message);
      }
      if (err instanceof Error && err.name === "ActionWorkerExitError") {
        throw new ActionInvocationError(name, "worker_failure", message);
      }
      throw new ActionInvocationError(name, "handler_error", message);
    }
    return toWireShape(result, name, "result");
  };

  async function runAction(
    name: string,
    args: Record<string, unknown>,
    options?: RunActionOptions,
  ): Promise<ActionResult>;
  async function runAction(
    name: string,
    args: Record<string, unknown>,
    options: DetachedRunActionOptions,
  ): Promise<ActionDispatchReceipt>;
  async function runAction(
    name: string,
    args: Record<string, unknown>,
    options: RunActionOptions | DetachedRunActionOptions = {},
  ): Promise<ActionResult | ActionDispatchReceipt> {
    if (!options.detached) return await invokeActionResult(name, args);

    const wireArgs = toWireShape(args ?? {}, name, "args");
    try {
      const store = actionExecutionContext.getStore();
      const engine = store?.engine ?? services.actionEngine;
      const receipt = await engine.dispatch(name, wireArgs, {
        initiator: store?.initiator ?? `app:${app.appId}`,
        actor: store?.actor,
        callerAppId: app.appId,
        channelContext: store?.channelContext,
        sharedContext: store?.sharedContext,
        sessionId: store?.sessionId,
        romeSessionId: store?.romeSessionId,
        agentName: store?.agentName,
        channelThreadKey: store?.channelThreadKey,
      });
      return toWireShape(receipt, name, "dispatch receipt");
    } catch (err) {
      if (err instanceof Error && err.name === "ActionCancelledError") throw err;
      const message = err instanceof Error ? err.message : String(err);
      log.warn("detached action dispatch failed", {
        action: name,
        error: message,
        stack: err instanceof Error ? err.stack : undefined,
      });
      if (err instanceof Error && err.name === "ActionNotFoundError") {
        throw new ActionInvocationError(name, "not_found", message);
      }
      if (err instanceof Error && err.name === "ActionWorkerExitError") {
        throw new ActionInvocationError(name, "worker_failure", message);
      }
      throw new ActionInvocationError(name, "handler_error", message);
    }
  }

  return {
    app: toRomeAppDefinition(app),
    catalog: services.catalog,
    controller: undefined,
    db: createAppDbContext(app, services.db),
    log,
    repositories: services.repositories,
    favors: {
      async requestAction(input) {
        const requestContext = appApiRequestContext.getStore();
        if (!requestContext?.viewer) {
          return { status: "error", error: "visitor_auth_required" };
        }
        if (!services.favorService) {
          return { status: "error", error: "favor_service_unavailable" };
        }
        const result = await services.favorService.requestAction({
          app,
          viewer: requestContext.viewer,
          actionName: input.actionName,
          args: input.args,
          taskRef: input.taskRef,
          idempotencyKey: input.idempotencyKey,
          returnTo: input.returnTo,
        });
        if (result.status === "pending_consent") {
          return {
            status: "pending_consent",
            requestId: result.request.id,
            authorizationUrl: result.authorizationUrl,
            request: result.request,
          };
        }
        if (result.status === "declined") {
          return { status: "declined", requestId: result.request.id, request: result.request };
        }
        return result;
      },
    },
    // Nested calls preserve the Promise<ActionResult> port; detached
    // calls return only main's acceptance receipt for a new root execution.
    runAction,
    // Eager invocation with one direct, single-consumer event stream.
    invokeAction<TEvent extends ActionEvent = ActionEvent, TOutput = unknown>(
      name: string,
      args: Record<string, unknown>,
    ): ActionInvocation<TEvent, TOutput> {
      const queue = new ActionEventQueue<TEvent>();
      const result = invokeActionResult(name, args, {
        onActionEvent(event) {
          queue.push(event as TEvent);
        },
      }) as Promise<ActionResult<TOutput>>;
      // Closing the event stream must happen for both resolution and rejection.
      // Supplying both handlers also marks the eager result as observed while
      // callers are still awaiting early events; awaiting the original Promise
      // continues to receive its original value or rejection.
      void result.then(
        () => queue.close(),
        () => queue.close(),
      );
      return { events: queue, result };
    },
    async listRoutines(): Promise<Routine[]> {
      if (!services.routinesRepo) {
        return [];
      }

      const rows = await services.routinesRepo.findAll();
      return rows.map(toRoutine);
    },
  };
}

function toRomeAppDefinition(app: ResolvedApp): SdkRomeAppDefinition {
  return {
    id: app.manifest.id,
    version: app.manifest.version,
    description: app.manifest.description,
  };
}
