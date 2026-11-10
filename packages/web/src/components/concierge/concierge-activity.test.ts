import { describe, expect, it } from "@rstest/core";
import type { TraceEventDto, TraceSegment, TraceSnapshot } from "@rome/api-types/trace-segments";
import {
  conciergeActivity,
  type ConciergeActivityInput,
  openToolOf,
  type TaskChatActivity,
  toolActivityOf,
} from "./concierge-activity";

const app = { id: "core", label: "Core" };

const use = (tool: string, id?: string): TraceEventDto => ({
  type: "tool_use",
  tool,
  input: {},
  ...(id ? { id } : {}),
});
const result = (tool: string, toolUseId?: string): TraceEventDto => ({
  type: "tool_result",
  tool,
  output: "",
  ...(toolUseId ? { toolUseId } : {}),
});

function snapshot(...blocks: TraceEventDto[]): TraceSnapshot {
  const segments: TraceSegment[] = blocks.map((block, ordinal) => ({
    kind: "block",
    id: `b${ordinal}`,
    block,
    ordinal,
  }));
  return { segments, summary: { distinctApps: [], totalSteps: 0, invocationCounts: {} } };
}

const task = (extra: Partial<TaskChatActivity> = {}): TaskChatActivity => ({
  title: "Book the flight",
  running: false,
  awaitingGuardian: false,
  updatedAt: 1,
  ...extra,
});

const input = (extra: Partial<ConciergeActivityInput> = {}): ConciergeActivityInput => ({
  streaming: false,
  awaitingGuardian: false,
  snapshot: null,
  tasks: [],
  ...extra,
});

describe("openToolOf", () => {
  it("is null without a trace or with no call in it", () => {
    expect(openToolOf(null)).toBeNull();
    expect(openToolOf(snapshot({ type: "text", content: "hi" } as TraceEventDto))).toBeNull();
  });

  it("is the latest call whose result has not arrived", () => {
    expect(openToolOf(snapshot(use("core:say", "a"), use("core:chat_start", "b")))).toBe(
      "core:chat_start",
    );
  });

  it("is null once the call's result arrives", () => {
    expect(openToolOf(snapshot(use("core:chat_start", "a"), result("core:chat_start", "a")))).toBe(
      null,
    );
  });

  it("is an earlier call still open when a later one finished", () => {
    expect(
      openToolOf(
        snapshot(use("core:chat_read", "a"), use("core:say", "b"), result("core:say", "b")),
      ),
    ).toBe("core:chat_read");
  });

  it("closes a call without an id at the next result without one", () => {
    expect(openToolOf(snapshot(use("core:chat_start")))).toBe("core:chat_start");
    expect(openToolOf(snapshot(use("core:chat_start"), result("core:chat_start")))).toBeNull();
  });

  it("reads the calls inside a run, in the segments' order", () => {
    const run: TraceSegment = {
      kind: "run",
      id: "r",
      app,
      count: 2,
      blocks: [
        use("core:task_upsert", "a"),
        result("core:task_upsert", "a"),
        use("core:chat_start", "b"),
      ],
      ordinal: 1,
    };
    const earlier: TraceSegment = {
      kind: "block",
      id: "x",
      block: use("core:say", "z"),
      ordinal: 0,
    };
    const trace: TraceSnapshot = {
      segments: [run, earlier],
      summary: { distinctApps: [], totalSteps: 0, invocationCounts: {} },
    };
    expect(openToolOf(trace)).toBe("core:chat_start");
  });
});

describe("toolActivityOf", () => {
  it("names a tool whatever its provider or group prefix", () => {
    expect(toolActivityOf("chat_start")).toBe("startingTask");
    expect(toolActivityOf("core:chat_start")).toBe("startingTask");
    expect(toolActivityOf("mcp__rome__chat_start")).toBe("startingTask");
    expect(toolActivityOf("mcp__rome-core__core:task_upsert")).toBe("updatingTasks");
    expect(toolActivityOf("WebSearch")).toBe("searchingWeb");
  });

  it("names no tool the guardian sees as the reply itself", () => {
    expect(toolActivityOf("core:say")).toBeNull();
    expect(toolActivityOf("Read")).toBeNull();
  });
});

describe("conciergeActivity", () => {
  it("is idle when nothing runs or waits", () => {
    expect(conciergeActivity(input())).toEqual({ kind: "idle" });
    expect(conciergeActivity(input({ tasks: [task()] }))).toEqual({ kind: "idle" });
  });

  it("puts a card waiting here ahead of the chat's own turn", () => {
    expect(
      conciergeActivity(
        input({
          streaming: true,
          awaitingGuardian: true,
          snapshot: snapshot(use("core:chat_start", "a")),
        }),
      ),
    ).toEqual({ kind: "needsYou" });
  });

  it("puts a card waiting in a task chat ahead of everything else", () => {
    expect(
      conciergeActivity(
        input({
          streaming: true,
          tasks: [task({ running: true }), task({ title: "Ask", awaitingGuardian: true })],
        }),
      ),
    ).toEqual({ kind: "needsYou" });
  });

  it("names the tool the turn is in", () => {
    expect(
      conciergeActivity(
        input({ streaming: true, snapshot: snapshot(use("mcp__rome__chat_start", "a")) }),
      ),
    ).toEqual({ kind: "tool", tool: "startingTask" });
  });

  it("says plain work in a tool it does not name, and once the tool's result arrives", () => {
    expect(
      conciergeActivity(input({ streaming: true, snapshot: snapshot(use("core:say", "a")) })),
    ).toEqual({ kind: "working" });
    expect(
      conciergeActivity(
        input({
          streaming: true,
          snapshot: snapshot(use("core:chat_start", "a"), result("core:chat_start", "a")),
        }),
      ),
    ).toEqual({ kind: "working" });
    expect(conciergeActivity(input({ streaming: true }))).toEqual({ kind: "working" });
  });

  it("puts its own turn ahead of the task chats that run", () => {
    expect(conciergeActivity(input({ streaming: true, tasks: [task({ running: true })] }))).toEqual(
      { kind: "working" },
    );
  });

  it("names a running task chat once its own turn ends", () => {
    expect(conciergeActivity(input({ tasks: [task({ running: true })] }))).toEqual({
      kind: "tasks",
      title: "Book the flight",
      more: 0,
    });
  });

  it("leads with the newest of several running task chats and counts the rest", () => {
    expect(
      conciergeActivity(
        input({
          tasks: [
            task({ title: "Old", running: true, updatedAt: 1 }),
            task({ title: "Newest", running: true, updatedAt: 3 }),
            task({ title: "Stopped", running: false, updatedAt: 9 }),
            task({ title: "Middle", running: true, updatedAt: 2 }),
          ],
        }),
      ),
    ).toEqual({ kind: "tasks", title: "Newest", more: 2 });
  });
});
