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
});
