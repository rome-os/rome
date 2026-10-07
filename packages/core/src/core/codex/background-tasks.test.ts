import { describe, expect, it } from "@rstest/core";
import type { ModelBackgroundTaskEvent } from "../agent-runner.js";
import { Notify } from "./app-server-protocol.js";
import { CodexBackgroundTaskTracker } from "./background-tasks.js";

// Synthetic notifications in the shapes app-server 0.156.1 sent in a live
// probe: a background shell stays `inProgress` past `turn/completed` and
// ends with a late `item/completed` tagged with its finished turn; a
// sub-agent is a `started` and later a `completed` `subAgentActivity` item.

function shellStarted(id: string, turnId: string) {
  return [
    Notify.itemStarted,
    {
      threadId: "t",
      turnId,
      startedAtMs: 0,
      item: {
        type: "commandExecution",
        id,
        command: `sleep ${id}`,
        status: "inProgress",
        source: "unifiedExecStartup",
        processId: "17",
      },
    },
  ] as const;
}

function shellCompleted(id: string, turnId: string, exitCode: number, status = "completed") {
  return [
    Notify.itemCompleted,
    {
      threadId: "t",
      turnId,
      completedAtMs: 0,
      item: {
        type: "commandExecution",
        id,
        command: `sleep ${id}`,
        status,
        exitCode,
        aggregatedOutput: `out ${id}`,
      },
    },
  ] as const;
}

function subAgent(kind: string, agentThreadId: string, turnId: string) {
  return [
    Notify.itemCompleted,
    {
      threadId: "t",
      turnId,
      completedAtMs: 0,
      item: {
        type: "subAgentActivity",
        id: kind === "started" ? `call-${agentThreadId}` : `subagent-completed-${agentThreadId}`,
        kind,
        agentThreadId,
        agentPath: `/root/${agentThreadId}`,
      },
    },
  ] as const;
}

function turnCompleted(turnId: string) {
  return [
    Notify.turnCompleted,
    { threadId: "t", turn: { id: turnId, status: "completed" } },
  ] as const;
}

function run(
  tracker: CodexBackgroundTaskTracker,
  notifications: readonly (readonly [string, unknown])[],
): string[] {
  return notifications.flatMap(([method, params]) => tracker.observe(method, params)).map(view);
}

function view(event: ModelBackgroundTaskEvent): string {
  return event.type === "background_tasks"
    ? `tasks [${event.tasks.map((task) => `${task.id}:${task.kind}`).join(",")}]`
    : `ended ${event.end.id} ${event.end.status}`;
}

describe("CodexBackgroundTaskTracker", () => {
  it("makes a shell still running at turn end a background task, ended by its late completion", () => {
    const tracker = new CodexBackgroundTaskTracker();
    expect(
      run(tracker, [
        shellStarted("s1", "turn-1"),
        turnCompleted("turn-1"),
        shellCompleted("s1", "turn-1", 0),
      ]),
    ).toEqual(["tasks [s1:shell]", "ended s1 completed", "tasks []"]);
  });

  it("reports nothing for a shell that ends inside its turn", () => {
    const tracker = new CodexBackgroundTaskTracker();
    expect(
      run(tracker, [
        shellStarted("s1", "turn-1"),
        shellCompleted("s1", "turn-1", 0),
        turnCompleted("turn-1"),
      ]),
    ).toEqual([]);
  });

  it("reports a shell's failure with its exit code and output", () => {
    const tracker = new CodexBackgroundTaskTracker();
    const events = [
      shellStarted("s1", "turn-1"),
      turnCompleted("turn-1"),
      shellCompleted("s1", "turn-1", 2, "failed"),
    ].flatMap(([method, params]) => tracker.observe(method, params));
    expect(events.find((event) => event.type === "background_task_end")).toEqual({
      type: "background_task_end",
      end: { id: "s1", status: "failed", summary: "out s1", raw: "failed:2" },
    });
  });

  it("makes a sub-agent a background task keyed by its thread", () => {
    const tracker = new CodexBackgroundTaskTracker();
    expect(
      run(tracker, [
        subAgent("started", "child", "turn-1"),
        turnCompleted("turn-1"),
        subAgent("completed", "child", "turn-1"),
      ]),
    ).toEqual(["tasks [child:agent]", "ended child completed", "tasks []"]);
    expect(tracker.current).toEqual([]);
  });

  it("reports an interrupted sub-agent", () => {
    const tracker = new CodexBackgroundTaskTracker();
    expect(
      run(tracker, [
        subAgent("started", "child", "turn-1"),
        turnCompleted("turn-1"),
        subAgent("interrupted", "child", "turn-1"),
      ]),
    ).toContain("ended child interrupted");
  });

  it("promotes only the work of the turn that completed, and keeps earlier tasks", () => {
    const tracker = new CodexBackgroundTaskTracker();
    expect(
      run(tracker, [
        shellStarted("s1", "turn-1"),
        turnCompleted("turn-1"),
        shellStarted("s2", "turn-2"),
        turnCompleted("turn-1"),
        turnCompleted("turn-2"),
      ]),
    ).toEqual(["tasks [s1:shell]", "tasks [s1:shell,s2:shell]"]);
    expect(tracker.current.map((task) => task.description)).toEqual(["sleep s1", "sleep s2"]);
  });

  it("loses every task when the app-server exits", () => {
    const tracker = new CodexBackgroundTaskTracker();
    run(tracker, [
      shellStarted("s1", "turn-1"),
      subAgent("started", "child", "turn-1"),
      turnCompleted("turn-1"),
    ]);
    expect(tracker.lost().map(view)).toEqual(["ended s1 lost", "ended child lost", "tasks []"]);
    expect(tracker.lost()).toEqual([]);
  });

  it("ignores other notifications", () => {
    const tracker = new CodexBackgroundTaskTracker();
    expect(
      tracker.observe(Notify.itemCompleted, {
        threadId: "t",
        turnId: "turn-1",
        completedAtMs: 0,
        item: { type: "agentMessage", id: "m", text: "hi" },
      }),
    ).toEqual([]);
    expect(tracker.observe(Notify.turnStarted, { threadId: "t", turn: { id: "turn-1" } })).toEqual(
      [],
    );
  });

  it("follows a finished sub-agent that a follow-up restarts, through the child's own turns", () => {
    const tracker = new CodexBackgroundTaskTracker();
    const events = run(tracker, [
      [Notify.turnStarted, { threadId: "t", turn: { id: "turn-1" } }],
      subAgent("started", "child", "turn-1"),
      subAgent("completed", "child", "turn-1"),
      subAgent("interacted", "child", "turn-1"),
      turnCompleted("turn-1"),
    ]);
    expect(events).toEqual([]);
    const child = (method: string, turn: Record<string, unknown>) =>
      tracker.observeChildThread(method, { threadId: "child", turn }).map(view);
    expect(child(Notify.turnStarted, { id: "c-2" })).toEqual(["tasks [child:agent]"]);
    expect(child(Notify.turnCompleted, { id: "c-2", status: "failed" })).toEqual([
      "ended child failed",
      "tasks []",
    ]);
  });

  it("does not count a message to an idle sub-agent as running work", () => {
    const tracker = new CodexBackgroundTaskTracker();
    expect(
      run(tracker, [
        subAgent("started", "child", "turn-1"),
        subAgent("completed", "child", "turn-1"),
        turnCompleted("turn-1"),
        [Notify.turnStarted, { threadId: "t", turn: { id: "turn-2" } }],
        subAgent("interacted", "child", "turn-2"),
        turnCompleted("turn-2"),
      ]),
    ).toEqual([]);
  });

  it("promotes a sub-agent restarted inside a turn when that turn ends", () => {
    const tracker = new CodexBackgroundTaskTracker();
    run(tracker, [
      subAgent("started", "child", "turn-1"),
      subAgent("completed", "child", "turn-1"),
    ]);
    tracker.observe(Notify.turnStarted, { threadId: "t", turn: { id: "turn-2" } });
    expect(
      tracker.observeChildThread(Notify.turnStarted, { threadId: "child", turn: { id: "c" } }),
    ).toEqual([]);
    expect(run(tracker, [turnCompleted("turn-2")])).toEqual(["tasks [child:agent]"]);
  });

  it("ignores other threads' turns", () => {
    const tracker = new CodexBackgroundTaskTracker();
    expect(
      tracker.observeChildThread(Notify.turnStarted, { threadId: "stranger", turn: { id: "x" } }),
    ).toEqual([]);
  });

  it("leaves out the work of an ignored turn, including its late ends", () => {
    const tracker = new CodexBackgroundTaskTracker();
    tracker.ignoreTurn("fork");
    expect(
      run(tracker, [
        [Notify.turnStarted, { threadId: "t", turn: { id: "fork" } }],
        shellStarted("s1", "fork"),
        subAgent("started", "child", "fork"),
        turnCompleted("fork"),
        shellCompleted("s1", "fork", 0),
      ]),
    ).toEqual([]);
    expect(
      tracker.observeChildThread(Notify.turnStarted, { threadId: "child", turn: { id: "c" } }),
    ).toEqual([]);
  });

  it("counts each activity item once, though it arrives as both item edges", () => {
    const tracker = new CodexBackgroundTaskTracker();
    const [, completed] = subAgent("started", "child", "turn-1");
    const started = [Notify.itemStarted, completed] as const;
    expect(run(tracker, [started])).toEqual([]);
    // The child fails between the spawn item's two edges.
    const child = (method: string, turn: Record<string, unknown>) =>
      tracker.observeChildThread(method, { threadId: "child", turn });
    child(Notify.turnStarted, { id: "c-1" });
    child(Notify.turnCompleted, { id: "c-1", status: "failed" });
    expect(run(tracker, [subAgent("started", "child", "turn-1"), turnCompleted("turn-1")])).toEqual(
      [],
    );
    expect(tracker.current).toEqual([]);
  });

  it("keeps a restarted sub-agent when its previous turn's completion arrives late", () => {
    const tracker = new CodexBackgroundTaskTracker();
    run(tracker, [subAgent("started", "child", "turn-1")]);
    const child = (method: string, turn: Record<string, unknown>) =>
      tracker.observeChildThread(method, { threadId: "child", turn }).map(view);
    child(Notify.turnStarted, { id: "c-1" });
    child(Notify.turnCompleted, { id: "c-1", status: "completed" });
    run(tracker, [turnCompleted("turn-1")]);
    expect(child(Notify.turnStarted, { id: "c-2" })).toEqual(["tasks [child:agent]"]);
    expect(run(tracker, [subAgent("completed", "child", "turn-1")])).toEqual([]);
    expect(child(Notify.turnCompleted, { id: "c-1", status: "completed" })).toEqual([]);
    expect(child(Notify.turnCompleted, { id: "c-2", status: "completed" })).toEqual([
      "ended child completed",
      "tasks []",
    ]);
  });

  it("keeps a child that failed before its spawn item out of the set", () => {
    const tracker = new CodexBackgroundTaskTracker();
    const child = (method: string, turn: Record<string, unknown>) =>
      tracker.observeChildThread(method, { threadId: "child", turn });
    tracker.observe(Notify.turnStarted, { threadId: "t", turn: { id: "turn-1" } });
    child(Notify.turnStarted, { id: "c-1" });
    child(Notify.turnCompleted, { id: "c-1", status: "failed" });
    expect(run(tracker, [subAgent("started", "child", "turn-1"), turnCompleted("turn-1")])).toEqual(
      [],
    );
  });

  it("counts a child whose first turn started before its spawn item", () => {
    const tracker = new CodexBackgroundTaskTracker();
    tracker.observe(Notify.turnStarted, { threadId: "t", turn: { id: "turn-1" } });
    tracker.observeChildThread(Notify.turnStarted, { threadId: "child", turn: { id: "c-1" } });
    expect(run(tracker, [subAgent("started", "child", "turn-1"), turnCompleted("turn-1")])).toEqual(
      ["tasks [child:agent]"],
    );
    expect(
      tracker
        .observeChildThread(Notify.turnCompleted, {
          threadId: "child",
          turn: { id: "c-1", status: "completed" },
        })
        .map(view),
    ).toEqual(["ended child completed", "tasks []"]);
  });

  it("discovers an earlier session's child through a follow-up on a resumed thread", () => {
    const tracker = new CodexBackgroundTaskTracker();
    const child = (method: string, turn: Record<string, unknown>) =>
      tracker.observeChildThread(method, { threadId: "old-child", turn }).map(view);
    tracker.observe(Notify.turnStarted, { threadId: "t", turn: { id: "turn-1" } });
    run(tracker, [subAgent("interacted", "old-child", "turn-1")]);
    expect(child(Notify.turnStarted, { id: "c-9" })).toEqual([]);
    expect(run(tracker, [turnCompleted("turn-1")])).toEqual(["tasks [old-child:agent]"]);
    expect(child(Notify.turnCompleted, { id: "c-9", status: "completed" })).toEqual([
      "ended old-child completed",
      "tasks []",
    ]);
  });

  it("discovers a followed-up child whose turn started before the follow-up item", () => {
    const tracker = new CodexBackgroundTaskTracker();
    tracker.observe(Notify.turnStarted, { threadId: "t", turn: { id: "turn-1" } });
    tracker.observeChildThread(Notify.turnStarted, { threadId: "old-child", turn: { id: "c-9" } });
    expect(
      run(tracker, [subAgent("interacted", "old-child", "turn-1"), turnCompleted("turn-1")]),
    ).toEqual(["tasks [old-child:agent]"]);
  });

  it("does not count a message to an earlier session's idle child", () => {
    const tracker = new CodexBackgroundTaskTracker();
    tracker.observe(Notify.turnStarted, { threadId: "t", turn: { id: "turn-1" } });
    expect(
      run(tracker, [subAgent("interacted", "old-child", "turn-1"), turnCompleted("turn-1")]),
    ).toEqual([]);
  });
});
