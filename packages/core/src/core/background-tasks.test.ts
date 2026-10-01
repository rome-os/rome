import { describe, expect, it } from "@rstest/core";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ModelBackgroundTask, ModelBackgroundTaskEnd } from "./agent-runner.js";
import { BackgroundTaskTracker } from "./background-tasks.js";

function level(...tasks: { id: string; ambient?: boolean }[]): SDKMessage {
  return {
    type: "system",
    subtype: "background_tasks_changed",
    tasks: tasks.map((task) => ({
      task_id: task.id,
      task_type: "local_bash",
      description: `task ${task.id}`,
      ...(task.ambient ? { ambient: true } : {}),
    })),
  } as unknown as SDKMessage;
}

function ended(id: string, extra: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: id,
    status: "completed",
    output_file: "",
    summary: `done ${id}`,
    ...extra,
  } as unknown as SDKMessage;
}

function follow(tracker: BackgroundTaskTracker) {
  const changes: (readonly ModelBackgroundTask[])[] = [];
  const ends: ModelBackgroundTaskEnd[] = [];
  tracker.subscribe({ onChange: (tasks) => changes.push(tasks), onEnd: (end) => ends.push(end) });
  return { changes, ends, ids: () => changes.map((tasks) => tasks.map((task) => task.id)) };
}

describe("BackgroundTaskTracker", () => {
  it("replaces the set on each level signal and leaves out ambient tasks", () => {
    const tracker = new BackgroundTaskTracker();
    const seen = follow(tracker);
    tracker.observe(level({ id: "a" }, { id: "w", ambient: true }));
    tracker.observe(level({ id: "a" }, { id: "b" }));
    tracker.observe(level({ id: "b" }));
    expect(seen.ids()).toEqual([["a"], ["a", "b"], ["b"]]);
    expect(tracker.current).toEqual([
      { id: "b", type: "local_bash", description: "task b", seenAt: expect.any(Number) },
    ]);
  });

  it("keeps when a task was first seen, and reports no change for the same set", () => {
    const tracker = new BackgroundTaskTracker();
    const seen = follow(tracker);
    tracker.observe(level({ id: "a" }));
    const firstSeen = tracker.current[0]?.seenAt;
    tracker.observe(level({ id: "a" }, { id: "w", ambient: true }));
    tracker.observe(level({ id: "a" }, { id: "b" }));
    expect(seen.ids()).toEqual([["a"], ["a", "b"]]);
    expect(tracker.current[0]?.seenAt).toBe(firstSeen);
  });

  it("reports a change of description or type for the same tasks", () => {
    const tracker = new BackgroundTaskTracker();
    const seen = follow(tracker);
    tracker.observe(level({ id: "a" }));
    const renamed = level({ id: "a" }) as unknown as {
      tasks: { description: string; task_type: string }[];
    };
    renamed.tasks[0]!.description = "renamed";
    tracker.observe(renamed as unknown as SDKMessage);
    renamed.tasks[0]!.task_type = "local_agent";
    tracker.observe(renamed as unknown as SDKMessage);
    expect(seen.changes.map((tasks) => [tasks[0]?.description, tasks[0]?.type])).toEqual([
      ["task a", "local_bash"],
      ["renamed", "local_bash"],
      ["renamed", "local_agent"],
    ]);
  });

  it("reports each end, including a worker restart, but not an ambient one", () => {
    const tracker = new BackgroundTaskTracker();
    const seen = follow(tracker);
    tracker.observe(ended("a"));
    tracker.observe(ended("b", { status: "stopped", reason: "worker_restart" }));
    tracker.observe(ended("w", { ambient: true }));
    expect(seen.ends).toEqual([
      { id: "a", status: "completed", summary: "done a" },
      { id: "b", status: "stopped", reason: "worker_restart", summary: "done b" },
    ]);
  });

  it("empties the set on reset", () => {
    const tracker = new BackgroundTaskTracker();
    const seen = follow(tracker);
    tracker.reset();
    tracker.observe(level({ id: "a" }));
    tracker.reset();
    expect(seen.ids()).toEqual([["a"], []]);
  });

  it("ignores other messages, and keeps notifying past a failing listener", () => {
    const tracker = new BackgroundTaskTracker();
    tracker.subscribe({
      onChange: () => {
        throw new Error("boom");
      },
    });
    const seen = follow(tracker);
    tracker.observe({ type: "assistant" } as unknown as SDKMessage);
    tracker.observe(level({ id: "a" }));
    expect(seen.ids()).toEqual([["a"]]);
  });

  it("stops notifying after unsubscribe", () => {
    const tracker = new BackgroundTaskTracker();
    const changes: unknown[] = [];
    const unsubscribe = tracker.subscribe({ onChange: (tasks) => changes.push(tasks) });
    unsubscribe();
    tracker.observe(level({ id: "a" }));
    expect(changes).toEqual([]);
  });
});
