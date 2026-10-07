export class ActionCancelledError extends Error {
  constructor(message = "Action cancelled") {
    super(message);
    this.name = "ActionCancelledError";
  }
}

/** A subprocess execution died without producing a result envelope. */
export class ActionWorkerExitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionWorkerExitError";
  }
}

/** The main process refused to create another action worker because doing so
 * would exceed the instance-wide process budget. A fail-fast call throws it at
 * once. A root run with `whenWorkersBusy: "queue"` throws it only after waiting
 * `waitedMs` without a slot opening. Callers must surface or retry this at their
 * own scheduling boundary; waiting inside a nested action would retain its
 * ancestor workers and can deadlock the execution tree. */
export class ActionWorkerCapacityError extends Error {
  constructor(maxWorkerProcesses: number, waitedMs?: number) {
    super(
      waitedMs === undefined
        ? `Action worker capacity reached (max ${maxWorkerProcesses} live workers)`
        : `Action worker capacity reached (max ${maxWorkerProcesses} live workers; queued ${Math.round(waitedMs / 1000)}s without a free worker)`,
    );
    this.name = "ActionWorkerCapacityError";
  }
}
