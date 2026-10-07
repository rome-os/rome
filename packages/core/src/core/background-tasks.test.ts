import { describe, expect, it } from "@rstest/core";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ModelBackgroundTaskEvent } from "./agent-runner.js";
import { BackgroundTaskTracker, claudeTaskEndStatus, claudeTaskKind } from "./background-tasks.js";

function level(...tasks: { id: string; type?: string; ambient?: boolean }[]): SDKMessage {
  return {
    type: "system",
    subtype: "background_tasks_changed",
    tasks: tasks.map((task) => ({
      task_id: task.id,
      task_type: task.type ?? "local_bash",
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

function ids(events: ModelBackgroundTaskEvent[]): string[][] {
  return events.flatMap((event) =>
    event.type === "background_tasks" ? [event.tasks.map((task) => task.id)] : [],
  );
}

describe("BackgroundTaskTracker", () => {
  it("replaces the set on each level signal and leaves out ambient tasks", () => {
    const tracker = new BackgroundTaskTracker();
    const events = [
      level({ id: "a" }, { id: "w", ambient: true }),
      level({ id: "a" }, { id: "b" }),
      level({ id: "b" }),
    ].flatMap((message) => tracker.observe(message));
    expect(ids(events)).toEqual([["a"], ["a", "b"], ["b"]]);
    expect(tracker.current).toEqual([
      {
        id: "b",
        kind: "shell",
        description: "task b",
        seenAt: expect.any(Number),
        raw: "local_bash",
      },
    ]);
  });

  it("keeps when a task was first seen, and reports no change for the same set", () => {
    const tracker = new BackgroundTaskTracker();
    const first = tracker.observe(level({ id: "a" }));
    const firstSeen = tracker.current[0]?.seenAt;
    const rest = [
      level({ id: "a" }, { id: "w", ambient: true }),
      level({ id: "a" }, { id: "b" }),
    ].flatMap((message) => tracker.observe(message));
    expect(ids([...first, ...rest])).toEqual([["a"], ["a", "b"]]);
    expect(tracker.current[0]?.seenAt).toBe(firstSeen);
  });

  it("reports no change for the same set in a different order", () => {
    const tracker = new BackgroundTaskTracker();
    tracker.observe(level({ id: "a" }, { id: "b" }));
    expect(tracker.observe(level({ id: "b" }, { id: "a" }))).toEqual([]);
  });

  it("reports a change of description or type for the same tasks", () => {
    const tracker = new BackgroundTaskTracker();
    tracker.observe(level({ id: "a" }));
    const renamed = level({ id: "a" }) as unknown as {
      tasks: { description: string; task_type: string }[];
    };
    renamed.tasks[0]!.description = "renamed";
    const afterRename = tracker.observe(renamed as unknown as SDKMessage);
    renamed.tasks[0]!.task_type = "local_agent";
    const afterRetype = tracker.observe(renamed as unknown as SDKMessage);
    expect(
      [...afterRename, ...afterRetype].map((event) =>
        event.type === "background_tasks"
          ? [event.tasks[0]?.description, event.tasks[0]?.kind]
          : [],
      ),
    ).toEqual([
      ["renamed", "shell"],
      ["renamed", "agent"],
    ]);
  });

  it("reports each end in Rome's words, but not an ambient one", () => {
    const tracker = new BackgroundTaskTracker();
    const events = [
      ended("a"),
      ended("f", { status: "failed" }),
      ended("s", { status: "stopped" }),
      ended("b", { status: "stopped", reason: "worker_restart" }),
      ended("w", { ambient: true }),
    ].flatMap((message) => tracker.observe(message));
    expect(events).toEqual([
      {
        type: "background_task_end",
        end: { id: "a", status: "completed", summary: "done a", raw: "completed" },
      },
      {
        type: "background_task_end",
        end: { id: "f", status: "failed", summary: "done f", raw: "failed" },
      },
      {
        type: "background_task_end",
        end: { id: "s", status: "interrupted", summary: "done s", raw: "stopped" },
      },
      {
        type: "background_task_end",
        end: { id: "b", status: "lost", summary: "done b", raw: "stopped:worker_restart" },
      },
    ]);
  });

  it("ignores other messages", () => {
    const tracker = new BackgroundTaskTracker();
    expect(tracker.observe({ type: "assistant" } as unknown as SDKMessage)).toEqual([]);
    expect(tracker.observe({ type: "system", subtype: "init" } as unknown as SDKMessage)).toEqual(
      [],
    );
  });
});

describe("Claude task mapping", () => {
  it("maps task types to kinds", () => {
    expect(claudeTaskKind("local_bash")).toBe("shell");
    expect(claudeTaskKind("local_agent")).toBe("agent");
    expect(claudeTaskKind("remote_agent")).toBe("agent");
    expect(claudeTaskKind("in_process_teammate")).toBe("agent");
    expect(claudeTaskKind("local_workflow")).toBe("other");
    expect(claudeTaskKind("mcp_task")).toBe("other");
  });

  it("maps end statuses, with a worker restart as lost", () => {
    expect(claudeTaskEndStatus("completed", undefined)).toBe("completed");
    expect(claudeTaskEndStatus("failed", undefined)).toBe("failed");
    expect(claudeTaskEndStatus("stopped", undefined)).toBe("interrupted");
    expect(claudeTaskEndStatus("stopped", "worker_restart")).toBe("lost");
  });
});
