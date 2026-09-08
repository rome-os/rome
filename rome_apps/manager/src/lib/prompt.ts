import type { ManagerConfig } from "./config.js";
import { describeFact } from "./facts.js";
import type { TaskView } from "./fold.js";
import { BLOCKED_PREFIX } from "./judge.js";

/**
 * The brief a worker is launched with. It is the task's whole history, because
 * a worker is started fresh every time and reads nothing else: a retry learns
 * what failed, and a steered worker learns what the person said, from the same
 * lines. The brief is stored on the Started fact, so the ledger records the
 * exact words a worker was given.
 */
export function buildWorkerPrompt(input: {
  task: TaskView;
  config: ManagerConfig;
  /** What made the runtime start this worker, when it is not the first one. */
  reason?: string;
}): string {
  const { task, config, reason } = input;

  const lines = [
    `You are working on task ${task.id}.`,
    "",
    `Working directory: ${config.workingDir}`,
    "Start by moving there; every path below is relative to it.",
    "",
    "What was asked for:",
    task.brief,
    "",
    "The task's history, oldest first. This is everything anyone recorded about",
    "it, including earlier attempts and what the person said:",
    ...task.facts.map((fact) => `  ${describeFact(fact)}`),
  ];

  if (reason) {
    lines.push("", `Why you were started: ${reason}`);
  }

  lines.push(
    "",
    "When you finish, end your turn with a short summary of what you did and",
    "where the result is — a branch, a pull request, a path. That summary is",
    "recorded as the task's Returned fact and is what gets judged.",
    "",
    `If you cannot finish, say so on a line starting with "${BLOCKED_PREFIX}"`,
    "followed by what is in the way. A blocked reply is not a failure; it is how",
    "you hand the question back to a person.",
    "",
    "Do not wait for anything, do not poll, and do not ask a question you cannot",
    "get an answer to inside this turn.",
  );

  return lines.join("\n");
}
