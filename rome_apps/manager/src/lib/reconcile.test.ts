import { describe, expect, it } from "@rstest/core";
import { DEFAULT_WORKER_AGENT, type ManagerConfig } from "./config.js";
import { RUNTIME } from "./facts.js";
import { fold } from "./fold.js";
import type { Judge } from "./judge.js";
import { LOST_SILENT, LOST_STOPPED, reconcile, type ReconcileAction } from "./reconcile.js";
import { LedgerBuilder } from "./test-facts.js";

const ANN = "ann";

const CONFIG: ManagerConfig = {
  workingDir: "/srv/project",
  workerAgent: DEFAULT_WORKER_AGENT,
  startCap: 2,
  maxWorkers: 3,
  ageCapHours: 3,
  intervalMinutes: 5,
};

const ALWAYS_DONE: Judge = () => ({ done: true });
const NEVER_DONE: Judge = () => ({ done: false, why: "no pull request" });

function run(
  ledger: LedgerBuilder,
  overrides: { config?: Partial<ManagerConfig>; judge?: Judge; now?: Date } = {},
): ReconcileAction[] {
  let n = 0;
  return reconcile({
    snapshot: fold(overrides.now ?? ledger.now(), ledger.facts),
    config: { ...CONFIG, ...overrides.config },
    judge: overrides.judge ?? ALWAYS_DONE,
    newWorkerId: () => `w${++n}`,
  });
}

/** The shape of an action list, with prompts elided — those are prompt.ts's job. */
function shape(actions: ReconcileAction[]) {
  return actions.map((action) => {
    if (action.type === "append") {
      return { type: "append", taskId: action.fact.taskId, kind: action.fact.kind };
    }
    return { type: action.type, taskId: action.taskId, workerId: action.workerId };
  });
}

function created(taskId = "t1", brief = "add rate limiting") {
  return new LedgerBuilder().add({
    taskId,
    kind: "Created",
    by: ANN,
    source: brief,
    payload: { brief },
  });
}

function working(taskId = "t1", workerId = "w0") {
  return created(taskId)
    .add({ taskId, kind: "Taken", by: RUNTIME, payload: {} })
    .add({ taskId, kind: "Started", by: RUNTIME, payload: { workerId, prompt: "go" } });
}

describe("reconcile: a new task", () => {
  it("takes it and starts a worker in one pass", () => {
    expect(shape(run(created()))).toEqual([
      { type: "append", taskId: "t1", kind: "Taken" },
      { type: "append", taskId: "t1", kind: "Started" },
      { type: "launch", taskId: "t1", workerId: "w1" },
    ]);
  });

  it("puts the task's brief and the working directory in the worker's prompt", () => {
    const actions = run(created());
    const started = actions[1];
    if (started.type !== "append" || started.fact.kind !== "Started")
      throw new Error("expected Started");
    expect(started.fact.payload.prompt).toContain("add rate limiting");
    expect(started.fact.payload.prompt).toContain("/srv/project");
  });

  it("leaves it Created when every worker slot is taken", () => {
    const ledger = created("t1");
    ledger.add({ taskId: "t2", kind: "Created", by: ANN, source: "b", payload: { brief: "b" } });
    ledger.add({ taskId: "t1", kind: "Taken", by: RUNTIME, payload: {} });
    ledger.add({
      taskId: "t1",
      kind: "Started",
      by: RUNTIME,
      payload: { workerId: "w0", prompt: "go" },
    });

    expect(shape(run(ledger, { config: { maxWorkers: 1 } }))).toEqual([]);
  });

  it("spends the last slot on the oldest task", () => {
    const ledger = created("t1", "older");
    ledger.add({
      taskId: "t2",
      kind: "Created",
      by: ANN,
      source: "newer",
      payload: { brief: "newer" },
    });

    expect(shape(run(ledger, { config: { maxWorkers: 1 } }))).toEqual([
      { type: "append", taskId: "t1", kind: "Taken" },
      { type: "append", taskId: "t1", kind: "Started" },
      { type: "launch", taskId: "t1", workerId: "w1" },
    ]);
  });
});

describe("reconcile: a task the runtime already owns", () => {
  it("does nothing while a worker is running", () => {
    expect(shape(run(working()))).toEqual([]);
  });

  it("starts a worker for a Taken that never got one", () => {
    const ledger = created().add({ taskId: "t1", kind: "Taken", by: RUNTIME, payload: {} });
    expect(shape(run(ledger))).toEqual([
      { type: "append", taskId: "t1", kind: "Started" },
      { type: "launch", taskId: "t1", workerId: "w1" },
    ]);
  });

  it("waits on a Question and on a Report", () => {
    const stuck = working().add({
      taskId: "t1",
      kind: "Failed",
      by: "w0",
      payload: { workerId: "w0", error: "boom" },
    });
    stuck.add({ taskId: "t1", kind: "Question", by: RUNTIME, payload: { why: "boom" } });
    expect(shape(run(stuck))).toEqual([]);

    const reported = working().add({
      taskId: "t1",
      kind: "Returned",
      by: "w0",
      payload: { workerId: "w0", reply: "PR 88" },
    });
    reported.add({
      taskId: "t1",
      kind: "Report",
      by: RUNTIME,
      payload: { what: "PR 88", evidence: "worker w0" },
    });
    expect(shape(run(reported))).toEqual([]);
  });
});

describe("reconcile: judging what came back", () => {
  it("reports when the judge says yes", () => {
    const ledger = working().add({
      taskId: "t1",
      kind: "Returned",
      by: "w0",
      payload: { workerId: "w0", reply: "Opened PR 88" },
    });
    const actions = run(ledger, { judge: ALWAYS_DONE });
    expect(shape(actions)).toEqual([{ type: "append", taskId: "t1", kind: "Report" }]);
    const report = actions[0];
    if (report.type !== "append" || report.fact.kind !== "Report")
      throw new Error("expected Report");
    expect(report.fact.payload).toEqual({ what: "Opened PR 88", evidence: "worker w0" });
  });

  it("starts again with the judge's reason when it says no", () => {
    const ledger = working().add({
      taskId: "t1",
      kind: "Returned",
      by: "w0",
      payload: { workerId: "w0", reply: "wrote some code" },
    });
    const actions = run(ledger, { judge: NEVER_DONE });
    expect(shape(actions)).toEqual([
      { type: "append", taskId: "t1", kind: "Started" },
      { type: "launch", taskId: "t1", workerId: "w1" },
    ]);
    const started = actions[0];
    if (started.type !== "append" || started.fact.kind !== "Started")
      throw new Error("expected Started");
    expect(started.fact.payload.prompt).toContain("no pull request");
  });
});

describe("reconcile: failure and the start cap", () => {
  it("retries while the task is under the cap", () => {
    const ledger = working().add({
      taskId: "t1",
      kind: "Failed",
      by: "w0",
      payload: { workerId: "w0", error: "0042 conflicts with 0041" },
    });
    const actions = run(ledger);
    expect(shape(actions)).toEqual([
      { type: "append", taskId: "t1", kind: "Started" },
      { type: "launch", taskId: "t1", workerId: "w1" },
    ]);
    const started = actions[0];
    if (started.type !== "append" || started.fact.kind !== "Started")
      throw new Error("expected Started");
    expect(started.fact.payload.prompt).toContain("0042 conflicts with 0041");
  });

  it("asks once the task is over the cap", () => {
    const ledger = working()
      .add({ taskId: "t1", kind: "Failed", by: "w0", payload: { workerId: "w0", error: "boom" } })
      .add({
        taskId: "t1",
        kind: "Started",
        by: RUNTIME,
        payload: { workerId: "w1", prompt: "go" },
      })
      .add({ taskId: "t1", kind: "Failed", by: "w1", payload: { workerId: "w1", error: "boom" } });

    const actions = run(ledger);
    expect(shape(actions)).toEqual([{ type: "append", taskId: "t1", kind: "Question" }]);
    const question = actions[0];
    if (question.type !== "append" || question.fact.kind !== "Question")
      throw new Error("expected Question");
    expect(question.fact.payload.why).toContain("boom");
    expect(question.fact.payload.why).toContain("2 attempts");
  });

  it("treats a Lost like a Failed", () => {
    const ledger = working().add({
      taskId: "t1",
      kind: "Lost",
      by: RUNTIME,
      payload: { workerId: "w0", why: "host restart" },
    });
    expect(shape(run(ledger))).toEqual([
      { type: "append", taskId: "t1", kind: "Started" },
      { type: "launch", taskId: "t1", workerId: "w1" },
    ]);
  });

  it("counts starts again from zero after a person replies", () => {
    const ledger = working()
      .add({ taskId: "t1", kind: "Failed", by: "w0", payload: { workerId: "w0", error: "boom" } })
      .add({
        taskId: "t1",
        kind: "Started",
        by: RUNTIME,
        payload: { workerId: "w1", prompt: "go" },
      })
      .add({ taskId: "t1", kind: "Failed", by: "w1", payload: { workerId: "w1", error: "boom" } })
      .add({ taskId: "t1", kind: "Question", by: RUNTIME, payload: { why: "boom" } })
      .add({
        taskId: "t1",
        kind: "Reply",
        by: ANN,
        source: "0041 was reverted",
        payload: { text: "rebase and retry" },
      });

    expect(shape(run(ledger))).toEqual([
      { type: "append", taskId: "t1", kind: "Started" },
      { type: "launch", taskId: "t1", workerId: "w1" },
    ]);
  });
});

describe("reconcile: the age cap", () => {
  it("declares a silent worker lost and retries it in the same pass", () => {
    const ledger = working();
    const fourHoursOn = new Date(ledger.now().getTime() + 4 * 3_600_000);

    const actions = run(ledger, { now: fourHoursOn });
    expect(shape(actions)).toEqual([
      { type: "append", taskId: "t1", kind: "Lost" },
      { type: "append", taskId: "t1", kind: "Started" },
      { type: "launch", taskId: "t1", workerId: "w1" },
    ]);
    const lost = actions[0];
    if (lost.type !== "append" || lost.fact.kind !== "Lost") throw new Error("expected Lost");
    expect(lost.fact.payload).toEqual({ workerId: "w0", why: LOST_SILENT });
  });

  it("leaves a worker inside the cap alone", () => {
    const ledger = working();
    const twoHoursOn = new Date(ledger.now().getTime() + 2 * 3_600_000);
    expect(shape(run(ledger, { now: twoHoursOn }))).toEqual([]);
  });

  it("frees the slot the lost worker held", () => {
    const ledger = working("t1", "w0");
    ledger.add({ taskId: "t2", kind: "Created", by: ANN, source: "b", payload: { brief: "b" } });
    const fourHoursOn = new Date(ledger.now().getTime() + 4 * 3_600_000);

    expect(shape(run(ledger, { now: fourHoursOn, config: { maxWorkers: 1 } }))).toEqual([
      { type: "append", taskId: "t1", kind: "Lost" },
      { type: "append", taskId: "t1", kind: "Started" },
      { type: "launch", taskId: "t1", workerId: "w1" },
    ]);
  });
});

describe("reconcile: steering", () => {
  it("stops the running worker and starts one that can read the reply", () => {
    const ledger = working().add({
      taskId: "t1",
      kind: "Reply",
      by: ANN,
      source: "use the token bucket",
      payload: { text: "use the token bucket" },
    });

    const actions = run(ledger);
    expect(shape(actions)).toEqual([
      { type: "stop", taskId: "t1", workerId: "w0" },
      { type: "append", taskId: "t1", kind: "Started" },
      { type: "launch", taskId: "t1", workerId: "w1" },
    ]);
    const started = actions[1];
    if (started.type !== "append" || started.fact.kind !== "Started")
      throw new Error("expected Started");
    expect(started.fact.payload.prompt).toContain("use the token bucket");
  });

  it("just starts when no worker is running", () => {
    const ledger = working()
      .add({
        taskId: "t1",
        kind: "Returned",
        by: "w0",
        payload: { workerId: "w0", reply: "PR 88" },
      })
      .add({
        taskId: "t1",
        kind: "Report",
        by: RUNTIME,
        payload: { what: "PR 88", evidence: "worker w0" },
      })
      .add({
        taskId: "t1",
        kind: "Reply",
        by: ANN,
        source: "also add a test",
        payload: { text: "also add a test" },
      });

    expect(shape(run(ledger))).toEqual([
      { type: "append", taskId: "t1", kind: "Started" },
      { type: "launch", taskId: "t1", workerId: "w1" },
    ]);
  });
});

describe("reconcile: a person ends the task", () => {
  it("stops the live worker and writes nothing", () => {
    const ledger = working().add({
      taskId: "t1",
      kind: "Cancelled",
      by: ANN,
      source: "closed the issue as not planned",
      payload: { reason: "not planned" },
    });

    expect(shape(run(ledger))).toEqual([{ type: "stop", taskId: "t1", workerId: "w0" }]);
    const stop = run(ledger)[0];
    if (stop.type !== "stop") throw new Error("expected a stop");
    expect(stop.why).toBe(LOST_STOPPED);
  });

  it("does nothing at all once the worker is closed", () => {
    const ledger = working()
      .add({ taskId: "t1", kind: "Completed", by: "bob", source: "merged 88", payload: {} })
      .add({
        taskId: "t1",
        kind: "Lost",
        by: RUNTIME,
        payload: { workerId: "w0", why: LOST_STOPPED },
      });

    expect(shape(run(ledger))).toEqual([]);
  });
});

describe("reconcile: the host died between two writes", () => {
  it("finishes the list the dead pass started, and duplicates nothing", () => {
    const ledger = new LedgerBuilder()
      .add({
        taskId: "t3",
        kind: "Created",
        by: ANN,
        source: "issue 3",
        payload: { brief: "three" },
      })
      .add({
        taskId: "t4",
        kind: "Created",
        by: ANN,
        source: "issue 4",
        payload: { brief: "four" },
      })
      .add({ taskId: "t3", kind: "Taken", by: RUNTIME, payload: {} });

    expect(shape(run(ledger))).toEqual([
      { type: "append", taskId: "t3", kind: "Started" },
      { type: "launch", taskId: "t3", workerId: "w1" },
      { type: "append", taskId: "t4", kind: "Taken" },
      { type: "append", taskId: "t4", kind: "Started" },
      { type: "launch", taskId: "t4", workerId: "w2" },
    ]);
  });
});
