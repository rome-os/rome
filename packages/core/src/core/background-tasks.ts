import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../logger.js";
import type {
  ModelBackgroundTask,
  ModelBackgroundTaskEnd,
  ModelBackgroundTaskEndStatus,
  ModelBackgroundTaskEvent,
  ModelBackgroundTaskKind,
} from "./agent-runner.js";

const log = createLogger("background-tasks");

/** Claude's task types in Rome's words. Unknown types are `other`. */
export function claudeTaskKind(taskType: string): ModelBackgroundTaskKind {
  if (taskType === "local_bash") return "shell";
  if (taskType.endsWith("_agent") || taskType.endsWith("_teammate")) return "agent";
  return "other";
}

/** Claude's task end in Rome's words. */
export function claudeTaskEndStatus(
  status: "completed" | "failed" | "stopped",
  reason: string | undefined,
): ModelBackgroundTaskEndStatus {
  // The SDK documents `worker_restart` only with `stopped`: the resumed
  // process found the task orphaned, so nothing stopped it on purpose.
  if (reason === "worker_restart") return "lost";
  if (status === "stopped") return "interrupted";
  return status;
}

// Maps one Claude Agent SDK session's documented task events to Rome's
// background task events:
// - `background_tasks_changed` is the level signal: every live task after a
//   change, to replace the set with. The SDK sends none at process start, so
//   the set starts empty.
// - `task_notification` is the end edge.
// Ambient tasks (housekeeping and live-update watchers) are not activity, as
// the SDK documents, and are left out of both.
export class BackgroundTaskTracker {
  private tasks: readonly ModelBackgroundTask[] = [];

  get current(): readonly ModelBackgroundTask[] {
    return this.tasks;
  }

  /** The events `message` produces, in order; none for most messages. */
  observe(message: SDKMessage): ModelBackgroundTaskEvent[] {
    if (message.type !== "system") return [];
    if (message.subtype === "background_tasks_changed") {
      const seenAt = new Map(this.tasks.map((task) => [task.id, task.seenAt]));
      const now = Date.now();
      const tasks = message.tasks
        .filter((task) => !task.ambient)
        .map(
          (task): ModelBackgroundTask => ({
            id: task.task_id,
            kind: claudeTaskKind(task.task_type),
            description: task.description,
            seenAt: seenAt.get(task.task_id) ?? now,
            raw: task.task_type,
          }),
        );
      if (this.sameAs(tasks)) return [];
      this.tasks = tasks;
      return [{ type: "background_tasks", tasks }];
    }
    if (message.subtype === "task_notification" && !message.ambient) {
      const end: ModelBackgroundTaskEnd = {
        id: message.task_id,
        status: claudeTaskEndStatus(message.status, message.reason),
        summary: message.summary,
        raw: message.reason ? `${message.status}:${message.reason}` : message.status,
      };
      log.info("background task ended", { taskId: end.id, status: end.status, raw: end.raw });
      return [{ type: "background_task_end", end }];
    }
    return [];
  }

  // Compared by id: the SDK doesn't promise a stable task order.
  private sameAs(tasks: readonly ModelBackgroundTask[]): boolean {
    const prior = new Map(this.tasks.map((task) => [task.id, task]));
    return (
      tasks.length === this.tasks.length &&
      tasks.every((task) => {
        const before = prior.get(task.id);
        return (
          before !== undefined && task.raw === before.raw && task.description === before.description
        );
      })
    );
  }
}
