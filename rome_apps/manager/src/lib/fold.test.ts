import { describe, expect, it } from "@rstest/core";
import { RUNTIME } from "./facts.js";
import { fold, foldTask, MalformedTaskError } from "./fold.js";
import { LedgerBuilder } from "./test-facts.js";

const ANN = "ann";

function created(taskId = "t1") {
  return new LedgerBuilder().add({
    taskId,
    kind: "Created",
    by: ANN,
    source: "add rate limiting",
    payload: { brief: "add rate limiting to the upload endpoint" },
  });
}

describe("foldTask", () => {
  it("reads the brief and the opening state off the Created fact", () => {
    const task = foldTask(created().facts);
    expect(task.id).toBe("t1");
    expect(task.brief).toBe("add rate limiting to the upload endpoint");
    expect(task.state).toBe("created");
    expect(task.position).toBeUndefined();
  });

  it("refuses facts that open no task", () => {
    const ledger = new LedgerBuilder().add({
      taskId: "t1",
      kind: "Taken",
      by: RUNTIME,
      payload: {},
    });
    expect(() => foldTask(ledger.facts)).toThrow(MalformedTaskError);
  });

  it("has no position on a Taken task until the runtime writes past Taken", () => {
    const task = foldTask(
      created().add({ taskId: "t1", kind: "Taken", by: RUNTIME, payload: {} }).facts,
    );
    expect(task.state).toBe("taken");
    expect(task.position).toBeUndefined();
  });

  it("is working while a Started is the runtime's last word", () => {
    const task = foldTask(
      created()
        .add({ taskId: "t1", kind: "Taken", by: RUNTIME, payload: {} })
        .add({
          taskId: "t1",
          kind: "Started",
          by: RUNTIME,
          payload: { workerId: "w1", prompt: "go" },
        }).facts,
    );
    expect(task.position).toBe("working");
    expect(task.liveWorker?.workerId).toBe("w1");
  });

  it("is stuck on a Question and reported on a Report", () => {
    const stuck = created()
      .add({ taskId: "t1", kind: "Taken", by: RUNTIME, payload: {} })
      .add({
        taskId: "t1",
        kind: "Started",
        by: RUNTIME,
        payload: { workerId: "w1", prompt: "go" },
      })
      .add({ taskId: "t1", kind: "Failed", by: "w1", payload: { workerId: "w1", error: "boom" } })
      .add({ taskId: "t1", kind: "Question", by: RUNTIME, payload: { why: "boom" } });
    expect(foldTask(stuck.facts).position).toBe("stuck");

    const reported = created()
      .add({ taskId: "t1", kind: "Taken", by: RUNTIME, payload: {} })
      .add({
        taskId: "t1",
        kind: "Started",
        by: RUNTIME,
        payload: { workerId: "w1", prompt: "go" },
      })
      .add({
        taskId: "t1",
        kind: "Returned",
        by: "w1",
        payload: { workerId: "w1", reply: "PR 88" },
      })
      .add({
        taskId: "t1",
        kind: "Report",
        by: RUNTIME,
        payload: { what: "PR 88", evidence: "worker w1" },
      });
    expect(foldTask(reported.facts).position).toBe("reported");
  });

  it("clears the live worker on the terminal fact that names it", () => {
    const ledger = created()
      .add({ taskId: "t1", kind: "Taken", by: RUNTIME, payload: {} })
      .add({
        taskId: "t1",
        kind: "Started",
        by: RUNTIME,
        payload: { workerId: "w1", prompt: "go" },
      })
      .add({
        taskId: "t1",
        kind: "Returned",
        by: "w1",
        payload: { workerId: "w1", reply: "done" },
      });
    expect(foldTask(ledger.facts).liveWorker).toBeUndefined();
  });

  it("keeps the live worker when a terminal fact names an older one", () => {
    const ledger = created()
      .add({ taskId: "t1", kind: "Taken", by: RUNTIME, payload: {} })
      .add({
        taskId: "t1",
        kind: "Started",
        by: RUNTIME,
        payload: { workerId: "w1", prompt: "go" },
      })
      .add({
        taskId: "t1",
        kind: "Lost",
        by: RUNTIME,
        payload: { workerId: "w1", why: "stopped by runtime" },
      })
      .add({
        taskId: "t1",
        kind: "Started",
        by: RUNTIME,
        payload: { workerId: "w2", prompt: "go again" },
      })
      .add({ taskId: "t1", kind: "Failed", by: "w1", payload: { workerId: "w1", error: "late" } });
    expect(foldTask(ledger.facts).liveWorker?.workerId).toBe("w2");
  });

  it("counts starts from the newest fact a person wrote", () => {
    const ledger = created()
      .add({ taskId: "t1", kind: "Taken", by: RUNTIME, payload: {} })
      .add({
        taskId: "t1",
        kind: "Started",
        by: RUNTIME,
        payload: { workerId: "w1", prompt: "go" },
      })
      .add({ taskId: "t1", kind: "Failed", by: "w1", payload: { workerId: "w1", error: "boom" } })
      .add({
        taskId: "t1",
        kind: "Started",
        by: RUNTIME,
        payload: { workerId: "w2", prompt: "go" },
      })
      .add({ taskId: "t1", kind: "Failed", by: "w2", payload: { workerId: "w2", error: "boom" } });
    expect(foldTask(ledger.facts).startsSinceLastPersonFact).toBe(2);

    ledger.add({
      taskId: "t1",
      kind: "Reply",
      by: ANN,
      source: "0041 was reverted",
      payload: { text: "rebase" },
    });
    expect(foldTask(ledger.facts).startsSinceLastPersonFact).toBe(0);
  });

  it("ends the task on a person's Completed and drops the position", () => {
    const ledger = created()
      .add({ taskId: "t1", kind: "Taken", by: RUNTIME, payload: {} })
      .add({
        taskId: "t1",
        kind: "Started",
        by: RUNTIME,
        payload: { workerId: "w1", prompt: "go" },
      })
      .add({ taskId: "t1", kind: "Completed", by: "bob", source: "merged 88", payload: {} });
    const task = foldTask(ledger.facts);
    expect(task.state).toBe("completed");
    expect(task.position).toBeUndefined();
    expect(task.liveWorker?.workerId).toBe("w1");
  });

  it("orders by the ledger's seq, not by arrival", () => {
    const ledger = created().add({ taskId: "t1", kind: "Taken", by: RUNTIME, payload: {} });
    const shuffled = [ledger.facts[1], ledger.facts[0]];
    expect(foldTask(shuffled).latest.kind).toBe("Taken");
  });
});

describe("fold", () => {
  it("splits facts by task and orders tasks oldest first", () => {
    const ledger = new LedgerBuilder()
      .add({ taskId: "t1", kind: "Created", by: ANN, source: "one", payload: { brief: "one" } })
      .add({ taskId: "t2", kind: "Created", by: ANN, source: "two", payload: { brief: "two" } })
      .add({ taskId: "t1", kind: "Taken", by: RUNTIME, payload: {} });

    const snapshot = fold(ledger.now(), ledger.facts);
    expect(snapshot.tasks.map((task) => task.id)).toEqual(["t1", "t2"]);
    expect(snapshot.tasks[0].state).toBe("taken");
    expect(snapshot.tasks[1].state).toBe("created");
  });
});
