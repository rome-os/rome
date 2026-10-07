import { createLogger } from "../../logger.js";
import type {
  ModelBackgroundTask,
  ModelBackgroundTaskEnd,
  ModelBackgroundTaskEndStatus,
  ModelBackgroundTaskEvent,
  ModelBackgroundTaskKind,
} from "../agent-runner.js";
import {
  Notify,
  type GenericThreadItem,
  type ItemCompletedNotification,
  type ItemStartedNotification,
  type TurnCompletedNotification,
  type TurnStartedNotification,
} from "./app-server-protocol.js";

const log = createLogger("codex-background-tasks");

// Every thread on the shared app-server reaches every tracker, so the turn
// state remembered for threads not yet known is bounded.
const MAX_REMEMBERED_THREADS = 256;

interface Child {
  description: string;
  // The child turn running now, once one was seen.
  turnId: string | null;
  // Once a child turn was seen, the child's own turns decide whether it
  // runs, and activity items, which can arrive late, no longer end it.
  sawTurn: boolean;
}

interface OpenWork {
  kind: ModelBackgroundTaskKind;
  description: string;
  raw: string;
  turnId: string;
}

// Builds one Codex thread's background task set from its item edges, since
// the app-server reports no task list (probed live on 0.156.1):
// - A shell is a `commandExecution` item. One still in progress when its turn
//   completes keeps running in the background; its late `item/completed`,
//   tagged with the finished turn's id, is its end.
// - A sub-agent is keyed by its child thread. A `started` `subAgentActivity`
//   item on this thread spawns it and starts its first turn. `followup_task`
//   starts another turn on a child that already finished, but its
//   `interacted` item is the same one `send_message` sends without starting a
//   turn, so the child's own `turn/started` and `turn/completed` decide. A
//   `completed` or `interrupted` activity item ends it only until one of its
//   turns was seen, since a late one can name a turn before the current one.
//   Each activity item arrives as both `item/started` and `item/completed`
//   and counts once.
// - A child's turns can start and even end before the item that names it,
//   since Codex queues a spawn's input before emitting `started`. A thread
//   resumed in a new model session meets its earlier children only through
//   `interacted`. So turns on threads not yet known are remembered, and a
//   child takes up its thread's state when an item first names it.
// Work becomes a background task when the turn that started it completes
// with it still running. Codex starts no turn for a finished task, so an end
// reaches the model only if it checks on the task in a later turn.
export class CodexBackgroundTaskTracker {
  private readonly open = new Map<string, OpenWork>();
  private readonly children = new Map<string, Child>();
  // Threads not yet known as children: the turn running on each, or null.
  private readonly unknownThreads = new Map<string, string | null>();
  private readonly seenActivities = new Set<string>();
  private readonly ignoredTurns = new Set<string>();
  private turnId: string | null = null;
  private tasks: readonly ModelBackgroundTask[] = [];

  get current(): readonly ModelBackgroundTask[] {
    return this.tasks;
  }

  /**
   * Leaves out the work of `turnId`, a turn this thread runs for another
   * session such as a borrowed exact fork. Call it before that turn's
   * `turn/started` is observed.
   */
  ignoreTurn(turnId: string): void {
    this.ignoredTurns.add(turnId);
  }

  /** The events one app-server notification for this thread produces. */
  observe(method: string, params: unknown): ModelBackgroundTaskEvent[] {
    switch (method) {
      case Notify.turnStarted: {
        this.turnId = (params as TurnStartedNotification).turn?.id ?? null;
        return [];
      }
      case Notify.itemStarted: {
        const p = params as ItemStartedNotification;
        if (this.ignoredTurns.has(p.turnId)) return [];
        // Tool-ish items carry their fields untyped.
        const item = p.item as GenericThreadItem;
        if (item.type === "subAgentActivity") return this.onSubAgentActivity(item, p.turnId);
        const work = shellWork(item, p.turnId);
        if (work && item.status === "inProgress") this.open.set(item.id, work);
        return [];
      }
      case Notify.itemCompleted: {
        const p = params as ItemCompletedNotification;
        if (this.ignoredTurns.has(p.turnId)) return [];
        const item = p.item as GenericThreadItem;
        if (item.type === "commandExecution") return this.endShell(item);
        if (item.type === "subAgentActivity") return this.onSubAgentActivity(item, p.turnId);
        return [];
      }
      case Notify.turnCompleted: {
        const turnId = (params as TurnCompletedNotification).turn?.id;
        if (turnId === this.turnId) this.turnId = null;
        if (!turnId || this.ignoredTurns.has(turnId)) return [];
        return this.promote(turnId);
      }
      default:
        return [];
    }
  }

  /**
   * The events one notification for another thread produces: only a turn
   * starting or ending on one of this thread's sub-agents counts.
   */
  observeChildThread(method: string, params: unknown): ModelBackgroundTaskEvent[] {
    const childId = (params as { threadId?: unknown } | undefined)?.threadId;
    if (typeof childId !== "string") return [];
    const child = this.children.get(childId);
    if (child === undefined) {
      this.rememberUnknownThread(childId, method, params);
      return [];
    }
    if (method === Notify.turnStarted) {
      child.turnId = (params as TurnStartedNotification).turn?.id ?? null;
      child.sawTurn = true;
      return this.childRunning(childId, child.description);
    }
    if (method === Notify.turnCompleted) {
      const turn = (params as TurnCompletedNotification).turn;
      if (child.turnId !== null && turn?.id !== child.turnId) return [];
      child.turnId = null;
      child.sawTurn = true;
      const status = turn?.status;
      return this.end(childId, {
        id: childId,
        status: childTurnEndStatus(status),
        raw: `turn:${String(status)}`,
      });
    }
    return [];
  }

  /** The app-server exited; every running task died with it. */
  lost(): ModelBackgroundTaskEvent[] {
    this.open.clear();
    this.turnId = null;
    if (this.tasks.length === 0) return [];
    const events: ModelBackgroundTaskEvent[] = this.tasks.map((task) => ({
      type: "background_task_end",
      end: { id: task.id, status: "lost", raw: "app-server exited" },
    }));
    this.tasks = [];
    events.push({ type: "background_tasks", tasks: [] });
    return events;
  }

  private onSubAgentActivity(item: GenericThreadItem, turnId: string): ModelBackgroundTaskEvent[] {
    const agentThreadId = typeof item.agentThreadId === "string" ? item.agentThreadId : undefined;
    if (!agentThreadId || this.seenActivities.has(item.id)) return [];
    this.seenActivities.add(item.id);
    const kind = item.kind;
    if (kind === "started" || kind === "interacted") {
      if (this.children.has(agentThreadId)) return [];
      const agentPath = typeof item.agentPath === "string" ? item.agentPath : agentThreadId;
      const child = this.addChild(agentThreadId, agentPath);
      if (child.turnId !== null) return this.childRunning(agentThreadId, agentPath);
      // A spawn starts the child's first turn even when none was seen yet.
      // A message to an idle child starts nothing.
      if (kind === "started" && !child.sawTurn) {
        this.open.set(agentThreadId, agentWork(agentPath, turnId));
      }
      return [];
    }
    if (
      (kind === "completed" || kind === "interrupted") &&
      !this.children.get(agentThreadId)?.sawTurn
    ) {
      return this.end(agentThreadId, {
        id: agentThreadId,
        status: kind === "completed" ? "completed" : "interrupted",
        raw: `subAgentActivity:${kind}`,
      });
    }
    return [];
  }

  private addChild(id: string, description: string): Child {
    const turnId = this.unknownThreads.get(id);
    this.unknownThreads.delete(id);
    const child: Child = { description, turnId: turnId ?? null, sawTurn: turnId !== undefined };
    this.children.set(id, child);
    return child;
  }

  private rememberUnknownThread(threadId: string, method: string, params: unknown): void {
    if (method !== Notify.turnStarted && method !== Notify.turnCompleted) return;
    this.unknownThreads.delete(threadId);
    const turnId =
      method === Notify.turnStarted ? ((params as TurnStartedNotification).turn?.id ?? null) : null;
    this.unknownThreads.set(threadId, turnId);
    if (this.unknownThreads.size > MAX_REMEMBERED_THREADS) {
      const oldest = this.unknownThreads.keys().next().value;
      if (oldest !== undefined) this.unknownThreads.delete(oldest);
    }
  }

  // A sub-agent's turn started. Inside one of this thread's turns it is open
  // work like a spawn; between turns nothing will promote it, so it is a
  // background task at once.
  private childRunning(childId: string, description: string): ModelBackgroundTaskEvent[] {
    if (this.open.has(childId) || this.isTask(childId)) return [];
    if (this.turnId !== null) {
      if (!this.ignoredTurns.has(this.turnId)) {
        this.open.set(childId, agentWork(description, this.turnId));
      }
      return [];
    }
    this.tasks = [...this.tasks, toTask(childId, agentWork(description, ""), Date.now())];
    return [{ type: "background_tasks", tasks: this.tasks }];
  }

  private endShell(item: GenericThreadItem): ModelBackgroundTaskEvent[] {
    const exitCode = typeof item.exitCode === "number" ? item.exitCode : undefined;
    const status = item.status;
    const succeeded = status === "completed" && (exitCode === undefined || exitCode === 0);
    const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : undefined;
    return this.end(item.id, {
      id: item.id,
      status: succeeded ? "completed" : "failed",
      ...(output ? { summary: output } : {}),
      raw: exitCode === undefined ? String(status) : `${String(status)}:${exitCode}`,
    });
  }

  // Ends `id`: a background task gets its end and a new set; work that ended
  // inside its own turn was never a background task, so it reports nothing.
  private end(id: string, end: ModelBackgroundTaskEnd): ModelBackgroundTaskEvent[] {
    this.open.delete(id);
    if (!this.isTask(id)) return [];
    this.tasks = this.tasks.filter((task) => task.id !== id);
    log.info("background task ended", { taskId: id, status: end.status, raw: end.raw });
    return [
      { type: "background_task_end", end },
      { type: "background_tasks", tasks: this.tasks },
    ];
  }

  private isTask(id: string): boolean {
    return this.tasks.some((task) => task.id === id);
  }

  private promote(turnId: string): ModelBackgroundTaskEvent[] {
    const now = Date.now();
    const promoted: ModelBackgroundTask[] = [];
    for (const [id, work] of this.open) {
      if (work.turnId !== turnId) continue;
      this.open.delete(id);
      promoted.push(toTask(id, work, now));
    }
    if (promoted.length === 0) return [];
    this.tasks = [...this.tasks, ...promoted];
    return [{ type: "background_tasks", tasks: this.tasks }];
  }
}

function toTask(id: string, work: OpenWork, seenAt: number): ModelBackgroundTask {
  return { id, kind: work.kind, description: work.description, seenAt, raw: work.raw };
}

function agentWork(description: string, turnId: string): OpenWork {
  return { kind: "agent", description, raw: "subAgentActivity", turnId };
}

function childTurnEndStatus(status: unknown): ModelBackgroundTaskEndStatus {
  if (status === "completed") return "completed";
  if (status === "interrupted") return "interrupted";
  return "failed";
}

function shellWork(item: GenericThreadItem, turnId: string): OpenWork | undefined {
  if (item.type !== "commandExecution") return undefined;
  return {
    kind: "shell",
    description: typeof item.command === "string" ? item.command : "shell command",
    raw: "commandExecution",
    turnId,
  };
}
