import type { TaskView } from "./fold.js";

/**
 * The judge is one of the two places a model may enter this app. It answers a
 * single question — is the task done, given what the worker returned — and the
 * default answer needs no model at all.
 *
 * Nothing else in the runtime asks that question, so an instance that wants a
 * model-graded "done" swaps the function here and changes nothing else.
 */

export interface JudgeVerdict {
  done: boolean;
  /** Why not, in words the next worker can act on. Set only when `done` is false. */
  why?: string;
}

export type Judge = (task: TaskView, reply: string, evidence: string) => JudgeVerdict;

/**
 * The line prefix a worker uses to say it could not finish. It is part of the
 * worker's brief, so a worker that hits a wall says so in a form the judge can
 * read without a model.
 */
export const BLOCKED_PREFIX = "BLOCKED:";

/** Whether any line of `reply` opens with {@link BLOCKED_PREFIX}. */
export function hasBlockedLine(reply: string): boolean {
  return reply.split("\n").some((line) => line.trimStart().startsWith(BLOCKED_PREFIX));
}

/**
 * The default, deterministic judge: a task is done when the worker said
 * something and did not declare itself blocked. It reads the reply only —
 * `task` and `evidence` are in the signature so a model-backed replacement has
 * the history and the pointer to the result without a different call site.
 */
export const judge: Judge = (_task, reply, _evidence) => {
  const text = reply.trim();
  if (!text) {
    return { done: false, why: "the worker returned an empty reply" };
  }
  const blocked = reply
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith(BLOCKED_PREFIX));
  if (blocked) {
    return { done: false, why: blocked };
  }
  return { done: true };
};
