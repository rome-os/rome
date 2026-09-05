import type { ChildProcess, ForkOptions } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Span, Tracer } from "@opentelemetry/api";
import { context, propagation, SpanStatusCode } from "@opentelemetry/api";
import { v4 as uuid } from "uuid";
import type {
  ActionDispatchReceipt,
  ActionExecutionContext,
  ActionEvent,
} from "@rome-os/app-runtime";
import type {
  Action,
  ActionRegistry,
  ActionResult,
  PendingApproval,
  PreviewPayload,
} from "./types.js";
import type {
  ActionExecutionStatus,
  ActionExecutionsRepository,
} from "../db/repositories/action-executions.js";
import type { ApprovalsRepository } from "../db/repositories/approvals.js";
import type { ExecutionJournalRepository } from "../db/repositories/execution-journal.js";
import { actionExecutionContext } from "./context.js";
import {
  replayContext,
  ReplayDivergenceError,
  hashArgs,
  type JournalEntry,
  type ReplayStore,
} from "./replay.js";
import { createLogger } from "../logger.js";
import { currentSessionId } from "../telemetry-context.js";
import { getChannelFromThreadKey } from "../core/session-manager.js";
import { artifactLocalName } from "../apps/artifact-id.js";
import {
  isActionWorkerMessage,
  type ActionWorkerPayload,
  type ActionWorkerShutdown,
} from "./worker-protocol.js";
import {
  normalizeActionEvent,
  type ActionInvocationObserver,
  type ActionRunObserver,
  type ActionRuntimeEvent,
} from "./runtime-events.js";
import type { ThreadContext } from "../core/types.js";
import type { WorkerRpcServer } from "./worker-rpc.js";
import type { AgentSessionChildBridge } from "../core/agent-session-bridge.js";
import { actionDurationMetric } from "../telemetry.js";
import { systemClock, type Clock, type ClockTimer } from "../lib/clock.js";
import {
  getCurrentHookInvocationContext,
  runWithHookInvocationContext,
  type HookInvocationContext,
} from "../core/hook-recursion.js";
import {
  ActionCancelledError,
  ActionWorkerCapacityError,
  ActionWorkerExitError,
} from "./action-errors.js";
import { currentSessionActor, type SessionActor } from "../lib/session-actor.js";
import {
  ActionWorkerCoordinator,
  DelegatedActionClient,
  type ActionSubprocessRunner,
  type MainActionWorkerExecution,
} from "./action-subprocess.js";

export { ActionWorkerCapacityError, ActionWorkerExitError } from "./action-errors.js";

const log = createLogger("action-engine");

/**
 * Derive the identifying attrs (agent.name / session.id / channel.*) that
 * every Rome-owned span gets stamped with, from the ActionRunContext the
 * caller passed in. Returns only fields that are actually present so the
 * caller can spread the result into a span-attr bag without sentinel values.
 *
 * We stamp these explicitly (not via OTel baggage) so the values never
 * escape into outbound HTTP/gRPC headers via the default W3C Baggage
 * propagator. The action worker receives the same ActionRunContext over
 * IPC and re-derives the attrs from it for its own spans.
 */
function buildRomeSpanAttrs(ctx?: ActionRunContext): Record<string, string> {
  if (!ctx) return {};
  const out: Record<string, string> = {};
  if (ctx.agentName) out["agent.name"] = ctx.agentName;
  if (ctx.sessionId) out["session.id"] = ctx.sessionId;
  if (ctx.turnId) out["turn.id"] = ctx.turnId;
  if (ctx.channelThreadKey) {
    out["channel.thread_key"] = ctx.channelThreadKey;
    const name = getChannelFromThreadKey(ctx.channelThreadKey);
    if (name) out["channel.name"] = name;
  }
  return out;
}

export function resolveActionWorkerEntryPath(moduleUrl: string): string {
  const modulePath = fileURLToPath(moduleUrl);
  const workerExtension = modulePath.endsWith(".js") ? ".js" : ".ts";
  if (basename(modulePath) === `index${workerExtension}`) {
    const moduleDir = dirname(modulePath);
    const distDir = basename(moduleDir) === "daemon" ? dirname(moduleDir) : moduleDir;
    return resolve(distDir, "actions", `worker-bootstrap${workerExtension}`);
  }

  return fileURLToPath(new URL(`./worker-bootstrap${workerExtension}`, moduleUrl));
}

const WORKER_ENTRY_PATH = resolveActionWorkerEntryPath(import.meta.url);
const CANCEL_SIGNAL_GRACE_MS = 5_000;
const DEFAULT_WORKER_WARM_POOL_SIZE = 1;
const DEFAULT_WORKER_MAX_USES = 100;

export interface ActionRunContext {
  initiator?: string;
  /** The authenticated session identity accountable for this chain. Root calls
   * that omit it inherit the ambient actor (`runWithSessionActor` — set by the
   * /api middleware and the app WS server) or the parent execution's actor, so
   * interactive entry points never have to thread it by hand. Inherited down
   * the whole chain, like `initiator`'s chain origin and unlike `callerAppId`.
   * Persisted on every `action_executions` row. */
  actor?: SessionActor;
  /** The app that directly invoked this action through its app-context
   * `runAction`. Set ONLY at that seam and carried per-hop — unlike `initiator`
   * it is never inherited from the parent store, so it names the immediate
   * caller, not the chain origin. Lets an action attribute work to the calling
   * app (e.g. create_routine stamps a routine's `managedBy`). Undefined for
   * agent / user / system-initiated calls. */
  callerAppId?: string;
  channelContext?: ThreadContext;
  sharedContext?: Record<string, unknown>;
  hookInvocationContext?: HookInvocationContext;
  replayJournal?: JournalEntry[];
  /** Original root execution ID to reuse during replay */
  replayRootExecutionId?: string;
  divergenceMode?: "fallthrough" | "strict";
  /** Session info for agent-level resumption on approval */
  sessionId?: string;
  /** Durable Rome session id of the calling agent session, when one called.
   * Distinct from `sessionId` (the runtime AgentSession handle): this is the
   * id a child session is parented by. */
  romeSessionId?: string;
  agentName?: string;
  channelThreadKey?: string;
  /** Allocated by AgentSession.sendTurn; stamped on `action:*` spans so the
   *  trace UI can group every action invocation that happened within one
   *  turn under the originating `agent:*`. */
  turnId?: string;
  executionId?: string;
  rootExecutionId?: string;
  parentExecutionId?: string;
  parentActionName?: string;
  actionName?: string;
}

export interface ApprovalCreatedEvent {
  approvalId: string;
  actionName: string;
  args: Record<string, unknown>;
  preview?: PreviewPayload;
  channelContext?: ThreadContext;
}

interface ActionEngineOptions {
  processRole?: "main" | "worker";
  /**
   * Hard cap for every live action-worker process owned by main, including
   * warm, root, and delegated workers. Capacity exhaustion fails immediately:
   * waiting for capacity inside a nested action would retain its ancestors and
   * can deadlock a chain such as A -> B -> C -> D.
   */
  maxWorkerProcesses?: number;
  /**
   * Number of already-initialized action workers to keep ready in the main
   * process. Root actions take a ready worker and fall back
   * to a cold fork when the pool is busy.
   */
  workerWarmPoolSize?: number;
  /**
   * Recycle reusable workers after this many completed action payloads. This
   * bounds memory retained by app module globals and other worker-local caches.
   */
  workerMaxUses?: number;
  /**
   * Fired after an approval record is created. Used to surface approval cards
   * to the originating channel (e.g., emit a web-chat message with a card
   * part). Failures here are logged but do not fail the agent turn.
   */
  onApprovalCreated?: (event: ApprovalCreatedEvent) => Promise<void> | void;
  /** Time source for durations, row timestamps, and the cancel escalation
   * timer. Defaults to the system clock; tests inject a FakeClock. */
  clock?: Clock;
  /** Worker-side transport for nested cancellable actions. */
  actionSubprocessRunner?: ActionSubprocessRunner;
  /** Main-only process factory. Worker engines intentionally receive none. */
  actionWorkerFork?: (entryPath: string, options: ForkOptions) => ChildProcess;
}

interface ExecutionInvocation {
  action: Action;
  name: string;
  args: Record<string, unknown>;
  executionId: string;
  rootExecutionId: string;
  parentId?: string;
  initiator: string;
  actor?: SessionActor;
  context?: ActionRunContext;
  isRoot: boolean;
}

function mergeSharedContext(
  parentSharedContext?: Record<string, unknown>,
  childSharedContext?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!parentSharedContext && !childSharedContext) {
    return undefined;
  }

  return {
    ...(parentSharedContext ?? {}),
    ...(childSharedContext ?? {}),
  };
}

function withCurrentHookInvocationContext(
  context?: ActionRunContext,
): ActionRunContext | undefined {
  if (context?.hookInvocationContext) {
    return context;
  }
  const currentHookInvocationContext = getCurrentHookInvocationContext();
  if (!currentHookInvocationContext) {
    return context;
  }
  return {
    ...(context ?? {}),
    hookInvocationContext: currentHookInvocationContext,
  };
}

interface ActiveRootProcess {
  worker: ActionWorkerProcess;
  cancelTimer: ClockTimer | null;
}

type ActionWorkerState = "starting" | "idle" | "running" | "stopping";

interface ActionWorkerProcess {
  child: ChildProcess;
  state: ActionWorkerState;
  pooled: boolean;
  generation: number;
  retireAfterRun: boolean;
  useCount: number;
  hasBeenReady: boolean;
  attached: boolean;
  sessionRpc?: { dispose(): void };
}

/** Thrown by {@link ActionEngine.run} when `name` is not in the registry.
 * Typed so the app-facing invocation port can map it to `code: "not_found"`
 * without matching on the message. */
export class ActionNotFoundError extends Error {
  constructor(actionName: string) {
    super(`Action "${actionName}" not found`);
    this.name = "ActionNotFoundError";
  }
}

export class ActionEngine {
  private tracer: Tracer | null;
  private executionsRepo: ActionExecutionsRepository | null;
  private approvalsRepo: ApprovalsRepository | null;
  private journalRepo: ExecutionJournalRepository | null;
  private activeRootProcesses = new Map<string, ActiveRootProcess>();
  private processRole: "main" | "worker";
  private workerRpcServer: WorkerRpcServer | null = null;
  private agentSessionBridge: AgentSessionChildBridge | null = null;
  private actionWorkerCoordinator: ActionWorkerCoordinator | null = null;
  private actionSubprocessRunner: ActionSubprocessRunner | null;
  private actionWorkerFork: ActionEngineOptions["actionWorkerFork"];
  private onApprovalCreated: ActionEngineOptions["onApprovalCreated"];
  private clock: Clock;
  private workerWarmPoolSize: number;
  private workerMaxUses: number;
  private maxWorkerProcesses: number;
  private workerWarmPoolStarted = false;
  private workerPoolGeneration = 0;
  private warmWorkers = new Set<ActionWorkerProcess>();
  private liveWorkers = new Set<ActionWorkerProcess>();

  constructor(
    private registry: ActionRegistry,
    tracer?: Tracer,
    executionsRepo?: ActionExecutionsRepository,
    approvalsRepo?: ApprovalsRepository,
    journalRepo?: ExecutionJournalRepository,
    options?: ActionEngineOptions,
  ) {
    this.tracer = tracer ?? null;
    this.executionsRepo = executionsRepo ?? null;
    this.approvalsRepo = approvalsRepo ?? null;
    this.journalRepo = journalRepo ?? null;
    this.processRole = options?.processRole ?? "worker";
    this.onApprovalCreated = options?.onApprovalCreated;
    this.clock = options?.clock ?? systemClock;
    this.actionSubprocessRunner = options?.actionSubprocessRunner ?? null;
    this.actionWorkerFork = options?.actionWorkerFork;
    this.workerWarmPoolSize =
      this.processRole === "main"
        ? Math.max(0, Math.floor(options?.workerWarmPoolSize ?? DEFAULT_WORKER_WARM_POOL_SIZE))
        : 0;
    this.workerMaxUses =
      this.processRole === "main"
        ? Math.max(1, Math.floor(options?.workerMaxUses ?? DEFAULT_WORKER_MAX_USES))
        : 1;
    this.maxWorkerProcesses =
      this.processRole === "main"
        ? Math.max(1, Math.floor(options?.maxWorkerProcesses ?? Number.POSITIVE_INFINITY))
        : 0;
  }

  setWorkerRpcServer(server: WorkerRpcServer | null): void {
    this.workerRpcServer = server;
  }

  setAgentSessionBridge(bridge: AgentSessionChildBridge | null): void {
    this.agentSessionBridge = bridge;
  }

  setActionWorkerCoordinator(coordinator: ActionWorkerCoordinator | null): void {
    this.actionWorkerCoordinator = coordinator;
  }

  startWorkerWarmPool(): void {
    if (this.processRole !== "main" || this.workerWarmPoolSize <= 0) return;
    this.workerWarmPoolStarted = true;
    this.ensureWorkerWarmPool();
  }

  async restartWorkerWarmPool(): Promise<void> {
    if (this.processRole !== "main" || this.workerWarmPoolSize <= 0) return;
    this.workerPoolGeneration++;
    const wasStarted = this.workerWarmPoolStarted;
    const workers = new Set<ActionWorkerProcess>([
      ...this.warmWorkers,
      ...[...this.activeRootProcesses.values()].map((active) => active.worker),
    ]);
    await Promise.all(
      [...workers].map((worker) => {
        if (worker.state === "running") {
          worker.retireAfterRun = true;
          this.warmWorkers.delete(worker);
          return Promise.resolve();
        }
        return this.stopWorker(worker);
      }),
    );
    if (wasStarted) {
      this.workerWarmPoolStarted = true;
      this.ensureWorkerWarmPool();
    }
  }

  async stopWorkerWarmPool(): Promise<void> {
    this.workerWarmPoolStarted = false;
    const workers = [...this.warmWorkers];
    await Promise.all(workers.map((worker) => this.stopWorker(worker)));
  }

  async run(
    name: string,
    args: Record<string, unknown>,
    context?: ActionRunContext,
    observer?: ActionRunObserver,
    actionEventObserver?: ActionInvocationObserver,
    onRootAccepted?: () => void,
  ): Promise<ActionResult> {
    const action = this.registry.get(name);
    if (!action) {
      throw new ActionNotFoundError(name);
    }
    const runContext = withCurrentHookInvocationContext(context);

    const inheritedObserver = observer ?? actionExecutionContext.getStore()?.runtimeObserver;

    const existingReplayStore = replayContext.getStore();
    if (existingReplayStore) {
      return this.handleNestedCall(
        action,
        args,
        existingReplayStore,
        runContext,
        inheritedObserver,
        actionEventObserver,
      );
    }

    return this.handleRootCall(
      action,
      args,
      runContext,
      inheritedObserver,
      actionEventObserver,
      onRootAccepted,
    );
  }

  async dispatch(
    name: string,
    args: Record<string, unknown>,
    context?: ActionRunContext,
  ): Promise<ActionDispatchReceipt> {
    const action = this.registry.get(name);
    if (!action) {
      throw new ActionNotFoundError(name);
    }
    const resolvedName = action.config.name;
    const executionId = uuid();
    const runContext = withCurrentHookInvocationContext(context);
    // Resolve the actor before detaching: the ambient handle belongs to the
    // originating request's async scope and is not reachable from the new root.
    const actor =
      runContext?.actor ??
      actionExecutionContext.getStore()?.actor ??
      (await currentSessionActor());
    const payload: ActionWorkerPayload = {
      actionName: resolvedName,
      args,
      context: {
        initiator: runContext?.initiator,
        actor,
        callerAppId: runContext?.callerAppId,
        channelContext: runContext?.channelContext,
        sharedContext: runContext?.sharedContext,
        hookInvocationContext: runContext?.hookInvocationContext,
        sessionId: runContext?.sessionId,
        romeSessionId: runContext?.romeSessionId,
        agentName: runContext?.agentName,
        channelThreadKey: runContext?.channelThreadKey,
        turnId: runContext?.turnId,
        actionName: resolvedName,
        executionId,
        rootExecutionId: executionId,
      },
    };

    if (this.processRole === "worker") {
      if (!this.actionSubprocessRunner) {
        this.actionSubprocessRunner = new DelegatedActionClient();
      }
      if (!this.actionSubprocessRunner.dispatch) {
        throw new Error("Action subprocess runner does not support detached actions");
      }
      return await this.actionSubprocessRunner.dispatch(payload);
    }

    return this.startDetachedAction(payload);
  }

  async cancel(rootExecutionId: string): Promise<boolean> {
    const active = this.activeRootProcesses.get(rootExecutionId);
    if (!active?.worker.child.pid) {
      return false;
    }

    if (this.hasExecutionCancelSupport()) {
      await this.executionsRepo!.markCancelRequested(rootExecutionId);
    }

    this.sendCancelSignal(active.worker.child, "SIGTERM");
    this.actionWorkerCoordinator?.cancelRoot(rootExecutionId);
    if (active.cancelTimer) this.clock.clearTimeout(active.cancelTimer);
    active.cancelTimer = this.clock.setTimeout(() => {
      this.sendCancelSignal(active.worker.child, "SIGKILL");
    }, CANCEL_SIGNAL_GRACE_MS);

    return true;
  }

  private async handleRootCall(
    action: Action,
    args: Record<string, unknown>,
    context?: ActionRunContext,
    observer?: ActionRunObserver,
    actionEventObserver?: ActionInvocationObserver,
    onRootAccepted?: () => void,
  ): Promise<ActionResult> {
    const parentStore = actionExecutionContext.getStore();
    const parentId = context?.parentExecutionId ?? parentStore?.executionId;
    const initiator = context?.initiator ?? parentStore?.initiator ?? "unknown";
    const isReplay = !!context?.replayJournal;
    // Explicit wins, then the enclosing execution's actor, then the ambient
    // request actor — so every root run during an authenticated HTTP/WS
    // request is attributed without the route threading identity by hand.
    let actor = context?.actor ?? parentStore?.actor ?? (await currentSessionActor());
    // An actorless approval replay (e.g. granted from a channel flow with no
    // HTTP/WS scope) reuses a root row that already names the accountable
    // requester — inherit it, so children executed during the replay carry
    // the same actor as the root they extend.
    if (!actor && isReplay && context?.replayRootExecutionId && this.executionsRepo) {
      const priorRoot = await this.executionsRepo.findById(context.replayRootExecutionId);
      actor = (priorRoot?.actor as SessionActor | null | undefined) ?? undefined;
    }
    if (actor && context?.actor !== actor) {
      context = { ...(context ?? {}), actor };
    }
    const executionId =
      isReplay && context?.replayRootExecutionId
        ? context.replayRootExecutionId
        : (context?.executionId ?? uuid());
    const rootExecutionId = context?.rootExecutionId ?? executionId;

    const replayStore: ReplayStore = {
      rootExecutionId,
      rootActionName: action.config.name,
      rootArgs: args,
      journal: [],
      nextSequence: 0,
      replayIndex: 0,
      mode: isReplay ? "replay" : "record",
      divergenceMode: context?.divergenceMode ?? "fallthrough",
    };

    let preloadedEntryCount = 0;
    let approvedRootResume = false;
    if (context?.replayJournal) {
      replayStore.journal = [...context.replayJournal];
      preloadedEntryCount = replayStore.journal.length;
      const maxSeq = replayStore.journal.reduce((max, e) => Math.max(max, e.sequence), -1);
      replayStore.nextSequence = maxSeq + 1;
      const first = replayStore.journal[0];
      if (first && first.actionName === action.config.name && first.status === "pending_approval") {
        replayStore.replayIndex = 1;
        replayStore.mode = "record";
        // Post-approval replay of a root requiresApproval action: run the
        // body for real, don't re-create another approval below.
        approvedRootResume = true;
      }
    }

    // Root action itself is sensitive: short-circuit before executing it
    // unless we're replaying after the guardian has already approved it.
    if (action.config.requiresApproval && replayStore.mode === "record" && !approvedRootResume) {
      const pending = await this.withTrace(
        action.config.name,
        buildRomeSpanAttrs(context),
        async (span) => {
          const ref = await this.recordPendingApproval(
            action.config.name,
            args,
            replayStore,
            context,
          );
          if (span) {
            span.setAttribute("rome.action.approval_required", true);
            span.addEvent("approval_required", { "action.name": action.config.name });
          }
          return ref;
        },
      );
      const newApprovalEntries = replayStore.journal.slice(preloadedEntryCount);
      if (newApprovalEntries.length > 0) {
        await this.persistNewEntries(replayStore.rootExecutionId, newApprovalEntries);
      }
      await this.upsertExecutionRecord({
        executionId,
        rootExecutionId,
        actionName: action.config.name,
        actionType: action.config.type,
        status: "pending_approval",
        args,
        initiator,
        actor,
        parentId,
        error: undefined,
      });
      onRootAccepted?.();
      return { status: "pending_approval", approval: pending };
    }

    // For the `summon` action, stamp the child agent name as an attribute
    // so the summon-tree CLI can reconstruct parent/child agent relationships
    // without needing a separate `summon:{child}` span.
    const summonAttrs: Record<string, string> =
      artifactLocalName(action.config.name) === "summon" && typeof args?.agentName === "string"
        ? { child_agent: args.agentName as string }
        : {};
    const spanAttrs: Record<string, string> = {
      ...buildRomeSpanAttrs(context),
      ...summonAttrs,
    };
    const result = await this.withTrace(action.config.name, spanAttrs, () =>
      replayContext.run(replayStore, () =>
        this.executeInvocation(
          {
            action,
            name: action.config.name,
            args,
            executionId,
            rootExecutionId,
            parentId,
            initiator,
            actor,
            context,
            isRoot: true,
          },
          observer,
          actionEventObserver,
          onRootAccepted,
        ),
      ),
    );

    if (approvedRootResume) {
      const entry = replayStore.journal[0];
      if (entry && entry.status === "pending_approval") {
        entry.result = result;
        entry.status = "completed";
        await this.updateJournalEntry(
          replayStore.rootExecutionId,
          entry.sequence,
          result,
          "completed",
        );
      }
    }

    const newEntries = replayStore.journal.slice(preloadedEntryCount);
    if (newEntries.length > 0) {
      await this.persistNewEntries(replayStore.rootExecutionId, newEntries);
    }

    // A nested call in this turn requested approval: surface it on the root
    // result so every caller of the root sees the same signal regardless of
    // where in the tree the approval originated.
    if (replayStore.pendingApproval) {
      return { status: "pending_approval", approval: replayStore.pendingApproval };
    }

    return result;
  }

  private async handleNestedCall(
    action: Action,
    args: Record<string, unknown>,
    store: ReplayStore,
    context?: ActionRunContext,
    observer?: ActionRunObserver,
    actionEventObserver?: ActionInvocationObserver,
  ): Promise<ActionResult> {
    const argsHash = hashArgs(args);

    if (store.mode === "replay") {
      const entry = store.journal[store.replayIndex];

      if (entry && entry.actionName === action.config.name && entry.argsHash === argsHash) {
        if (entry.status === "completed" && entry.result !== null) {
          store.replayIndex++;
          log.info("replay: returning cached result", {
            action: action.config.name,
            sequence: entry.sequence,
          });
          return entry.result;
        }

        if (entry.status === "pending_approval") {
          log.info("replay: executing previously pending action", {
            action: action.config.name,
            sequence: entry.sequence,
          });
          const result = await this.executeNestedInvocation(
            action,
            args,
            store,
            context,
            observer,
            actionEventObserver,
          );
          entry.result = result;
          entry.status = "completed";
          await this.updateJournalEntry(store.rootExecutionId, entry.sequence, result, "completed");
          store.replayIndex++;
          store.mode = "record";
          return result;
        }

        if (entry.status === "diverged") {
          store.replayIndex++;
          store.mode = "record";
          log.info("replay: skipping previously diverged entry", {
            action: action.config.name,
            sequence: entry.sequence,
          });
        }
      } else {
        const expected = entry
          ? { actionName: entry.actionName, argsHash: entry.argsHash }
          : { actionName: "EOF", argsHash: "" };
        const actual = { actionName: action.config.name, argsHash };
        log.warn("replay: divergence detected", {
          sequence: store.replayIndex,
          expected,
          actual,
        });
        store.journal.push({
          sequence: store.nextSequence++,
          actionName: action.config.name,
          argsHash,
          args,
          result: null,
          status: "diverged",
          expectedActionName: expected.actionName,
          expectedArgsHash: expected.argsHash,
          actualActionName: actual.actionName,
          actualArgsHash: actual.argsHash,
        });

        if (store.divergenceMode === "strict") {
          throw new ReplayDivergenceError(expected, actual, store.replayIndex);
        }

        store.mode = "record";
      }
    }

    if (action.config.requiresApproval) {
      const pending = await this.recordPendingApproval(action.config.name, args, store, context);
      return { status: "pending_approval", approval: pending };
    }

    return this.executeNestedInvocation(
      action,
      args,
      store,
      context,
      observer,
      actionEventObserver,
    );
  }

  private async executeNestedInvocation(
    action: Action,
    args: Record<string, unknown>,
    store: ReplayStore,
    context?: ActionRunContext,
    observer?: ActionRunObserver,
    actionEventObserver?: ActionInvocationObserver,
  ): Promise<ActionResult> {
    const parentStore = actionExecutionContext.getStore();
    const executionId = context?.executionId ?? uuid();
    const invocationContext: ActionRunContext = {
      ...context,
      executionId,
      rootExecutionId: parentStore?.rootExecutionId ?? store.rootExecutionId,
      parentExecutionId: parentStore?.executionId,
      parentActionName: parentStore?.actionName,
      initiator: parentStore?.initiator ?? context?.initiator ?? "unknown",
      // Chain-inherited like initiator: the human accountable for the root is
      // accountable for every hop underneath it.
      actor: parentStore?.actor ?? context?.actor,
      channelContext: context?.channelContext ?? parentStore?.channelContext,
      sharedContext: mergeSharedContext(parentStore?.sharedContext, context?.sharedContext),
      sessionId: context?.sessionId ?? parentStore?.sessionId,
      romeSessionId: context?.romeSessionId ?? parentStore?.romeSessionId,
      turnId: context?.turnId ?? parentStore?.turnId,
      agentName: context?.agentName ?? parentStore?.agentName,
      channelThreadKey: context?.channelThreadKey ?? parentStore?.channelThreadKey,
    };

    const result = await this.executeInvocation(
      {
        action,
        name: action.config.name,
        args,
        executionId,
        rootExecutionId: invocationContext.rootExecutionId!,
        parentId: invocationContext.parentExecutionId,
        initiator: invocationContext.initiator!,
        actor: invocationContext.actor,
        context: invocationContext,
        isRoot: false,
      },
      observer,
      actionEventObserver,
    );

    store.journal.push({
      sequence: store.nextSequence++,
      actionName: action.config.name,
      argsHash: hashArgs(args),
      args,
      result,
      status: "completed",
    });

    return result;
  }

  private async executeInvocation(
    invocation: ExecutionInvocation,
    observer?: ActionRunObserver,
    actionEventObserver?: ActionInvocationObserver,
    onRootAccepted?: () => void,
  ): Promise<ActionResult> {
    const { action, name, args, executionId, rootExecutionId, parentId, initiator, actor, isRoot } =
      invocation;
    const mode = this.resolveExecutionMode(action, isRoot);
    const startedAt = this.clock.now();
    await this.ensureExecutionStarted({
      executionId,
      rootExecutionId,
      actionName: name,
      actionType: action.config.type,
      args,
      initiator,
      actor,
      parentId,
      startedAt,
    });

    try {
      const result =
        mode === "subprocess"
          ? await this.executeInSubprocess(
              invocation,
              observer,
              actionEventObserver,
              onRootAccepted,
            )
          : await this.executeInCurrentProcess(
              invocation,
              observer,
              actionEventObserver,
              onRootAccepted,
            );
      const status: ActionExecutionStatus =
        result.status === "pending_approval"
          ? "pending_approval"
          : result.status === "error"
            ? "error"
            : "success";
      if (status === "pending_approval") {
        await this.upsertExecutionRecord({
          executionId,
          rootExecutionId,
          actionName: name,
          actionType: action.config.type,
          status,
          args,
          initiator,
          actor,
          parentId,
          error: undefined,
        });
      } else {
        await this.recordExecutionCompletion({
          executionId,
          rootExecutionId,
          actionName: name,
          actionType: action.config.type,
          status,
          args,
          error: result.status === "error" ? result.error : undefined,
          initiator,
          actor,
          parentId,
          startedAt,
        });
      }
      return result;
    } catch (err) {
      if (err instanceof ActionCancelledError) {
        if (this.hasExecutionCancelSupport()) {
          await this.executionsRepo!.markRootCancelled(
            rootExecutionId,
            this.clock.now(),
            err.message,
          );
        }
      } else if (isRoot && mode === "subprocess" && this.hasExecutionRootErrorSupport()) {
        await this.executionsRepo!.markRootErrored(
          rootExecutionId,
          this.clock.now(),
          err instanceof Error ? err.message : String(err),
        );
        await this.executionsRepo!.update(executionId, {
          durationMs: this.clock.now().getTime() - startedAt.getTime(),
        });
      } else {
        await this.recordExecutionCompletion({
          executionId,
          rootExecutionId,
          actionName: name,
          actionType: action.config.type,
          status: "error",
          args,
          error: err instanceof Error ? err.message : String(err),
          initiator,
          actor,
          parentId,
          startedAt,
        });
      }
      throw err;
    }
  }

  private async executeInCurrentProcess(
    invocation: ExecutionInvocation,
    observer?: ActionRunObserver,
    actionEventObserver?: ActionInvocationObserver,
    onRootAccepted?: () => void,
  ): Promise<ActionResult> {
    const store = {
      executionId: invocation.executionId,
      rootExecutionId: invocation.rootExecutionId,
      initiator: invocation.initiator,
      actor: invocation.actor,
      // Per-hop, straight from this invocation's context (no parentStore
      // fallback), so it names the app that directly invoked this action.
      callerAppId: invocation.context?.callerAppId,
      engine: this,
      actionName: invocation.name,
      parentExecutionId: invocation.parentId,
      parentActionName: invocation.context?.parentActionName,
      channelContext: invocation.context?.channelContext,
      sharedContext: invocation.context?.sharedContext,
      sessionId: invocation.context?.sessionId,
      romeSessionId: invocation.context?.romeSessionId,
      turnId: invocation.context?.turnId,
      agentName: invocation.context?.agentName,
      channelThreadKey: invocation.context?.channelThreadKey,
      runtimeObserver: observer,
    };
    let acceptingEvents = true;
    const executionContext: ActionExecutionContext = {
      emitActionEvent: (event) => {
        if (!acceptingEvents) {
          log.warn("action emitted an event after its handler settled", {
            action: invocation.name,
            executionId: invocation.executionId,
            eventType: event.type,
          });
          return;
        }
        const normalized = normalizeActionEvent(event);
        this.emitRuntimeEvent(observer, {
          type: "action_event",
          event: normalized,
          sourceExecutionId: invocation.executionId,
        });
        this.emitActionInvocationEvent(actionEventObserver, normalized);
      },
    };
    try {
      onRootAccepted?.();
      return await runWithHookInvocationContext(invocation.context?.hookInvocationContext, () =>
        actionExecutionContext.run(store, () =>
          invocation.action.execute(invocation.args, executionContext),
        ),
      );
    } finally {
      acceptingEvents = false;
    }
  }

  private async executeInSubprocess(
    invocation: ExecutionInvocation,
    observer?: ActionRunObserver,
    actionEventObserver?: ActionInvocationObserver,
    onRootAccepted?: () => void,
  ): Promise<ActionResult> {
    // W3C Trace Context inject. `executeInSubprocess` runs inside `withTrace`'s
    // active-span scope, so `context.active()` carries the action span. The
    // global propagator (default `W3CTraceContextPropagator` registered by
    // NodeSDK) writes `traceparent` / `tracestate` keys into the carrier.
    // Worker-side extract restores the parent so `agent:*` / `model.turn`
    // spans nest under this action.
    const traceCarrier: Record<string, string> = {};
    propagation.inject(context.active(), traceCarrier);
    const payload: ActionWorkerPayload = {
      actionName: invocation.name,
      args: invocation.args,
      context: {
        ...(invocation.context ?? {}),
        executionId: invocation.executionId,
        rootExecutionId: invocation.rootExecutionId,
        parentExecutionId: invocation.parentId,
        parentActionName: invocation.context?.parentActionName,
        actionName: invocation.name,
        initiator: invocation.initiator,
        actor: invocation.actor,
      },
      traceCarrier,
      forkStartedAt: this.clock.now().getTime(),
    };

    if (this.processRole === "worker") {
      if (!this.actionSubprocessRunner) {
        this.actionSubprocessRunner = new DelegatedActionClient();
      }
      return await this.actionSubprocessRunner.run(payload, observer, actionEventObserver);
    }

    const worker = this.checkoutWorker(invocation.isRoot);
    const result = this.runPayloadOnWorker(
      worker,
      invocation,
      payload,
      observer,
      actionEventObserver,
    );
    onRootAccepted?.();
    return await result;
  }

  /**
   * Main-only process-layer entry point used by ActionWorkerCoordinator.
   * The payload has already passed W1's logical action/replay/approval path;
   * this method must not call ActionEngine.run() again in main.
   */
  startDelegatedAction(
    payload: ActionWorkerPayload,
    observer?: ActionRunObserver,
  ): MainActionWorkerExecution {
    if (this.processRole !== "main") {
      throw new Error("Only the main ActionEngine can create delegated action workers");
    }
    const executionId = payload.context.executionId;
    const rootExecutionId = payload.context.rootExecutionId;
    if (!executionId || !rootExecutionId) {
      throw new Error("Delegated action payload requires executionId and rootExecutionId");
    }

    const worker = this.checkoutWorker(false);
    let cancelTimer: ClockTimer | null = null;
    const result = this.runPayloadOnWorker(
      worker,
      { executionId, rootExecutionId, isRoot: false },
      payload,
      observer,
    ).finally(() => {
      if (cancelTimer) this.clock.clearTimeout(cancelTimer);
    });

    return {
      result,
      cancel: () => {
        this.sendCancelSignal(worker.child, "SIGTERM");
        if (cancelTimer) this.clock.clearTimeout(cancelTimer);
        cancelTimer = this.clock.setTimeout(() => {
          this.sendCancelSignal(worker.child, "SIGKILL");
        }, CANCEL_SIGNAL_GRACE_MS);
      },
    };
  }

  /** Main-only logical entry point for an action explicitly detached from its
   * caller. Unlike startDelegatedAction, this creates a new root invocation. */
  async startDetachedAction(payload: ActionWorkerPayload): Promise<ActionDispatchReceipt> {
    if (this.processRole !== "main") {
      throw new Error("Only the main ActionEngine can accept detached actions");
    }
    if (!this.registry.get(payload.actionName)) {
      throw new ActionNotFoundError(payload.actionName);
    }
    const executionId = payload.context.executionId;
    if (!executionId || payload.context.rootExecutionId !== executionId) {
      throw new Error("Detached action payload requires one matching execution/root id");
    }
    if (
      payload.context.parentExecutionId !== undefined ||
      payload.context.parentActionName !== undefined
    ) {
      throw new Error("Detached action payload cannot have a parent execution");
    }

    let accepted = false;
    let resolveAccepted!: () => void;
    let rejectAccepted!: (error: unknown) => void;
    const acceptance = new Promise<void>((resolve, reject) => {
      resolveAccepted = resolve;
      rejectAccepted = reject;
    });
    const run = replayContext.exit(() =>
      actionExecutionContext.exit(() =>
        this.run(payload.actionName, payload.args, payload.context, undefined, undefined, () => {
          accepted = true;
          resolveAccepted();
        }),
      ),
    );
    void run.then(
      () => {
        if (!accepted) {
          rejectAccepted(new Error("Detached action settled before root acceptance"));
        }
      },
      (err: unknown) => {
        if (!accepted) {
          rejectAccepted(err);
          return;
        }
        log.warn("detached action failed", {
          action: payload.actionName,
          executionId,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );
    await acceptance;
    return { executionId };
  }

  private checkoutWorker(isRoot: boolean): ActionWorkerProcess {
    if (this.processRole !== "main") {
      throw new Error("Action workers cannot create child worker processes");
    }

    // A ready warm worker is a live process already counted against the cap.
    // It is safe to use it for a delegated action too: worker payloads carry
    // their complete logical context, and this avoids reserving capacity for an
    // idle root-only worker while a nested call needs it.
    for (const worker of this.warmWorkers) {
      if (
        worker.state === "idle" &&
        worker.generation === this.workerPoolGeneration &&
        worker.child.connected
      ) {
        worker.state = "running";
        this.warmWorkers.delete(worker);
        return worker;
      }
    }

    const worker = this.createWorkerProcess({
      pooled: false,
      detached: isRoot,
    });
    worker.state = "running";
    return worker;
  }

  private runPayloadOnWorker(
    worker: ActionWorkerProcess,
    invocation: Pick<ExecutionInvocation, "executionId" | "rootExecutionId" | "isRoot">,
    payload: ActionWorkerPayload,
    observer?: ActionRunObserver,
    actionEventObserver?: ActionInvocationObserver,
  ): Promise<ActionResult> {
    return new Promise<ActionResult>((resolve, reject) => {
      const finish = (options: { reusable: boolean }) => {
        if (invocation.isRoot && this.processRole === "main") {
          const active = this.activeRootProcesses.get(invocation.rootExecutionId);
          if (active?.cancelTimer) this.clock.clearTimeout(active.cancelTimer);
          this.activeRootProcesses.delete(invocation.rootExecutionId);
        }
        this.finishWorkerRun(worker, options);
      };

      let settled = false;

      const onMessage = (message: unknown) => {
        if (settled) return;
        if (!isActionWorkerMessage(message)) return;
        if (message.type === "ready") return;
        if (message.type === "runtime_event") {
          this.emitRuntimeEvent(observer, message.event);
          if (
            message.event.type === "action_event" &&
            message.event.sourceExecutionId === invocation.executionId
          ) {
            this.emitActionInvocationEvent(actionEventObserver, message.event.event);
          }
          return;
        }
        if (message.type === "result") {
          settled = true;
          cleanupListeners();
          finish({ reusable: true });
          resolve(message.result);
          return;
        }
        if (message.type === "error") {
          settled = true;
          cleanupListeners();
          finish({ reusable: false });
          // Rebuild the worker's thrown error from its wire envelope so the
          // caller sees the same name/message an in-process run would produce.
          const err = new Error(message.error.message);
          err.name = message.error.name;
          reject(err);
          return;
        }
      };

      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanupListeners();
        finish({ reusable: false });
        reject(new ActionWorkerExitError(`Action worker failed to start: ${err.message}`));
      };

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        cleanupListeners();
        finish({ reusable: false });
        if (signal || code === 130 || code === 143) {
          reject(new ActionCancelledError("Cancelled by user"));
          return;
        }
        reject(
          new ActionWorkerExitError(
            `Action worker exited unexpectedly (code=${code}, signal=${signal ?? "none"})`,
          ),
        );
      };

      const cleanupListeners = () => {
        worker.child.off("message", onMessage);
        worker.child.off("error", onError);
        worker.child.off("exit", onExit);
      };

      worker.child.on("message", onMessage);
      worker.child.once("error", onError);
      worker.child.once("exit", onExit);

      if (invocation.isRoot && this.processRole === "main") {
        this.activeRootProcesses.set(invocation.rootExecutionId, {
          worker,
          cancelTimer: null,
        });
      }

      worker.child.send(payload, (err) => {
        if (!err || settled) return;
        settled = true;
        cleanupListeners();
        finish({ reusable: false });
        reject(new ActionWorkerExitError(`Action worker failed to start: ${err.message}`));
      });
    });
  }

  private createWorkerProcess(options: {
    pooled: boolean;
    detached: boolean;
  }): ActionWorkerProcess {
    if (this.processRole !== "main" || !this.actionWorkerFork) {
      throw new Error("Only the main ActionEngine can fork action workers");
    }
    if (this.liveWorkers.size >= this.maxWorkerProcesses) {
      throw new ActionWorkerCapacityError(this.maxWorkerProcesses);
    }
    const child = this.actionWorkerFork(WORKER_ENTRY_PATH, {
      execArgv: process.execArgv,
      detached: options.detached,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: {
        ...process.env,
        ROME_ACTION_WORKER: "1",
      },
    });
    const worker: ActionWorkerProcess = {
      child,
      state: "starting",
      pooled: options.pooled,
      generation: this.workerPoolGeneration,
      retireAfterRun: false,
      useCount: 0,
      hasBeenReady: false,
      attached: false,
    };
    this.liveWorkers.add(worker);
    this.attachWorkerServices(worker);
    child.once("exit", () => {
      worker.sessionRpc?.dispose();
      this.warmWorkers.delete(worker);
      this.liveWorkers.delete(worker);
      if (worker.pooled && worker.hasBeenReady && this.workerWarmPoolStarted) {
        this.ensureWorkerWarmPool();
      }
    });
    return worker;
  }

  private attachWorkerServices(worker: ActionWorkerProcess): void {
    if (worker.attached) return;
    this.workerRpcServer?.attach(worker.child);
    const sessionRpc = this.agentSessionBridge?.attach(worker.child);
    if (sessionRpc) {
      worker.sessionRpc = sessionRpc;
    }
    worker.attached = true;
  }

  private finishWorkerRun(worker: ActionWorkerProcess, options: { reusable: boolean }): void {
    if (!options.reusable) {
      void this.stopWorker(worker);
      return;
    }

    worker.useCount++;
    if (!this.shouldReturnWorkerToPool(worker)) {
      void this.stopWorker(worker);
      return;
    }

    worker.state = "idle";
    this.warmWorkers.add(worker);
    this.ensureWorkerWarmPool();
  }

  private shouldReturnWorkerToPool(worker: ActionWorkerProcess): boolean {
    return (
      this.processRole === "main" &&
      this.workerWarmPoolStarted &&
      worker.pooled &&
      !worker.retireAfterRun &&
      worker.generation === this.workerPoolGeneration &&
      worker.useCount < this.workerMaxUses &&
      worker.child.connected &&
      worker.child.exitCode === null &&
      worker.child.signalCode === null
    );
  }

  private ensureWorkerWarmPool(): void {
    if (
      !this.workerWarmPoolStarted ||
      this.processRole !== "main" ||
      this.workerWarmPoolSize <= 0
    ) {
      return;
    }
    const liveCount = [...this.warmWorkers].filter(
      (worker) => worker.state !== "stopping" && worker.generation === this.workerPoolGeneration,
    ).length;
    for (let i = liveCount; i < this.workerWarmPoolSize; i++) {
      if (this.liveWorkers.size >= this.maxWorkerProcesses) break;
      const worker = this.createWorkerProcess({ pooled: true, detached: true });
      this.warmWorkers.add(worker);
      const markReady = (message: unknown) => {
        if (!isActionWorkerMessage(message) || message.type !== "ready") return;
        worker.child.off("message", markReady);
        if (worker.state === "starting") {
          worker.hasBeenReady = true;
          worker.state = "idle";
        }
      };
      worker.child.on("message", markReady);
    }
  }

  private async stopWorker(worker: ActionWorkerProcess): Promise<void> {
    if (worker.state === "stopping") return;
    worker.state = "stopping";
    this.warmWorkers.delete(worker);
    if (!worker.child.pid) {
      // A failed fork can emit an error without ever acquiring a pid (and in
      // that case may never emit the normal child `exit` event). Release its
      // capacity here so a startup failure cannot permanently exhaust the
      // instance-wide worker budget.
      this.liveWorkers.delete(worker);
      return;
    }
    await new Promise<void>((resolve) => {
      let timer: ClockTimer | null = null;
      const done = () => {
        if (timer) this.clock.clearTimeout(timer);
        resolve();
      };
      worker.child.once("exit", done);
      if (worker.child.connected) {
        worker.child.send({ type: "shutdown" } satisfies ActionWorkerShutdown, (err) => {
          if (err) this.sendCancelSignal(worker.child, "SIGTERM");
        });
      } else {
        this.sendCancelSignal(worker.child, "SIGTERM");
      }
      timer = this.clock.setTimeout(() => {
        if (worker.child.exitCode === null && worker.child.signalCode === null) {
          this.sendCancelSignal(worker.child, "SIGKILL");
        }
        resolve();
      }, CANCEL_SIGNAL_GRACE_MS);
    });
  }

  private resolveExecutionMode(action: Action, isRoot: boolean): "in_process" | "subprocess" {
    if (isRoot) {
      return this.processRole === "main" ? "subprocess" : "in_process";
    }
    return action.config.cancellable ? "subprocess" : "in_process";
  }

  private emitRuntimeEvent(
    observer: ActionRunObserver | undefined,
    event: ActionRuntimeEvent,
  ): void {
    if (!observer?.onRuntimeEvent) return;
    try {
      observer.onRuntimeEvent(event);
    } catch (err) {
      log.warn("runtime observer threw", {
        error: err instanceof Error ? err.message : String(err),
        eventType: event.type,
      });
    }
  }

  private emitActionInvocationEvent(
    observer: ActionInvocationObserver | undefined,
    event: ActionEvent,
  ): void {
    if (!observer?.onActionEvent) return;
    try {
      observer.onActionEvent(event);
    } catch (err) {
      log.warn("action invocation observer threw", {
        error: err instanceof Error ? err.message : String(err),
        eventType: event.type,
      });
    }
  }

  private async withTrace<T>(
    name: string,
    attrs: Record<string, string>,
    fn: (span?: Span) => Promise<T>,
  ): Promise<T> {
    const startMs = this.clock.now().getTime();
    const recordDuration = () => {
      actionDurationMetric().record(this.clock.now().getTime() - startMs, { "action.name": name });
    };

    if (!this.tracer) {
      try {
        return await fn();
      } finally {
        recordDuration();
      }
    }
    return this.tracer.startActiveSpan(
      `action:${name}`,
      { attributes: attrs },
      async (span: Span) => {
        const sessionId = currentSessionId();
        if (sessionId) span.setAttribute("session.id", sessionId);
        try {
          const result = await fn(span);
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (err) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err),
          });
          throw err;
        } finally {
          span.end();
          recordDuration();
        }
      },
    );
  }

  private async ensureExecutionStarted(data: {
    executionId: string;
    rootExecutionId: string;
    actionName: string;
    actionType?: string;
    args: Record<string, unknown>;
    initiator: string;
    actor?: SessionActor;
    parentId?: string;
    startedAt: Date;
  }): Promise<void> {
    if (!this.hasExecutionLifecycleSupport()) return;

    const repo = this.executionsRepo!;
    const existing = await repo.findById(data.executionId);
    if (existing) {
      await repo.update(data.executionId, {
        status: "running",
        error: null,
        durationMs: null,
        finishedAt: null,
        // An approval replay reuses the pending row but may be driven by a
        // different accountable session (the approver) — re-stamp it. A run
        // that resolved no actor keeps the last recorded one.
        ...(data.actor ? { actor: data.actor } : {}),
      });
      return;
    }

    await repo.create({
      id: data.executionId,
      rootExecutionId: data.rootExecutionId,
      actionName: data.actionName,
      actionType: data.actionType,
      status: "running",
      args: data.args,
      initiator: data.initiator,
      actor: data.actor,
      parentId: data.parentId,
      startedAt: data.startedAt,
      createdAt: data.startedAt,
    });
  }

  private async upsertExecutionRecord(data: {
    executionId: string;
    rootExecutionId: string;
    actionName: string;
    actionType?: string;
    status: ActionExecutionStatus;
    args: Record<string, unknown>;
    initiator: string;
    actor?: SessionActor;
    parentId?: string;
    error?: string;
  }): Promise<void> {
    if (!this.executionsRepo) return;

    if (!this.hasExecutionLifecycleSupport()) {
      await this.executionsRepo!.create({
        id: data.executionId,
        rootExecutionId: data.rootExecutionId,
        actionName: data.actionName,
        actionType: data.actionType,
        status: data.status,
        args: data.args,
        initiator: data.initiator,
        actor: data.actor,
        parentId: data.parentId,
        error: data.error,
      });
      return;
    }

    const repo = this.executionsRepo!;
    const existing = await repo.findById(data.executionId);
    if (existing) {
      await repo.update(data.executionId, {
        status: data.status,
        error: data.error ?? null,
        finishedAt: data.status === "pending_approval" ? null : this.clock.now(),
        // Same rule as ensureExecutionStarted: the row reflects the actor of
        // the run that most recently drove it.
        ...(data.actor ? { actor: data.actor } : {}),
      });
      return;
    }

    await repo.create({
      id: data.executionId,
      rootExecutionId: data.rootExecutionId,
      actionName: data.actionName,
      actionType: data.actionType,
      status: data.status,
      args: data.args,
      initiator: data.initiator,
      actor: data.actor,
      parentId: data.parentId,
      error: data.error,
      startedAt: this.clock.now(),
      createdAt: this.clock.now(),
      finishedAt: data.status === "pending_approval" ? undefined : this.clock.now(),
    });
  }

  private async recordExecutionCompletion(data: {
    executionId: string;
    rootExecutionId: string;
    actionName: string;
    actionType?: string;
    status: "success" | "error";
    args: Record<string, unknown>;
    error?: string;
    initiator: string;
    actor?: SessionActor;
    parentId?: string;
    startedAt: Date;
  }): Promise<void> {
    if (!this.executionsRepo) return;

    if (!this.hasExecutionLifecycleSupport()) {
      await this.executionsRepo!.create({
        id: data.executionId,
        rootExecutionId: data.rootExecutionId,
        actionName: data.actionName,
        actionType: data.actionType,
        status: data.status,
        args: data.args,
        error: data.error,
        durationMs: this.clock.now().getTime() - data.startedAt.getTime(),
        initiator: data.initiator,
        actor: data.actor,
        parentId: data.parentId,
      });
      return;
    }

    await this.executionsRepo!.update(data.executionId, {
      status: data.status,
      error: data.error ?? null,
      durationMs: this.clock.now().getTime() - data.startedAt.getTime(),
      finishedAt: this.clock.now(),
    });
  }

  private hasExecutionLifecycleSupport(): boolean {
    return (
      !!this.executionsRepo &&
      typeof (this.executionsRepo as { findById?: unknown }).findById === "function" &&
      typeof (this.executionsRepo as { update?: unknown }).update === "function"
    );
  }

  private hasExecutionCancelSupport(): boolean {
    return (
      !!this.executionsRepo &&
      typeof (this.executionsRepo as { markCancelRequested?: unknown }).markCancelRequested ===
        "function" &&
      typeof (this.executionsRepo as { markRootCancelled?: unknown }).markRootCancelled ===
        "function"
    );
  }

  private hasExecutionRootErrorSupport(): boolean {
    return (
      !!this.executionsRepo &&
      typeof (this.executionsRepo as { markRootErrored?: unknown }).markRootErrored ===
        "function" &&
      typeof (this.executionsRepo as { update?: unknown }).update === "function"
    );
  }

  private sendCancelSignal(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      try {
        process.kill(child.pid, signal);
      } catch {
        // Best-effort cancellation.
      }
    }
  }

  private async persistNewEntries(rootExecutionId: string, entries: JournalEntry[]): Promise<void> {
    if (!this.journalRepo || entries.length === 0) return;
    try {
      await this.journalRepo.saveJournal(rootExecutionId, entries);
    } catch (err) {
      log.error("failed to persist journal entries", {
        rootExecutionId,
        entryCount: entries.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async updateJournalEntry(
    rootExecutionId: string,
    sequence: number,
    result: ActionResult,
    status: string,
  ): Promise<void> {
    if (!this.journalRepo) return;
    try {
      await this.journalRepo.updateEntry(rootExecutionId, sequence, result, status);
    } catch (err) {
      log.error("failed to update journal entry", {
        rootExecutionId,
        sequence,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async recordPendingApproval(
    actionName: string,
    args: Record<string, unknown>,
    store: ReplayStore,
    context: ActionRunContext | undefined,
  ): Promise<PendingApproval> {
    const seq = store.nextSequence++;
    store.journal.push({
      sequence: seq,
      actionName,
      argsHash: hashArgs(args),
      args,
      result: null,
      status: "pending_approval",
    });

    const description = `Action "${actionName}" requires guardian approval`;
    const approvalId = await this.createApprovalRecord(
      actionName,
      args,
      description,
      store,
      context,
    );
    const ref: PendingApproval = { approvalId, actionName, description };
    // First pending approval in this run becomes the root-level signal. Later
    // pending approvals in the same turn still create their own records but
    // don't overwrite the root ref — tests and the agent runner only look at
    // the first one.
    if (!store.pendingApproval) {
      store.pendingApproval = ref;
    }
    return ref;
  }

  private async createApprovalRecord(
    actionName: string,
    args: Record<string, unknown>,
    description: string,
    store: ReplayStore,
    context: ActionRunContext | undefined,
  ): Promise<string> {
    if (!this.approvalsRepo) {
      return "no-approvals-repo";
    }
    const approvalId = await this.approvalsRepo.create({
      type: "action_execution",
      requestedBy: context?.initiator ?? "unknown",
      description,
      payload: {
        actionName,
        args,
        rootActionName: store.rootActionName,
        rootArgs: store.rootArgs,
        rootExecutionId: store.rootExecutionId,
        replayJournal: store.journal,
        channelContext: context?.channelContext,
        sharedContext: context?.sharedContext,
        sessionId: context?.sessionId,
        agentName: context?.agentName,
        channelThreadKey: context?.channelThreadKey,
      },
    });

    if (this.onApprovalCreated) {
      let preview: PreviewPayload | undefined;
      try {
        const action = this.registry.get(actionName);
        preview = await action?.preview?.(args);
      } catch (previewErr) {
        log.warn("action preview renderer threw", {
          actionName,
          error: previewErr instanceof Error ? previewErr.message : String(previewErr),
        });
      }

      try {
        await this.onApprovalCreated({
          approvalId,
          actionName,
          args,
          preview,
          channelContext: context?.channelContext,
        });
      } catch (callbackErr) {
        log.error("onApprovalCreated callback failed", {
          approvalId,
          error: callbackErr instanceof Error ? callbackErr.message : String(callbackErr),
        });
      }
    }

    return approvalId;
  }
}
