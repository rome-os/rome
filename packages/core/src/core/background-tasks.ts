import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../logger.js";
import type {
  ModelBackgroundTask,
  ModelBackgroundTaskEnd,
  ModelBackgroundTaskListener,
} from "./agent-runner.js";

const log = createLogger("background-tasks");

// Tracks one Claude Agent SDK session's background tasks from its documented
// task events:
// - `background_tasks_changed` is the level signal: every live task after a
//   change, to replace the set with. The SDK sends none at process start, so
//   the set starts empty.
// - `task_notification` is the end edge. `reason: 'worker_restart'` marks a
//   task a resumed process found orphaned.
// Ambient tasks (housekeeping and live-update watchers) are not activity, as
// the SDK documents, and are left out of both.
export class BackgroundTaskTracker {
  private tasks: readonly ModelBackgroundTask[] = [];
  private readonly listeners = new Set<ModelBackgroundTaskListener>();

  get current(): readonly ModelBackgroundTask[] {
    return this.tasks;
  }

  subscribe(listener: ModelBackgroundTaskListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  observe(message: SDKMessage): void {
    if (message.type !== "system") return;
    if (message.subtype === "background_tasks_changed") {
      const seenAt = new Map(this.tasks.map((task) => [task.id, task.seenAt]));
      const now = Date.now();
      this.replace(
        message.tasks
          .filter((task) => !task.ambient)
          .map((task) => ({
            id: task.task_id,
            type: task.task_type,
            description: task.description,
            seenAt: seenAt.get(task.task_id) ?? now,
          })),
      );
    } else if (message.subtype === "task_notification" && !message.ambient) {
      const end: ModelBackgroundTaskEnd = {
        id: message.task_id,
        status: message.status,
        ...(message.reason ? { reason: message.reason } : {}),
        summary: message.summary,
      };
      log.info("background task ended", { taskId: end.id, status: end.status, reason: end.reason });
      this.emit((listener) => listener.onEnd?.(end));
    }
  }

  /** The provider process ended; its tasks ended with it. */
  reset(): void {
    if (this.tasks.length > 0) this.replace([]);
  }

  private replace(tasks: readonly ModelBackgroundTask[]): void {
    const same =
      tasks.length === this.tasks.length &&
      tasks.every((task, i) => {
        const prior = this.tasks[i];
        return (
          task.id === prior?.id &&
          task.type === prior.type &&
          task.description === prior.description
        );
      });
    if (same) return;
    this.tasks = tasks;
    this.emit((listener) => listener.onChange?.(tasks));
  }

  private emit(call: (listener: ModelBackgroundTaskListener) => void): void {
    for (const listener of this.listeners) {
      try {
        call(listener);
      } catch (error) {
        log.warn("background task listener failed", { error: String(error) });
      }
    }
  }
}
