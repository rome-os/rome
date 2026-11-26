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
import {
  decidesApprovalPerCall,
  type Action,
  type ActionRegistry,
  type ActionResult,
  type PendingApproval,
  type PreviewPayload,
} from "./types.js";
import type {
  ActionExecutionStatus,
  ActionExecutionsRepository,
} from "../repositories/action-executions.js";
import type { ApprovalsRepository } from "../repositories/approvals.js";
import type { ExecutionJournalRepository } from "../repositories/execution-journal.js";
import { actionExecutionContext, type ActionExecutionStore } from "./context.js";
import {
  freshCallContext,
  replayContext,
  hashArgs,
  type JournalEntry,
  type ReplayStore,
} from "./replay.js";
import { createLogger } from "../../logger.js";
import { currentSessionId } from "../../telemetry-context.js";
import { sessionKeyChannel } from "../../core/agent-session-key.js";
import { artifactLocalName } from "../artifact-id.js";
import {
  fromWireError,
  isActionWorkerMessage,
  type ActionWorkerPayload,
  type ActionWorkerShutdown,
} from "./worker-protocol.js";
import { isMemoryShort, type MemoryHeadroomReader } from "../../instance/memory-headroom.js";
import {
  normalizeActionEvent,
  type ActionInvocationObserver,
  type ActionRunObserver,
  type ActionRuntimeEvent,
} from "./runtime-events.js";
import type { ThreadContext } from "../../core/types.js";
import type { WorkerRpcServer } from "./worker-rpc.js";
import { IpcRpc, createChildProcessTransport } from "./ipc.js";
import type { AgentSessionChildBridge } from "../../core/agent-session-bridge.js";
import { actionDurationMetric } from "../../telemetry.js";
import { systemClock, type Clock, type ClockTimer } from "../../lib/clock.js";
import {
  getCurrentHookInvocationContext,
  runWithHookInvocationContext,
  type HookInvocationContext,
} from "../../core/hook-recursion.js";
import {
  ActionCancelledError,
  ActionWorkerCapacityError,
  ActionWorkerExitError,
} from "./action-errors.js";
import {
  currentSessionActor,
  type SessionActor,
  withoutSessionActor,
} from "../../access/session-actor.js";
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
    const name = sessionKeyChannel(ctx.channelThreadKey);
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
    return resolve(distDir, "app-host", `worker-bootstrap${workerExtension}`);
  }

  return fileURLToPath(new URL(`../../app-host/worker-bootstrap${workerExtension}`, moduleUrl));
}

const WORKER_ENTRY_PATH = resolveActionWorkerEntryPath(import.meta.url);
const CANCEL_SIGNAL_GRACE_MS = 5_000;
const DEFAULT_WORKER_WARM_POOL_SIZE = 1;
const DEFAULT_WORKER_MAX_USES = 100;
const DEFAULT_QUEUED_ROOT_MAX_WAIT_MS = 10 * 60_000;
/** Worker slots a queued root may never take. They stay free for fail-fast
 * callers — agent tool calls, nested delegations, interactive turns — whose
 * caller often holds a worker of its own and cannot wait for one. */
const RESERVED_WORKER_SLOTS = 2;
/** How often a held queue re-reads memory. A queued root starts only while the
 * instance is not short on memory (see isMemoryShort), judged against a reading
 * taken just before it, so a started root stops the next start once its usage
 * shows and a finished root lets the next one go. Memory can recover without
 * any worker exiting, so the queue cannot rely on slot changes alone. Fail-fast
 * callers never see the gate: their caller may hold a worker and cannot wait. */
const QUEUE_MEMORY_RECHECK_MS = 5_000;
/** A reading that hovers at the line crosses it on many rechecks. The gate logs
 * a crossing at most this often, so a long hold costs two lines, not hundreds. */
const MEMORY_LOG_INTERVAL_MS = 60_000;
/** Coordination actions that main runs in-process instead of in a worker,
 * by canonical id so no other app's action of the same local name joins by
 * accident. Each is a short write to a main-owned service, so a worker added
 * a fork and an IPC hop and made a 50 ms call compete with hour-long jobs for
 * the capped budget (#830). An action joins the list only when, inside its own
 * async context, it starts no agent and calls or dispatches no action, and
 * when nothing it leaves behind (a timer, a listener, a client) would later
 * call one from that context. Work that leaves the context first, such as a
 * loopback HTTP request or a routine fire, is fine. */
const COORDINATION_ACTIONS: ReadonlySet<string> = new Set([
  "system:send_message",
  "system:send_user_message",
  "system:create_routine",
  "system:send_feedback",
  // Forwards to the main-owned event bus. A worker only proxied the same
  // publish back to main, after a multi-second fork, while the caller (often
  // an app API handler) waited (#2144). Routines it fires run as their own
  // roots, outside this action's context.
  "system:publish_event",
  "core:set_agent_name",
  "core:show_file",
  // Reads of the personal-data store (personal-data/actions.ts).
  "core:personal_data_catalog",
  "core:personal_data_query",
  // The mail actions (connections/gmail, connections/outlook). Only main holds
  // the mail credentials.
  "core:gmail_read",
  "core:gmail_send",
  "core:outlook_read",
  "core:outlook_send",
  // The device actions (connections/device/actions.ts). The node client that
  // calls a device lives in main.
  "core:device_describe",
  "core:device_run",
  "core:app_connection_read",
  "core:app_connection_write",
  "core:app_connection_write_without_approval",
  "core:request_connection_access",
  // What the Concierge follows (concierge/following.ts). The event action
  // queues an event; its delivery timer starts the Concierge's turn outside
  // the action's context. `follow` subscribes at the source through connector
  // actions, also called outside the action's context.
  "core:concierge_follow_event",
  "core:concierge_digest",
  "core:concierge_follow",
  "core:concierge_unfollow",
  "core:concierge_following_list",
  "core:concierge_following_configure",
  // A task's scheduled run (concierge/task-schedule.ts). It sends the task's
  // brief through the Concierge, which only the main process holds.
  "core:concierge_task_run",
]);

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
  /** On an approval replay, the journal sequence of the pending entry the
   *  approved card owns. Only that entry executes under the replay. */
  approvedSequence?: number;
  /** Set by the engine on a call that executes for real during an approval
   *  replay, so a worker that runs it also keeps its nested calls out of the
   *  journal (see `freshCallContext`). */
  freshCall?: boolean;
  /** Session info for agent-level resumption on approval */
  sessionId?: string;
  agentName?: string;
  channelThreadKey?: string;
  /** Allocated by the session when it starts the turn; stamped on `action:*` spans so the
   *  trace UI can group every action invocation that happened within one
   *  turn under the originating `agent:*`. */
  turnId?: string;
  /** What a root run does when it needs a new action worker and none is free.
   * `"fail"` (the default) throws {@link ActionWorkerCapacityError} at once.
   * `"queue"` waits in FIFO order for a slot, then throws that error if none
   * opens within the engine's queue deadline. Queue only from a caller that
   * holds no action worker and waits on no caller that does — a routine fire,
   * an external app API request, a detached dispatch. A missing execution
   * store does not prove that, since worker ingress clears it. A worker-held
   * caller that queues can wait on its own slot. Read on the root only and
   * never inherited by nested calls, which always fail fast. */
  whenWorkersBusy?: "fail" | "queue";
  /**
   * Argument names whose values the execution record leaves out, keeping
   * only their size: a routine's trigger payload, an event passed on. Read
   * on the root only and never inherited by nested calls. The action itself
   * still gets every argument.
   */
  omitFromRecord?: readonly string[];
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

export interface InterruptedAction {
  actionName: string;
  executionId: string;
  rootExecutionId: string;
}

/** Where the engine records executions, approvals, and replay journals. */
export interface ActionEngineRepositories {
  executions: ActionExecutionsRepository;
  approvals: ApprovalsRepository;
  journal: ExecutionJournalRepository;
}

interface ActionEngineOptions {
  tracer?: Tracer;
  processRole?: "main" | "worker";
  /**
   * Hard cap for every live action-worker process owned by main, including
   * warm, root, and delegated workers. Capacity exhaustion fails immediately
   * unless the root run opted into `whenWorkersBusy: "queue"`: waiting for
   * capacity inside a nested action would retain its ancestors and can
   * deadlock a chain such as A -> B -> C -> D.
   */
  maxWorkerProcesses?: number;
  /** How long a queued root waits for a worker before it fails with
   * {@link ActionWorkerCapacityError}. Defaults to ten minutes. */
  queuedRootMaxWaitMs?: number;
  /** Reads the instance's memory headroom when a queued root could take a
   * worker. The default reads nothing, so an engine built without it never
   * holds the queue; the production wiring passes `readMemoryHeadroom`, which
   * reads the cgroup limit, then Linux's `/proc/meminfo`. Tests inject a
   * controllable reading. */
  memoryHeadroom?: MemoryHeadroomReader;
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
  /** Main-only recovery for effects that outlive a lost worker. A returned result prevents automatic exception retries. */
  onWorkerInterrupted?: (
    invocation: InterruptedAction,
    error: Error,
  ) => Promise<ActionResult | undefined>;
  /** Main-only process factory. Worker engines intentionally receive none. */
  actionWorkerFork?: (entryPath: string, options: ForkOptions) => ChildProcess;
  /** Main-only trust check: true when the named action is owned by core or by
   * an app installed as first-party. A root coordination action (see
   * COORDINATION_ACTIONS) that passes it runs in main instead of taking a
   * worker. Trust never comes from the action's own manifest. Absent, every
   * root takes a worker as before. */
  isFirstPartyAction?: (actionName: string) => boolean;
  /** Main-only: actions core registers in main alone, such as its agent tools
   *  (agent-tool.ts). Each runs as a root in main while the registry says core
   *  owns it, whatever any app's first-party flag says. */
  mainActions?: ReadonlySet<string>;
}

/** The arguments as an execution record keeps them, without the values a root run omits. */
export function recordedArgs(
  args: Record<string, unknown>,
  context: ActionRunContext | undefined,
  isRoot: boolean,
): Record<string, unknown> {
  const omit = isRoot ? context?.omitFromRecord : undefined;
  if (!omit?.length) return args;
  const out = { ...args };
  for (const key of omit) {
    if (!(key in out)) continue;
    out[key] = { omitted: true, bytes: JSON.stringify(out[key] ?? null)?.length ?? 0 };
  }
  return out;
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

/** Whether a process with `pid` exists. A zombie still counts, and so does a
 * reused pid. */
function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
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

interface QueuedRoot {
  rootExecutionId: string;
  queuedAt: number;
  /** Set once the memory gate holds this root, so a timeout names the reason
   * this root waited rather than the gate's state at the deadline. */
  heldByMemory: boolean;
  deadline: ClockTimer;
  admit: (worker: ActionWorkerProcess) => void;
  reject: (error: Error) => void;
}

type ActionWorkerState = "starting" | "idle" | "running" | "stopping";

interface ActionWorkerProcess {
  child: ChildProcess;
  state: ActionWorkerState;
  pooled: boolean;
  generation: number;
  retireAfterRun: boolean;
  cancelRequested?: boolean;
  useCount: number;
  hasBeenReady: boolean;
  attached: boolean;
  /** Clock time of the fork, in epoch milliseconds. */
  forkedAt: number;
  rpc?: IpcRpc;
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
  private executionsRepo: ActionExecutionsRepository;
  private approvalsRepo: ApprovalsRepository;
  private journalRepo: ExecutionJournalRepository;
  private activeRootProcesses = new Map<string, ActiveRootProcess>();
  private processRole: "main" | "worker";
  private workerRpcServer: WorkerRpcServer | null = null;
  private agentSessionBridge: AgentSessionChildBridge | null = null;
  private actionWorkerCoordinator: ActionWorkerCoordinator | null = null;
  private actionSubprocessRunner: ActionSubprocessRunner | null;
  private actionWorkerFork: ActionEngineOptions["actionWorkerFork"];
  private isFirstPartyAction: ActionEngineOptions["isFirstPartyAction"];
  private mainActions: ReadonlySet<string>;
  private onWorkerInterrupted: ActionEngineOptions["onWorkerInterrupted"];
  private onApprovalCreated: ActionEngineOptions["onApprovalCreated"];
  private clock: Clock;
  private workerWarmPoolSize: number;
  private workerMaxUses: number;
  private maxWorkerProcesses: number;
  private queuedRootMaxWaitMs: number;
  private queuedRoots: QueuedRoot[] = [];
  private memoryHeadroom: MemoryHeadroomReader;
  /** Whether the last reading was short. Steers the log lines only, so a long
   * hold logs its start and its end rather than every recheck. */
  private memoryShort = false;
  /** When the gate last logged a crossing of the line. */
  private memoryLoggedAt: number | null = null;
  private queueRecheckTimer: ClockTimer | null = null;
  private workerWarmPoolStarted = false;
  private workerPoolGeneration = 0;
  private warmWorkers = new Set<ActionWorkerProcess>();
  private liveWorkers = new Set<ActionWorkerProcess>();

  constructor(
    private registry: ActionRegistry,
    repos: ActionEngineRepositories,
    options?: ActionEngineOptions,
  ) {
    this.tracer = options?.tracer ?? null;
    this.executionsRepo = repos.executions;
    this.approvalsRepo = repos.approvals;
    this.journalRepo = repos.journal;
    this.processRole = options?.processRole ?? "worker";
    this.onApprovalCreated = options?.onApprovalCreated;
    this.onWorkerInterrupted = options?.onWorkerInterrupted;
    this.clock = options?.clock ?? systemClock;
    this.actionSubprocessRunner = options?.actionSubprocessRunner ?? null;
    this.actionWorkerFork = options?.actionWorkerFork;
    this.isFirstPartyAction = options?.isFirstPartyAction;
    this.mainActions = options?.mainActions ?? new Set();
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
    this.queuedRootMaxWaitMs = options?.queuedRootMaxWaitMs ?? DEFAULT_QUEUED_ROOT_MAX_WAIT_MS;
    this.memoryHeadroom = options?.memoryHeadroom ?? (() => null);
    if (this.processRole === "main") {
      // One line at boot says which reading the gate will trust, so a wrong
      // source on a new kind of host shows up without waiting for a hold.
      const sample = this.memoryHeadroom();
      log.info("memory gate reading", {
        source: sample?.source ?? "none",
        limitMB: sample ? Math.round(sample.limitBytes / 1_048_576) : null,
        availableMB: sample ? Math.round(sample.availableBytes / 1_048_576) : null,
      });
    }
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
    const store = replayContext.getStore();
    if (store?.coordinationRoot) {
      throw new Error(
        `Action "${store.rootActionName}" runs in the main process as a coordination action and may not dispatch other actions (it dispatched "${action.config.name}")`,
      );
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
    const queued = this.queuedRoots.find((entry) => entry.rootExecutionId === rootExecutionId);
    if (queued) {
      this.removeQueuedRoot(queued);
      queued.reject(new ActionCancelledError("Cancelled by user"));
      return true;
    }

    const active = this.activeRootProcesses.get(rootExecutionId);
    if (!active?.worker.child.pid) {
      return false;
    }

    await this.executionsRepo.markCancelRequested(rootExecutionId);

    active.worker.cancelRequested = true;
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
    if (!actor && isReplay && context?.replayRootExecutionId) {
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
    // A nested call that another worker runs as a root keeps its own journal.
    // Its rows numbered from 0 would otherwise collide with its tree root's.
    const journalId = parentId && rootExecutionId !== executionId ? executionId : rootExecutionId;

    const replayStore: ReplayStore = {
      rootExecutionId,
      journalId,
      rootActionName: action.config.name,
      rootArgs: args,
      journal: [],
      nextSequence: 0,
      replayIndex: 0,
      mode: isReplay ? "replay" : "record",
      coordinationRoot: this.processRole === "main" && this.runsRootInMain(action),
    };

    let preloadedEntryCount = 0;
    let approvedRootResume = false;
    if (context?.replayJournal) {
      replayStore.journal = [...context.replayJournal];
      preloadedEntryCount = replayStore.journal.length;
      replayStore.preloadedEntryCount = preloadedEntryCount;
      replayStore.approvedSequence = context.approvedSequence;
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
    let approval: CallApproval = { asks: false };
    if (replayStore.mode === "record" && !approvedRootResume) {
      try {
        approval = await this.approvalOf(action, args, replayStore, context);
      } catch (err) {
        return { status: "error", error: approvalFailure(action.config.name, err) };
      }
    }
    if (approval.asks) {
      const card = approval;
      const pending = await this.withTrace(
        action.config.name,
        buildRomeSpanAttrs(context),
        async (span) => {
          const ref = await this.recordPendingApproval(
            action.config.name,
            args,
            replayStore,
            context,
            card,
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
        await this.persistNewEntries(replayStore.journalId, newApprovalEntries);
      }
      await this.upsertExecutionRecord({
        executionId,
        rootExecutionId,
        actionName: action.config.name,
        actionType: action.config.type,
        status: "pending_approval",
        args: recordedArgs(args, context, true),
        initiator,
        actor,
        parentId,
        error: undefined,
      });
      onRootAccepted?.();
      return { status: "pending_approval", approval: pending };
    }

    // For the `system:summon` action, stamp the child agent name as an attribute
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
    const runBody = () =>
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
      );
    // A worker running a call that executes during a replay keeps its nested
    // calls out of the journal, as the in-process path does.
    const result = await this.withTrace(action.config.name, spanAttrs, () =>
      context?.freshCall ? freshCallContext.run(replayStore, runBody) : runBody(),
    );

    if (approvedRootResume) {
      const entry = replayStore.journal[0];
      if (entry && entry.status === "pending_approval") {
        entry.result = result;
        entry.status = "completed";
        await this.updateJournalEntry(replayStore.journalId, entry.sequence, result, "completed");
      }
    }

    const newEntries = replayStore.journal.slice(preloadedEntryCount);
    if (newEntries.length > 0) {
      await this.persistNewEntries(replayStore.journalId, newEntries);
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
    if (store.coordinationRoot) {
      throw new Error(
        `Action "${store.rootActionName}" runs in the main process as a coordination action and may not call other actions (it called "${action.config.name}")`,
      );
    }
    const argsHash = hashArgs(args);
    const run = { action, args, store, context, observer, actionEventObserver };
    if (freshCallContext.getStore() === store) return this.runUnjournaledCall(run);

    if (store.mode === "replay") {
      const entry = store.journal[store.replayIndex];

      if (entry && entry.actionName === action.config.name && entry.argsHash === argsHash) {
        // Every matched branch takes its slot before its first await, so
        // concurrent calls (Promise.all) take consecutive entries.
        if (entry.status === "completed" && entry.result !== null) {
          this.advanceReplayIndex(store);
          if (await this.canReuseEntry(entry, store)) {
            log.info("replay: returning cached result", {
              action: action.config.name,
              sequence: entry.sequence,
            });
            return entry.result;
          }
          log.info("replay: rerunning a call recorded after the approved one", {
            action: action.config.name,
            sequence: entry.sequence,
          });
          return this.runFreshCall(run, entry);
        }

        if (entry.status === "pending_approval") {
          this.advanceReplayIndex(store);
          if (entry.sequence !== store.approvedSequence) {
            return this.parkOnEntryCard(entry, store);
          }
          log.info("replay: executing previously pending action", {
            action: action.config.name,
            sequence: entry.sequence,
          });
          return this.executeIntoEntry(run, entry);
        }

        if (entry.status === "diverged") {
          this.advanceReplayIndex(store);
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

        store.mode = "record";
      }
    }

    return this.runFreshCall(run);
  }

  /** A call made by a call that executes during a replay. Later replays serve
   *  that parent from its cached row and never reach this call, so it gets no
   *  row: one would sit in the sibling replay order, and a card for it could
   *  never run. A call that needs approval is refused for the same reason. */
  private async runUnjournaledCall(run: NestedRun): Promise<ActionResult> {
    const name = run.action.config.name;
    let approval: CallApproval;
    try {
      approval = await this.approvalOf(run.action, run.args, run.store, run.context);
    } catch (err) {
      return { status: "error", error: approvalFailure(name, err) };
    }
    if (approval.asks) {
      return {
        status: "error",
        error: `Action "${name}" needs approval, but its caller is already running under an approval`,
      };
    }
    return this.executeNestedInvocation(
      run.action,
      run.args,
      run.store,
      { ...run.context, freshCall: true },
      run.observer,
      run.actionEventObserver,
      false,
    );
  }

  private advanceReplayIndex(store: ReplayStore): void {
    store.replayIndex++;
    if (store.replayIndex >= (store.preloadedEntryCount ?? store.journal.length)) {
      store.mode = "record";
    }
  }

  /** Entries up to the approved one are exactly-once history. A later entry
   *  ran before the approval, so its result may be stale, unless an approval
   *  card owns it: rerunning that would repeat an approved effect. */
  private async canReuseEntry(entry: JournalEntry, store: ReplayStore): Promise<boolean> {
    if (store.approvedSequence === undefined || entry.sequence <= store.approvedSequence) {
      return true;
    }
    const card = await this.approvalsRepo.findCardForEntry(
      store.journalId,
      entry.sequence,
      entry.actionName,
    );
    return card !== null;
  }

  /** A pending entry the approved card does not own stays unauthorized: the
   *  call waits on the entry's own card, or is refused when no live card is left. */
  private async parkOnEntryCard(entry: JournalEntry, store: ReplayStore): Promise<ActionResult> {
    const card = await this.approvalsRepo.findCardForEntry(
      store.journalId,
      entry.sequence,
      entry.actionName,
      true,
    );
    if (!card) return { status: "error", error: `Action "${entry.actionName}" was not approved` };
    const approval: PendingApproval = {
      approvalId: card.id,
      actionName: entry.actionName,
      description: `Action "${entry.actionName}" requires guardian approval`,
    };
    store.pendingApproval ??= approval;
    return { status: "pending_approval", approval };
  }

  /** Ask for approval if needed, then run the call. With `entry`, the call
   *  reuses that journal row instead of appending a new one. */
  private async runFreshCall(run: NestedRun, entry?: JournalEntry): Promise<ActionResult> {
    const { action, args, store, context } = run;
    let approval: CallApproval;
    try {
      approval = await this.approvalOf(action, args, store, context);
    } catch (err) {
      return { status: "error", error: approvalFailure(action.config.name, err) };
    }
    if (approval.asks) {
      const pending = await this.recordPendingApproval(
        action.config.name,
        args,
        store,
        context,
        approval,
        entry,
      );
      return { status: "pending_approval", approval: pending };
    }
    if (entry) return this.executeIntoEntry(run, entry);
    return this.executeNestedInvocation(
      action,
      args,
      store,
      context,
      run.observer,
      run.actionEventObserver,
    );
  }

  private async executeIntoEntry(run: NestedRun, entry: JournalEntry): Promise<ActionResult> {
    const result = await freshCallContext.run(run.store, () =>
      this.executeNestedInvocation(
        run.action,
        run.args,
        run.store,
        { ...run.context, freshCall: true },
        run.observer,
        run.actionEventObserver,
        false,
      ),
    );
    entry.result = result;
    entry.status = "completed";
    await this.updateJournalEntry(run.store.journalId, entry.sequence, result, "completed");
    return result;
  }

  private async executeNestedInvocation(
    action: Action,
    args: Record<string, unknown>,
    store: ReplayStore,
    context?: ActionRunContext,
    observer?: ActionRunObserver,
    actionEventObserver?: ActionInvocationObserver,
    appendToJournal = true,
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

    if (appendToJournal) {
      store.journal.push({
        sequence: store.nextSequence++,
        actionName: action.config.name,
        argsHash: hashArgs(args),
        args,
        result,
        status: "completed",
      });
    }

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
      args: recordedArgs(args, invocation.context, isRoot),
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
          args: recordedArgs(args, invocation.context, isRoot),
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
          args: recordedArgs(args, invocation.context, isRoot),
          error: result.status === "error" ? result.error : undefined,
          initiator,
          actor,
          parentId,
          startedAt,
        });
      }
      return result;
    } catch (err) {
      const recovered = await this.recoverWorkerInterruption(
        { actionName: name, executionId, rootExecutionId },
        err,
      );
      const failureMessage =
        recovered?.status === "error"
          ? recovered.error
          : err instanceof Error
            ? err.message
            : String(err);
      try {
        if (err instanceof ActionCancelledError) {
          await this.executionsRepo.markRootCancelled(
            rootExecutionId,
            this.clock.now(),
            err.message,
          );
        } else if (isRoot && mode === "subprocess") {
          await this.executionsRepo.markRootErrored(
            rootExecutionId,
            this.clock.now(),
            failureMessage,
          );
          await this.executionsRepo.update(executionId, {
            durationMs: this.clock.now().getTime() - startedAt.getTime(),
          });
        } else {
          await this.recordExecutionCompletion({
            executionId,
            rootExecutionId,
            actionName: name,
            actionType: action.config.type,
            status: "error",
            args: recordedArgs(args, invocation.context, isRoot),
            error: failureMessage,
            initiator,
            actor,
            parentId,
            startedAt,
          });
        }
      } catch (persistenceError) {
        if (!recovered) throw persistenceError;
        // Losing the execution log must not turn an uncertain external effect into a retry.
        log.error("failed to persist interrupted action", {
          executionId,
          error: String(persistenceError),
        });
      }
      if (recovered) return recovered;
      throw err;
    }
  }

  private async recoverWorkerInterruption(
    invocation: InterruptedAction,
    error: unknown,
  ): Promise<ActionResult | undefined> {
    if (
      this.processRole !== "main" ||
      !(error instanceof Error) ||
      error.name !== "ActionWorkerExitError"
    ) {
      return undefined;
    }
    return this.onWorkerInterrupted?.(invocation, error);
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

    if (invocation.isRoot && invocation.context?.whenWorkersBusy === "queue") {
      // Accepted on joining the queue, so a detached dispatcher, which may be a
      // worker, never waits on capacity.
      onRootAccepted?.();
      const worker = await this.waitForRootWorker(invocation.rootExecutionId);
      return await this.runPayloadOnWorker(
        worker,
        invocation,
        payload,
        observer,
        actionEventObserver,
      );
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
    )
      .catch(async (error: unknown) => {
        const recovered = await this.recoverWorkerInterruption(
          { actionName: payload.actionName, executionId, rootExecutionId },
          error,
        );
        if (recovered) return recovered;
        throw error;
      })
      .finally(() => {
        if (cancelTimer) this.clock.clearTimeout(cancelTimer);
      });

    return {
      result,
      cancel: () => {
        worker.cancelRequested = true;
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
    // A detached caller waits only for acceptance, so its root can always queue.
    const context: ActionRunContext = { ...payload.context, whenWorkersBusy: "queue" };
    const run = replayContext.exit(() =>
      actionExecutionContext.exit(() =>
        this.run(payload.actionName, payload.args, context, undefined, undefined, () => {
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

  /** Resolves with a running worker for a queued root, in FIFO order with
   * every other queued root. Rejects with ActionWorkerCapacityError after
   * `queuedRootMaxWaitMs`, or with ActionCancelledError when `cancel()` names
   * the root first. */
  private waitForRootWorker(rootExecutionId: string): Promise<ActionWorkerProcess> {
    if (
      this.queuedRoots.length === 0 &&
      this.canAdmitQueuedRoot() &&
      this.memoryAllowsAdmission()
    ) {
      return Promise.resolve(this.checkoutWorker(true));
    }
    return new Promise<ActionWorkerProcess>((resolve, reject) => {
      const queuedAt = this.clock.now().getTime();
      const entry: QueuedRoot = {
        rootExecutionId,
        queuedAt,
        heldByMemory: false,
        deadline: this.clock.setTimeout(() => {
          this.removeQueuedRoot(entry);
          const waitedMs = this.clock.now().getTime() - queuedAt;
          log.warn("queued root timed out waiting for an action worker", {
            rootExecutionId,
            waitedMs,
            workers: this.describeLiveWorkers(),
          });
          reject(
            new ActionWorkerCapacityError(
              this.maxWorkerProcesses,
              waitedMs,
              entry.heldByMemory ? "memory" : "workers",
            ),
          );
        }, this.queuedRootMaxWaitMs),
        admit: resolve,
        reject,
      };
      this.queuedRoots.push(entry);
      // A free slot with a waiting root means memory is what holds it.
      if (this.canAdmitQueuedRoot()) {
        entry.heldByMemory = true;
        this.scheduleQueueRecheck();
      }
      log.info("root queued for an action worker", {
        rootExecutionId,
        queueDepth: this.queuedRoots.length,
        liveWorkers: this.liveWorkers.size,
        heldBy: entry.heldByMemory ? "memory" : "workers",
      });
    });
  }

  /** Whether the instance has the memory to start another queued root. Reads
   * headroom live, so the answer tracks work that grows or frees memory
   * without any worker exiting. An unreadable sample never holds the queue. */
  private memoryAllowsAdmission(): boolean {
    const sample = this.memoryHeadroom();
    if (!sample || !(sample.limitBytes > 0)) return true;
    const short = isMemoryShort(sample);
    if (short !== this.memoryShort) {
      this.memoryShort = short;
      const now = this.clock.now().getTime();
      if (this.memoryLoggedAt === null || now - this.memoryLoggedAt >= MEMORY_LOG_INTERVAL_MS) {
        this.memoryLoggedAt = now;
        const fields = {
          availableMB: Math.round(sample.availableBytes / 1_048_576),
          limitMB: Math.round(sample.limitBytes / 1_048_576),
          source: sample.source,
          queueDepth: this.queuedRoots.length,
          liveWorkers: this.liveWorkers.size,
        };
        if (short) log.warn("instance short on memory; holding queued roots", fields);
        else log.info("memory recovered; queued roots resume", fields);
      }
    }
    return !short;
  }

  /** Re-runs admission after QUEUE_MEMORY_RECHECK_MS. One timer at a time. */
  private scheduleQueueRecheck(): void {
    if (this.queueRecheckTimer) return;
    this.queueRecheckTimer = this.clock.setTimeout(() => {
      this.queueRecheckTimer = null;
      this.admitQueuedRoots();
    }, QUEUE_MEMORY_RECHECK_MS);
  }

  /** Whether a queued root may take a worker now. Queued roots stop short of
   * the last RESERVED_WORKER_SLOTS: fail-fast callers keep those, because a
   * backlog that filled every slot would fail each agent tool call and
   * interactive turn until it drained. Idle and starting warm workers are
   * spare capacity, not committed work, so they do not count as busy. */
  private canAdmitQueuedRoot(): boolean {
    const reserved = Math.min(RESERVED_WORKER_SLOTS, this.maxWorkerProcesses - 1);
    const busy = this.liveWorkers.size - this.warmWorkers.size;
    if (busy >= this.maxWorkerProcesses - reserved) return false;
    if (this.liveWorkers.size < this.maxWorkerProcesses) return true;
    return [...this.warmWorkers].some(
      (worker) =>
        worker.state === "idle" &&
        worker.generation === this.workerPoolGeneration &&
        worker.child.connected,
    );
  }

  /** Hands freed capacity to queued roots. Called wherever a slot opens: a
   * worker exits, a worker returns to the warm pool, or a warm worker becomes
   * ready. Runs before the warm pool refills, so a queued root outranks a new
   * idle worker. A slot alone is not enough: the memory gate must also allow
   * the start, and it is asked again for every root. */
  private admitQueuedRoots(): void {
    while (this.queuedRoots.length > 0 && this.canAdmitQueuedRoot()) {
      if (!this.memoryAllowsAdmission()) {
        for (const waiting of this.queuedRoots) waiting.heldByMemory = true;
        this.scheduleQueueRecheck();
        return;
      }
      const entry = this.queuedRoots.shift()!;
      this.clock.clearTimeout(entry.deadline);
      let worker: ActionWorkerProcess;
      try {
        worker = this.checkoutWorker(true);
      } catch (err) {
        entry.reject(err instanceof Error ? err : new Error(String(err)));
        continue;
      }
      log.info("queued root admitted to an action worker", {
        rootExecutionId: entry.rootExecutionId,
        waitedMs: this.clock.now().getTime() - entry.queuedAt,
        queueDepth: this.queuedRoots.length,
      });
      entry.admit(worker);
    }
    if (this.queuedRoots.length === 0 && this.queueRecheckTimer) {
      this.clock.clearTimeout(this.queueRecheckTimer);
      this.queueRecheckTimer = null;
    }
  }

  private removeQueuedRoot(entry: QueuedRoot): void {
    this.clock.clearTimeout(entry.deadline);
    const index = this.queuedRoots.indexOf(entry);
    if (index !== -1) this.queuedRoots.splice(index, 1);
  }

  private runPayloadOnWorker(
    worker: ActionWorkerProcess,
    invocation: Pick<ExecutionInvocation, "executionId" | "rootExecutionId" | "isRoot">,
    payload: ActionWorkerPayload,
    observer?: ActionRunObserver,
    actionEventObserver?: ActionInvocationObserver,
  ): Promise<ActionResult> {
    worker.cancelRequested = false;
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
          reject(fromWireError(message.error));
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
        if (worker.cancelRequested && (signal || code === 130 || code === 143)) {
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
      log.warn("action worker capacity reached", {
        maxWorkers: this.maxWorkerProcesses,
        workers: this.describeLiveWorkers(),
      });
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
      forkedAt: this.clock.now().getTime(),
    };
    this.liveWorkers.add(worker);
    this.attachWorkerServices(worker);
    child.once("exit", () => {
      worker.rpc?.dispose();
      this.warmWorkers.delete(worker);
      this.liveWorkers.delete(worker);
      this.admitQueuedRoots();
      if (worker.pooled && worker.hasBeenReady && this.workerWarmPoolStarted) {
        this.ensureWorkerWarmPool();
      }
    });
    // A fork that fails to spawn (EAGAIN, EMFILE) emits `error` without a pid
    // and never emits `exit`. No run listens on a warm worker, so without this
    // listener that `error` is an uncaught exception that stops main.
    child.on("error", (err) => {
      log.warn("action worker process error", {
        pid: child.pid ?? null,
        error: err.message,
      });
      if (!child.pid) void this.stopWorker(worker);
    });
    return worker;
  }

  /** One entry per worker that holds a slot, logged when the cap turns work
   * away. A pid with `alive: false` marks a slot whose process is gone but
   * whose `exit` listener never released it. */
  private describeLiveWorkers() {
    const rootByWorker = new Map<ActionWorkerProcess, string>();
    for (const [rootExecutionId, active] of this.activeRootProcesses) {
      rootByWorker.set(active.worker, rootExecutionId);
    }
    const now = this.clock.now().getTime();
    return [...this.liveWorkers].map((worker) => ({
      pid: worker.child.pid ?? null,
      alive: isProcessAlive(worker.child.pid),
      state: worker.state,
      pooled: worker.pooled,
      generation: worker.generation,
      useCount: worker.useCount,
      ageMs: now - worker.forkedAt,
      connected: worker.child.connected,
      rootExecutionId: rootByWorker.get(worker) ?? null,
    }));
  }

  private attachWorkerServices(worker: ActionWorkerProcess): void {
    if (worker.attached) return;
    // A pooled ChildProcess keeps the async resource created by fork(). If
    // that fork happened while an action replay/execution context was active,
    // every later `message` callback on the reused worker re-enters that old
    // context. Worker IPC is an independent ingress boundary, so never let a
    // creator action's ALS state, or the person whose request or message it
    // served, leak into a main-process service call.
    // IpcRpc resets the OpenTelemetry context the same way and restores the
    // calling worker's span from the request's traceCarrier.
    const rpc = new IpcRpc(createChildProcessTransport(worker.child), "main", {
      runInbound: async (callback) =>
        await replayContext.exit(() =>
          actionExecutionContext.exit(() => withoutSessionActor(callback)),
        ),
    });
    this.workerRpcServer?.register(rpc);
    this.agentSessionBridge?.attach(rpc, worker.child);
    worker.rpc = rpc;
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
    this.admitQueuedRoots();
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
          this.admitQueuedRoots();
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
      this.admitQueuedRoots();
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
      if (this.processRole !== "main") return "in_process";
      // Decided once, when the root's replay store was built, so the nested-
      // call guard and the placement can never disagree.
      return replayContext.getStore()?.coordinationRoot ? "in_process" : "subprocess";
    }
    return action.config.cancellable ? "subprocess" : "in_process";
  }

  /** Whether a root runs in main: a core-owned main action, or a first-party
   * coordination action, that is not cancellable. Cancellable actions keep their worker so process-level
   * termination stays available. A failing or absent trust check means a
   * worker, as before. */
  private runsRootInMain(action: Action): boolean {
    if (action.config.cancellable) return false;
    const name = action.config.name;
    // Core registers its own tools in main alone, so no app's trust decides
    // where they run, and an app action of the same name is never placed here.
    if (this.mainActions.has(name) && this.registry.getMetadata?.(name)?.ownerType === "core") {
      return true;
    }
    if (!COORDINATION_ACTIONS.has(name) && !this.mainActions.has(name)) return false;
    if (!this.isFirstPartyAction) return false;
    try {
      return this.isFirstPartyAction(action.config.name);
    } catch (err) {
      log.warn("first-party action check failed; using a worker", {
        action: action.config.name,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
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
    const repo = this.executionsRepo;

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
    const repo = this.executionsRepo;

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
    await this.executionsRepo.update(data.executionId, {
      status: data.status,
      error: data.error ?? null,
      durationMs: this.clock.now().getTime() - data.startedAt.getTime(),
      finishedAt: this.clock.now(),
    });
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
    if (entries.length === 0) return;
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
    result: ActionResult | null,
    status: string,
  ): Promise<void> {
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

  /** Whether this call of `action` waits for the guardian, and the card it
   *  waits on. An action that decides per call (`decidesApprovalPerCall`)
   *  waits only when its preview words a card, and a preview of one that
   *  throws, refusal of the turn included, throws here, so the call does not
   *  run. */
  private async approvalOf(
    action: Action,
    args: Record<string, unknown>,
    store: ReplayStore,
    context: ActionRunContext | undefined,
  ): Promise<CallApproval> {
    if (!action.config.requiresApproval) return { asks: false };
    if (!decidesApprovalPerCall(action)) return { asks: true };
    const preview = await this.renderPreview(action.config.name, args, store, context);
    return preview ? { asks: true, preview } : { asks: false };
  }

  private async recordPendingApproval(
    actionName: string,
    args: Record<string, unknown>,
    store: ReplayStore,
    context: ActionRunContext | undefined,
    approval: CallApproval & { asks: true },
    entry?: JournalEntry,
  ): Promise<PendingApproval> {
    let seq: number;
    if (entry) {
      entry.result = null;
      entry.status = "pending_approval";
      await this.updateJournalEntry(store.journalId, entry.sequence, null, "pending_approval");
      seq = entry.sequence;
    } else {
      seq = store.nextSequence++;
      store.journal.push({
        sequence: seq,
        actionName,
        argsHash: hashArgs(args),
        args,
        result: null,
        status: "pending_approval",
      });
    }

    const description = `Action "${actionName}" requires guardian approval`;
    const approvalId = await this.createApprovalRecord(
      actionName,
      args,
      seq,
      description,
      store,
      context,
      approval,
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
    journalSequence: number,
    description: string,
    store: ReplayStore,
    context: ActionRunContext | undefined,
    approval: CallApproval & { asks: true },
  ): Promise<string> {
    // The preview and the replay both run as the turn that asked: without
    // them a chatless turn reads as outside any turn (app-host chat-calls). A
    // nested call's own context names no turn, so the caller's is read.
    const caller = actionExecutionContext.getStore();
    const turnId = context?.turnId ?? caller?.turnId;
    let preview = approval.preview;
    if (!preview) {
      try {
        preview = await this.renderPreview(actionName, args, store, context);
      } catch (previewErr) {
        log.warn("action preview renderer threw", {
          actionName,
          error: previewErr instanceof Error ? previewErr.message : String(previewErr),
        });
      }
    }
    const approvalId = await this.approvalsRepo.create({
      type: "action_execution",
      requestedBy: context?.initiator ?? "unknown",
      description,
      payload: {
        actionName,
        args,
        journalSequence,
        rootActionName: store.rootActionName,
        rootArgs: store.rootArgs,
        // The run this card replays, and whose journal it reads.
        rootExecutionId: store.journalId,
        replayJournal: store.journal,
        channelContext: context?.channelContext,
        sharedContext: context?.sharedContext,
        sessionId: context?.sessionId,
        agentName: context?.agentName,
        channelThreadKey: context?.channelThreadKey,
        turnId,
        preview,
      },
    });

    if (this.onApprovalCreated) {
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

  /** The action's own preview of a call, run as the turn that asked. */
  private async renderPreview(
    actionName: string,
    args: Record<string, unknown>,
    store: ReplayStore,
    context: ActionRunContext | undefined,
  ): Promise<PreviewPayload | undefined> {
    const caller = actionExecutionContext.getStore();
    // The preview is the action's own code, so it runs with what its execute
    // would get (executeNestedInvocation): the caller's accountable human.
    const action = this.registry.get(actionName);
    const previewStore: ActionExecutionStore = {
      actionName,
      executionId: context?.executionId ?? store.rootExecutionId,
      rootExecutionId: store.rootExecutionId,
      parentExecutionId: context?.parentExecutionId,
      parentActionName: context?.parentActionName,
      initiator: context?.initiator ?? "unknown",
      actor: caller?.actor ?? context?.actor,
      callerAppId: context?.callerAppId,
      engine: this,
      channelContext: context?.channelContext,
      sharedContext: context?.sharedContext,
      sessionId: context?.sessionId,
      turnId: context?.turnId ?? caller?.turnId,
      agentName: context?.agentName,
      channelThreadKey: context?.channelThreadKey,
    };
    return actionExecutionContext.run(previewStore, () => action?.preview?.(args));
  }
}

/** Whether a call waits for the guardian, and with which card when its
 *  action worded one in deciding. */
type CallApproval = { asks: false } | { asks: true; preview?: PreviewPayload };

/** One nested call being handled, passed between the replay helpers. */
interface NestedRun {
  action: Action;
  args: Record<string, unknown>;
  store: ReplayStore;
  context?: ActionRunContext;
  observer?: ActionRunObserver;
  actionEventObserver?: ActionInvocationObserver;
}

/** The error of a call whose approval could not be decided. */
function approvalFailure(actionName: string, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  return `${actionName} did not run: whether it needs the guardian's approval could not be decided (${reason}).`;
}
