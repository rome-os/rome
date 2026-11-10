import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import {
  type ConciergeActivityEvent,
  type ConciergeActivityFacts,
  conciergeActivity,
  parseConciergeActivity,
  type TaskChatActivityFacts,
  toolActivityOf,
} from "@rome/api-types/concierge-activity";
import {
  type ActivityTaskRow,
  type ConciergeActivitySources,
  ConciergeActivityTracker,
  IDLE_GRACE_MS,
  RECHECK_MS,
  TOOL_HOLD_MS,
} from "./activity.js";

const task = (extra: Partial<TaskChatActivityFacts> = {}): TaskChatActivityFacts => ({
  title: "Book the flight",
  running: false,
  awaitingGuardian: false,
  updatedAt: 1,
  ...extra,
});

const facts = (extra: Partial<ConciergeActivityFacts> = {}): ConciergeActivityFacts => ({
  awaitingGuardian: false,
  turn: { running: false, tool: null },
  reportPending: false,
  tasks: [],
  ...extra,
});

describe("toolActivityOf", () => {
  it("names a tool whatever its provider or group prefix", () => {
    expect(toolActivityOf("chat_start")).toBe("startingTask");
    expect(toolActivityOf("core:chat_start")).toBe("startingTask");
    expect(toolActivityOf("mcp__rome__chat_start")).toBe("startingTask");
    expect(toolActivityOf("mcp__rome-core__core:task_upsert")).toBe("updatingTasks");
    expect(toolActivityOf("WebSearch")).toBe("searchingWeb");
  });

  it("names no tool the owner sees as the reply itself", () => {
    expect(toolActivityOf("core:say")).toBeNull();
    expect(toolActivityOf("Read")).toBeNull();
  });
});

describe("parseConciergeActivity", () => {
  it("reads every known activity as it is", () => {
    for (const activity of [
      { kind: "idle" },
      { kind: "needsYou" },
      { kind: "working" },
      { kind: "tool", tool: "startingTask" },
      { kind: "tasks", title: "Book the flight", more: 2 },
    ]) {
      expect(parseConciergeActivity(activity)).toEqual(activity);
    }
  });

  it("reads a tool it does not know as plain work", () => {
    expect(parseConciergeActivity({ kind: "tool", tool: "paintingMural" })).toEqual({
      kind: "working",
    });
    expect(parseConciergeActivity({ kind: "tool" })).toEqual({ kind: "working" });
  });

  it("leaves out a kind it does not know, or a malformed value, and never throws", () => {
    for (const raw of [{ kind: "dreaming" }, null, undefined, "working", 3, {}]) {
      expect(parseConciergeActivity(raw)).toBeNull();
    }
  });
});

describe("conciergeActivity", () => {
  it("is idle when nothing runs or waits", () => {
    expect(conciergeActivity(facts())).toEqual({ kind: "idle" });
    expect(conciergeActivity(facts({ tasks: [task()] }))).toEqual({ kind: "idle" });
  });

  it("puts a card waiting here or in a task chat ahead of everything", () => {
    const busy = { turn: { running: true, tool: "core:chat_start" }, reportPending: true };
    expect(conciergeActivity(facts({ ...busy, awaitingGuardian: true }))).toEqual({
      kind: "needsYou",
    });
    expect(
      conciergeActivity(facts({ ...busy, tasks: [task({ awaitingGuardian: true })] })),
    ).toEqual({ kind: "needsYou" });
  });

  it("names the tool the turn is in, and says plain work in any other", () => {
    expect(
      conciergeActivity(facts({ turn: { running: true, tool: "mcp__rome__chat_start" } })),
    ).toEqual({ kind: "tool", tool: "startingTask" });
    expect(conciergeActivity(facts({ turn: { running: true, tool: "core:say" } }))).toEqual({
      kind: "working",
    });
    expect(conciergeActivity(facts({ turn: { running: true, tool: null } }))).toEqual({
      kind: "working",
    });
  });

  it("puts its own turn ahead of a pending report, and both ahead of running tasks", () => {
    const running = [task({ running: true })];
    expect(
      conciergeActivity(
        facts({ turn: { running: true, tool: null }, reportPending: true, tasks: running }),
      ),
    ).toEqual({ kind: "working" });
    expect(conciergeActivity(facts({ reportPending: true, tasks: running }))).toEqual({
      kind: "working",
    });
  });

  it("leads with the newest of several running task chats and counts the rest", () => {
    expect(
      conciergeActivity(
        facts({
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

/** A world of one owner's Concierge chats that the tests change by hand. */
function world() {
  let now = 1_000;
  const running = new Set<string>();
  /** Chats whose running turn is quiet and has said nothing yet. */
  const quiet = new Set<string>();
  let reads = 0;
  const tools = new Map<string, string>();
  const awaiting = new Set<string>();
  const pending: string[] = [];
  const rows: (ActivityTaskRow & { conciergeChat: string })[] = [];
  const chats = new Map<string, string>([
    ["main", "guardian"],
    ["topic", "guardian"],
  ]);
  const sources: ConciergeActivitySources = {
    now: () => now,
    isRunning: (id) => running.has(id),
    isBusy: (id) => running.has(id) && !quiet.has(id),
    openTool: (id) => tools.get(id) ?? null,
    awaitingGuardianOf: async (ids) => new Set(ids.filter((id) => awaiting.has(id))),
    tasksOf: async (chatId) => {
      reads += 1;
      return rows.filter((row) => row.conciergeChat === chatId);
    },
    reportPending: () => pending,
    ownerOf: async (chatId) => chats.get(chatId) ?? null,
    chatsOf: async (owner) =>
      [...chats.entries()].filter(([, who]) => who === owner).map(([id]) => id),
    chatsMovedBy: async (sessionId) => {
      if (chats.has(sessionId)) return [sessionId];
      const row = rows.find((candidate) => candidate.chatId === sessionId);
      return row ? [row.conciergeChat] : [];
    },
  };
  const tracker = new ConciergeActivityTracker(sources);
  const told: ConciergeActivityEvent[] = [];
  tracker.subscribe("guardian", (event, data) => {
    if (event === "concierge_activity") told.push(data as ConciergeActivityEvent);
  });
  return {
    tracker,
    told,
    running,
    quiet,
    /** How many times a chat's facts were read. */
    reads: () => reads,
    tools,
    awaiting,
    pending,
    rows,
    chats,
    advance: (ms: number) => {
      now += ms;
      rs.advanceTimersByTime(ms);
    },
    /** What the owner was last told about `chatId`. */
    last: (chatId: string) => told.filter((event) => event.chatId === chatId).at(-1)?.activity,
  };
}

/** Lets the tracker's awaited reads settle; `setImmediate` is not faked. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

describe("ConciergeActivityTracker", () => {
  beforeEach(() => {
    rs.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  });
  afterEach(() => {
    rs.useRealTimers();
  });

  it("tells each of the owner's chats on subscribe, so a reconnect starts right", async () => {
    const w = world();
    await flush();
    w.running.add("topic");
    await w.tracker.sessionChanged("topic");
    // A reconnect: a new subscriber hears where each chat stands now.
    const snapshot: ConciergeActivityEvent[] = [];
    w.tracker.subscribe("guardian", (_event, data) =>
      snapshot.push(data as ConciergeActivityEvent),
    );
    await flush();
    expect(snapshot.map((event) => [event.chatId, event.activity.kind])).toEqual([
      ["main", "idle"],
      ["topic", "working"],
    ]);
    // Another owner hears nothing of them.
    const visitor: unknown[] = [];
    w.tracker.subscribe("visitor:1", (_event, data) => visitor.push(data));
    await flush();
    expect(visitor).toEqual([]);
  });

  it("says working the moment the turn starts, and only on a change", async () => {
    const w = world();
    await flush();
    await flush();
    const before = w.told.length;
    w.running.add("main");
    await w.tracker.sessionChanged("main");
    expect(w.last("main")).toEqual({ kind: "working" });
    await w.tracker.sessionChanged("main");
    expect(w.told.length).toBe(before + 1);
  });

  it("holds a fast tool for 1.5 s before plain work takes its place", async () => {
    const w = world();
    await flush();
    w.running.add("main");
    w.tools.set("main", "core:chat_start");
    await w.tracker.sessionChanged("main");
    expect(w.last("main")).toEqual({ kind: "tool", tool: "startingTask" });

    // The tool returns at once: the label stays.
    w.tools.delete("main");
    await w.tracker.sessionChanged("main");
    expect(w.last("main")).toEqual({ kind: "tool", tool: "startingTask" });

    w.advance(TOOL_HOLD_MS - 1);
    await flush();
    expect(w.last("main")).toEqual({ kind: "tool", tool: "startingTask" });
    w.advance(1);
    await flush();
    expect(w.last("main")).toEqual({ kind: "working" });
  });

  it("lets a card waiting on the owner through a held tool at once", async () => {
    const w = world();
    await flush();
    w.running.add("main");
    w.tools.set("main", "core:chat_start");
    await w.tracker.sessionChanged("main");
    w.running.delete("main");
    w.tools.delete("main");
    w.awaiting.add("main");
    await w.tracker.sessionChanged("main");
    expect(w.last("main")).toEqual({ kind: "needsYou" });
  });

  it("shows a task chat's question card at once, and its running title otherwise", async () => {
    const w = world();
    await flush();
    w.rows.push({
      id: "t1",
      title: "Plan a dinner",
      chatId: "task-1",
      updatedAt: 5,
      conciergeChat: "topic",
    });
    w.running.add("task-1");
    await w.tracker.sessionChanged("task-1");
    expect(w.last("topic")).toEqual({ kind: "tasks", title: "Plan a dinner", more: 0 });

    w.running.delete("task-1");
    w.awaiting.add("task-1");
    await w.tracker.sessionChanged("task-1");
    expect(w.last("topic")).toEqual({ kind: "needsYou" });
  });

  it("stays working between a task's end and the turn that reports it", async () => {
    const w = world();
    await flush();
    w.rows.push({
      id: "t1",
      title: "Haikou weather",
      chatId: "task-1",
      updatedAt: 5,
      conciergeChat: "main",
    });
    w.running.add("task-1");
    await w.tracker.sessionChanged("task-1");
    expect(w.last("main")).toMatchObject({ kind: "tasks" });

    // The task chat ends a moment before its result is marked for report:
    // the facts read idle in between, and no one is told so.
    w.running.delete("task-1");
    await w.tracker.sessionChanged("task-1");
    expect(w.last("main")).toMatchObject({ kind: "tasks" });
    w.advance(150);
    w.pending.push("t1");
    await w.tracker.sessionChanged("task-1");
    expect(w.last("main")).toEqual({ kind: "working" });

    // The report turn starts, then ends: idle only then, once it has lasted.
    w.running.add("main");
    await w.tracker.sessionChanged("main");
    w.pending.length = 0;
    w.running.delete("main");
    await w.tracker.sessionChanged("main");
    expect(w.last("main")).toEqual({ kind: "working" });
    w.advance(IDLE_GRACE_MS);
    await flush();
    expect(w.told.filter((event) => event.chatId === "main").map((e) => e.activity.kind)).toEqual([
      "idle",
      "tasks",
      "working",
      "idle",
    ]);
  });

  it("refreshes both chats when a task moves between them, and both settle", async () => {
    const w = world();
    await flush();
    const row = {
      id: "t1",
      title: "Plan a dinner",
      chatId: "task-1",
      updatedAt: 5,
      conciergeChat: "topic",
    };
    w.rows.push(row);
    w.awaiting.add("task-1");
    await w.tracker.sessionChanged("task-1");
    expect(w.last("topic")).toEqual({ kind: "needsYou" });

    // The task is pointed at a message of the main chat.
    row.conciergeChat = "main";
    await w.tracker.taskChanged("t1", "main");
    expect(w.last("main")).toEqual({ kind: "needsYou" });
    w.advance(IDLE_GRACE_MS);
    await flush();
    expect(w.last("topic")).toEqual({ kind: "idle" });

    // The question is answered and the task chat finishes.
    w.awaiting.delete("task-1");
    await w.tracker.sessionChanged("task-1");
    w.advance(IDLE_GRACE_MS);
    await flush();
    expect(w.last("main")).toEqual({ kind: "idle" });
    expect(w.last("topic")).toEqual({ kind: "idle" });
  });

  it("shows a quiet turn only once it has said something", async () => {
    const w = world();
    await flush();
    w.running.add("main");
    w.quiet.add("main");
    await w.tracker.sessionChanged("main");
    expect(w.last("main")).toEqual({ kind: "idle" });
    w.quiet.delete("main");
    await w.tracker.sessionChanged("main");
    expect(w.last("main")).toEqual({ kind: "working" });
  });

  it("reads a busy chat again on the recheck, so a change no trigger told does not stay", async () => {
    const w = world();
    await flush();
    w.running.add("main");
    await w.tracker.sessionChanged("main");
    expect(w.last("main")).toEqual({ kind: "working" });
    // The turn ends by a path that tells the tracker nothing.
    w.running.delete("main");
    w.advance(RECHECK_MS);
    await flush();
    w.advance(IDLE_GRACE_MS);
    await flush();
    expect(w.last("main")).toEqual({ kind: "idle" });
  });

  it("leaves idle chats alone on the recheck", async () => {
    const w = world();
    await flush();
    const before = w.reads();
    w.advance(RECHECK_MS * 2);
    await flush();
    expect(w.reads()).toBe(before);
  });

  it("tells the owner a busy chat that is archived or gone is idle", async () => {
    const w = world();
    await flush();
    w.running.add("topic");
    await w.tracker.sessionChanged("topic");
    w.chats.delete("topic");
    await w.tracker.refresh("topic");
    expect(w.last("topic")).toEqual({ kind: "idle" });
  });

  it("forgets a chat that is gone, with its held timer, and tells nothing after stop", async () => {
    const w = world();
    await flush();
    w.running.add("main");
    w.tools.set("main", "core:chat_start");
    await w.tracker.sessionChanged("main");
    w.tools.delete("main");
    await w.tracker.sessionChanged("main");
    // The held tool's timer, and the recheck.
    expect(rs.getTimerCount()).toBe(2);

    w.chats.delete("main");
    w.advance(TOOL_HOLD_MS);
    await flush();
    expect(await w.tracker.current("main")).toBeNull();

    const told = w.told.length;
    w.tracker.stop();
    w.running.add("topic");
    await w.tracker.sessionChanged("topic");
    expect(w.told.length).toBe(told);
    expect(rs.getTimerCount()).toBe(0);
  });
});
