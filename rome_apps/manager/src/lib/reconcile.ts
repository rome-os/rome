import type { ManagerConfig } from "./config.js";
import { type NewFact, RUNTIME } from "./facts.js";
import { isTerminal, type LedgerSnapshot, type TaskView, workerAgeMs } from "./fold.js";
import type { Judge } from "./judge.js";
import { buildWorkerPrompt } from "./prompt.js";

/**
 * The runtime's whole decision, as a pure function of a ledger snapshot.
 *
 * It returns a list of things to do rather than doing them, which is what makes
 * every rule here testable without a database and what lets the caller stop
 * after any single item: each one leaves the ledger consistent on its own.
 */

export type ReconcileAction =
  /** Append one fact. */
  | { type: "append"; fact: NewFact }
  /** Run the worker named by a Started that was just appended. */
  | { type: "launch"; taskId: string; workerId: string }
  /**
   * Ask a running worker to end. The runtime does this when a person ends or
   * steers a task; see the applier for what "stop" costs on today's platform.
   */
  | { type: "stop"; taskId: string; workerId: string; why: string };

export interface ReconcileInput {
  snapshot: LedgerSnapshot;
  config: ManagerConfig;
  /** The second of the app's two model call sites. */
  judge: Judge;
  /** Injected so the output is a value tests can compare. */
  newWorkerId: () => string;
}

/** Reasons that appear on a Lost fact the runtime writes for itself. */
export const LOST_SILENT = "silent past cap";
export const LOST_STOPPED = "stopped by runtime";

export function reconcile(input: ReconcileInput): ReconcileAction[] {
  const { snapshot, config, judge, newWorkerId } = input;

  const running = snapshot.tasks.filter((task) => task.liveWorker !== undefined).length;
  // One budget for the whole pass. Every launch spends from it and every stop
  // returns to it, so the cap holds across tasks rather than per task.
  let budget = config.maxWorkers - running;
  const actions: ReconcileAction[] = [];

  /** Write Started and launch a worker, unless the cap says not yet. */
  const start = (task: TaskView, reason?: string): boolean => {
    if (budget <= 0) return false;
    const workerId = newWorkerId();
    const prompt = buildWorkerPrompt({ task, config, reason });
    actions.push({
      type: "append",
      fact: { taskId: task.id, kind: "Started", by: RUNTIME, payload: { workerId, prompt } },
    });
    actions.push({ type: "launch", taskId: task.id, workerId });
    budget -= 1;
    return true;
  };

  /** Ask a worker to end, and take its slot back for this pass. */
  const stop = (task: TaskView, why: string): void => {
    if (!task.liveWorker) return;
    actions.push({
      type: "stop",
      taskId: task.id,
      workerId: task.liveWorker.workerId,
      why,
    });
    budget += 1;
  };

  /**
   * What to do about a worker that did not return: retry while the task is
   * under the start cap, and ask a person once it is over. The cap counts
   * Started facts since the last fact a person wrote, so a reply resets it
   * without anyone keeping a counter.
   */
  const afterFailure = (task: TaskView, why: string): void => {
    if (task.startsSinceLastPersonFact < config.startCap) {
      start(task, why);
      return;
    }
    actions.push({
      type: "append",
      fact: {
        taskId: task.id,
        kind: "Question",
        by: RUNTIME,
        payload: { why: `${why} (${task.startsSinceLastPersonFact} attempts)` },
      },
    });
  };

  for (const task of snapshot.tasks) {
    // A person ended it. The only thing left to do is get out of the worker's
    // way — the runtime writes nothing more on a terminal task.
    if (isTerminal(task.state)) {
      stop(task, LOST_STOPPED);
      continue;
    }

    // Nobody owns it yet. Take it and start, or leave it Created for a pass
    // that has room; a Taken with no worker would only be work for later.
    if (task.state === "created") {
      if (budget <= 0) continue;
      actions.push({
        type: "append",
        fact: { taskId: task.id, kind: "Taken", by: RUNTIME, payload: {} },
      });
      start(task);
      continue;
    }

    // A worker that has been silent past the age cap is treated as dead. The
    // runtime writes the Lost the worker never could, then handles it as one.
    const worker = task.liveWorker;
    if (worker && workerAgeMs(worker, snapshot.now) > config.ageCapHours * 3_600_000) {
      actions.push({
        type: "append",
        fact: {
          taskId: task.id,
          kind: "Lost",
          by: RUNTIME,
          payload: { workerId: worker.workerId, why: LOST_SILENT },
        },
      });
      budget += 1;
      afterFailure(task, `worker ${worker.workerId} was ${LOST_SILENT}`);
      continue;
    }

    switch (task.latest.kind) {
      case "Returned": {
        const { workerId, reply } = task.latest.payload;
        const evidence = `worker ${workerId}`;
        const verdict = judge(task, reply, evidence);
        if (verdict.done) {
          actions.push({
            type: "append",
            fact: {
              taskId: task.id,
              kind: "Report",
              by: RUNTIME,
              payload: { what: reply, evidence },
            },
          });
        } else {
          start(task, `the last result was not accepted: ${verdict.why ?? "not done"}`);
        }
        break;
      }

      case "Failed":
        afterFailure(task, task.latest.payload.error);
        break;

      case "Lost":
        afterFailure(
          task,
          `worker ${task.latest.payload.workerId} was lost: ${task.latest.payload.why}`,
        );
        break;

      case "Reply":
        // Steering. A worker started before the reply cannot read it, so it is
        // stopped and replaced by one whose brief carries the reply.
        stop(task, LOST_STOPPED);
        start(task, `a person replied: ${task.latest.payload.text}`);
        break;

      case "Taken":
        // Taken with no Started after it. Either the first pass ended between
        // the two writes, or the last pass had no budget.
        start(task);
        break;

      case "Started":
        // working: a worker is running and nothing has come back yet.
        break;

      case "Question":
      case "Report":
        // stuck and reported. Both wait for a person; the runtime never leaves
        // Taken on its own.
        break;

      default:
        break;
    }
  }

  return actions;
}
