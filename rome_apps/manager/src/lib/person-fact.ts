import type { ActionResult, RomeAppContext } from "@rome-os/app-runtime";
import { createLedgerRepository } from "../db/repositories/ledger.js";
import type { Fact, NewFact } from "./facts.js";
import { foldTask, type TaskState, type TaskView } from "./fold.js";
import { personFromContext } from "./identity.js";

/** A person's fact, minus the author — the runtime fills that in. */
export type UnstampedFact = Omit<NewFact, "by"> & { source: string };

/**
 * The four actions the manager agent can call all do the same three things:
 * stamp the person, append one fact, and reconcile so the new fact is acted on
 * without waiting for the next tick. The words and the task are the agent's
 * choice; `by` is not.
 */
export async function writePersonFact(
  appContext: RomeAppContext,
  unstamped: UnstampedFact,
): Promise<ActionResult> {
  const ledger = createLedgerRepository(appContext.db);
  if (!ledger.reachable()) {
    return { status: "error", error: "the ledger is unreachable" };
  }

  const fact = ledger.append({ ...unstamped, by: personFromContext() } as NewFact);

  await appContext.runAction("manager:reconcile", {});

  return { status: "ok", data: summarize(fact, ledger.factsFor(unstamped.taskId)) };
}

/** Load a task, or say why it cannot be acted on. */
export function loadTask(
  appContext: RomeAppContext,
  taskId: string,
): { ok: true; task: TaskView } | { ok: false; error: string } {
  const ledger = createLedgerRepository(appContext.db);
  const facts = ledger.factsFor(taskId);
  if (facts.length === 0) {
    return { ok: false, error: `no task ${taskId}` };
  }
  return { ok: true, task: foldTask(facts) };
}

/** Only a person ends a task, and only one that is still open. */
export function rejectIfClosed(task: TaskView): string | undefined {
  const closed: TaskState[] = ["completed", "cancelled"];
  if (closed.includes(task.state)) {
    return `task ${task.id} is already ${task.state}`;
  }
  return undefined;
}

function summarize(fact: Fact, facts: readonly Fact[]) {
  const task = foldTask(facts);
  return {
    taskId: fact.taskId,
    wrote: fact.kind,
    by: fact.by,
    state: task.state,
    position: task.position,
  };
}
