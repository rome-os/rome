import { createLogger } from "../../logger.js";
import type {
  ModelBackgroundTask,
  ModelBackgroundTaskEnd,
  ModelBackgroundTaskEvent,
  ModelBackgroundTaskKind,
} from "../agent-runner.js";
import {
  Notify,
  type ItemCompletedNotification,
  type ItemStartedNotification,
  type GenericThreadItem,
  type TurnCompletedNotification,
} from "./app-server-protocol.js";

const log = createLogger("codex-background-tasks");

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
// - A sub-agent is a pair of `subAgentActivity` items on the parent thread,
//   kind `started` and later `completed` (or `interrupted`), keyed by the
//   child's `agentThreadId`.
// Work becomes a background task when the turn that started it completes
// with it still running. Codex starts no turn for a finished task, so an end
// reaches the model only if it checks on the task in a later turn.
export class CodexBackgroundTaskTracker {
  private readonly open = new Map<string, OpenWork>();
  private tasks: readonly ModelBackgroundTask[] = [];

  get current(): readonly ModelBackgroundTask[] {
    return this.tasks;
  }

  /** The events one app-server notification for this thread produces. */
  observe(method: string, params: unknown): ModelBackgroundTaskEvent[] {
    switch (method) {
      case Notify.itemStarted: {
        const p = params as ItemStartedNotification;
        // Tool-ish items carry their fields untyped.
        const item = p.item as GenericThreadItem;
        if (item.type === "subAgentActivity" && item.kind === "started") {
          return this.onSubAgentActivity(item, p.turnId);
        }
        const work = shellWork(item, p.turnId);
        if (work && item.status === "inProgress") this.open.set(item.id, work);
        return [];
      }
      case Notify.itemCompleted: {
        const p = params as ItemCompletedNotification;
        const item = p.item as GenericThreadItem;
        if (item.type === "commandExecution") return this.endShell(item);
        if (item.type === "subAgentActivity") return this.onSubAgentActivity(item, p.turnId);
        return [];
      }
      case Notify.turnCompleted: {
        const turnId = (params as TurnCompletedNotification).turn?.id;
        return turnId ? this.promote(turnId) : [];
      }
      default:
        return [];
    }
  }

  /** The app-server exited; every running task died with it. */
  lost(): ModelBackgroundTaskEvent[] {
    this.open.clear();
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
    if (!agentThreadId) return [];
    const kind = item.kind;
    if (kind === "started") {
      const agentPath = typeof item.agentPath === "string" ? item.agentPath : agentThreadId;
      this.open.set(agentThreadId, {
        kind: "agent",
        description: agentPath,
        raw: "subAgentActivity",
        turnId,
      });
      return [];
    }
    if (kind === "completed" || kind === "interrupted") {
      return this.end(agentThreadId, {
        id: agentThreadId,
        status: kind === "completed" ? "completed" : "interrupted",
        raw: `subAgentActivity:${kind}`,
      });
    }
    return [];
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
    if (!this.tasks.some((task) => task.id === id)) return [];
    this.tasks = this.tasks.filter((task) => task.id !== id);
    log.info("background task ended", { taskId: id, status: end.status, raw: end.raw });
    return [
      { type: "background_task_end", end },
      { type: "background_tasks", tasks: this.tasks },
    ];
  }

  private promote(turnId: string): ModelBackgroundTaskEvent[] {
    const now = Date.now();
    const promoted: ModelBackgroundTask[] = [];
    for (const [id, work] of this.open) {
      if (work.turnId !== turnId) continue;
      this.open.delete(id);
      promoted.push({
        id,
        kind: work.kind,
        description: work.description,
        seenAt: now,
        raw: work.raw,
      });
    }
    if (promoted.length === 0) return [];
    this.tasks = [...this.tasks, ...promoted];
    return [{ type: "background_tasks", tasks: this.tasks }];
  }
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
