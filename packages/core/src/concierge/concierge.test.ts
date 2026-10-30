import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { Account, AgentTurnFinishedEvent, BackendTurnParams } from "@rome-os/app-runtime";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessagePage } from "../chats/message-repository.js";
import type { SaidMessage } from "../chats/message.js";
import type { Place } from "../chats/place.js";
import type { Body, SendResult } from "../chats/send.js";
import type { SessionToolContext } from "../core/session-tools.js";
import { ConciergeTasksRepository } from "../db/repositories/concierge-tasks.js";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { startConciergeEvents } from "./events.js";
import { NUDGE_PROMPT } from "./nudge.js";
import {
  CONCIERGE_ACCOUNT,
  CONCIERGE_AGENT_ID,
  CONCIERGE_CHAT_ID,
  ConciergeService,
  type ConciergeDeps,
  type TaskChats,
} from "./service.js";
import { ConciergeTasks } from "./tasks.js";
import { buildConciergeTools } from "./tools.js";

const CONCIERGE_CHAT = CONCIERGE_CHAT_ID;

const opened: TestDb[] = [];
afterEach(() => {
  rs.useRealTimers();
  for (const testDb of opened.splice(0)) testDb.close();
});

interface Row {
  id?: string;
  role: string;
  content: string;
  senderId?: string;
  /** Unset rows belong to every turn. */
  turnId?: string;
}

const textOf = (content: string): string => {
  const parts = JSON.parse(content) as Array<{ type: string; content?: string }>;
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.content)
    .join("\n");
};

/** The rows of a chat as a read of its place pages them, newest back. */
function pageOf(rows: Row[], place: Place, end: number, limit: number): MessagePage {
  const start = Math.max(0, end - limit);
  const messages: SaidMessage[] = rows.slice(start, end).map((row, index) => ({
    id: row.id ?? `row-${start + index}`,
    direction: row.role === "assistant" ? "fromRome" : "toRome",
    place,
    body: { text: textOf(row.content) },
    at: new Date(Date.UTC(2026, 9, 29, 0, 0, start + index)),
  }));
  return {
    messages,
    older: start > 0 ? { at: messages[0].at, id: String(start) } : null,
  };
}

function setup(
  options: { enabled?: boolean; settingsDelayMs?: number; startEvents?: boolean } = {},
) {
  const testDb = createTestDb();
  opened.push(testDb);
  const taskRepo = new ConciergeTasksRepository(testDb.db);
  const tasks = new ConciergeTasks(taskRepo);
  /** The real chat rows the task rows link to. */
  const storedChats = new WebChatRepository(testDb.db);
  const approvalListeners = new Set<(approval: unknown) => void>();
  const quietFlags: boolean[] = [];
  let fake = false;
  const sessions = new Map<string, Record<string, unknown>>([
    [CONCIERGE_CHAT, { id: CONCIERGE_CHAT, name: "Concierge", triggerKind: null }],
  ]);
  const messages = new Map<string, Row[]>();
  /** Every input posted to a task chat, by id, in order. */
  const posted: string[] = [];
  /** What the next send answers when it is refused. */
  let refuseWith: Exclude<SendResult, { ok: true }> | null = null;
  const backendTurns: BackendTurnParams[] = [];
  const order: string[] = [];
  let startedChats = 0;
  const chats: TaskChats = {
    startChat: rs.fn(async () => {
      const id = `task-${++startedChats}`;
      sessions.set(id, { id, name: "New Chat", triggerKind: null });
      await storedChats.createSession(id, "New Chat");
      return id;
    }),
    isRunning: rs.fn(() => false),
    activeTurns: rs.fn(() => []),
    interruptTurn: rs.fn(async () => {}),
  };
  const send = rs.fn(async (place: Place, body: Body, as: Account): Promise<SendResult> => {
    if (refuseWith) return refuseWith;
    order.push("post");
    const id = `input-${posted.length + 1}`;
    const list = messages.get(place.chat.id) ?? [];
    list.push({
      id,
      role: "user",
      content: JSON.stringify([{ type: "text", content: body.text }]),
      senderId: as.id,
      turnId: "task-turn-1",
    });
    messages.set(place.chat.id, list);
    posted.push(id);
    return {
      ok: true,
      sent: { ref: `${place.chat.id}:${id}`, timestamp: 0 },
      delivery: { state: "sent", at: new Date(0) },
    };
  });
  const deps = {
    settingsRepo: {
      get: async () => {
        if (options.settingsDelayMs)
          await new Promise((resolve) => setTimeout(resolve, options.settingsDelayMs));
        return options.enabled ?? true;
      },
    },
    webchatRepo: {
      getSession: async (id: string) => sessions.get(id) ?? null,
      listSessions: async () => [...sessions.values()],
      updateSessionName: rs.fn(async (id: string, name: string) => {
        order.push("rename");
        sessions.set(id, { ...sessions.get(id), name });
      }),
      getTurnChatMessages: async (id: string, turnId: string) =>
        (messages.get(id) ?? []).filter((row) => !row.turnId || row.turnId === turnId),
      addBackendMessage: rs.fn(async (chatId: string, _turnId: string, parts: unknown[]) => {
        const list = messages.get(chatId) ?? [];
        list.push({ role: "assistant", content: JSON.stringify(parts) });
        messages.set(chatId, list);
      }),
      setSessionTrigger: rs.fn(
        async (id: string, trigger: { triggerKind: string; triggerName: string | null }) => {
          order.push("trigger");
          sessions.set(id, { ...sessions.get(id), ...trigger });
        },
      ),
      createSession: rs.fn(async () => {}),
      listProjects: async () => [{ path: "default" }, { path: "rome-oss" }],
    },
    tasks,
    approvals: {
      onCreated: (listener: (approval: unknown) => void) => {
        approvalListeners.add(listener);
        return () => approvalListeners.delete(listener);
      },
    },
    messages: {
      recent: async (place: Place, limit: number) => {
        const rows = messages.get(place.chat.id) ?? [];
        return pageOf(rows, place, rows.length, limit);
      },
      before: async (place: Place, cursor: { id: string }, limit: number) =>
        pageOf(messages.get(place.chat.id) ?? [], place, Number(cursor.id), limit),
    },
    sessionManager: { findReusableSession: async () => ({ id: "runtime-1" }) },
    aiToolState: {
      get: () => ({
        claude: { loggedIn: true, quotaExhausted: false },
        codex: { loggedIn: false, quotaExhausted: false, solAccess: false, lunaAccess: false },
      }),
    },
    runBackendTurn: async (params: BackendTurnParams, turn?: { quiet?: boolean }) => {
      backendTurns.push(params);
      quietFlags.push(turn?.quiet === true);
      await onBackendTurn(params);
    },
  } as unknown as ConciergeDeps;
  let onBackendTurn: (params: BackendTurnParams) => Promise<void> | void = () => {};
  const service = new ConciergeService(deps);
  service.attachDashboard({ chats, send });
  const context = (agentName = CONCIERGE_AGENT_ID): SessionToolContext => ({
    agentName,
    channelThreadKey: `webchat:${CONCIERGE_CHAT}`,
    sessionId: "runtime-1",
    isSubagent: false,
    getTurnId: () => "concierge-turn-1",
    getThreadContext: () => ({
      channel: "webchat",
      threadId: CONCIERGE_CHAT,
      channelUserId: "guardian",
    }),
  });
  const listeners: Array<(event: AgentTurnFinishedEvent) => void> = [];
  const startEvents = () =>
    startConciergeEvents(service, {
      onFinished: (listener) => {
        listeners.push(listener);
        return () => {};
      },
    });
  if (options.startEvents !== false) startEvents();
  /** Lets the event handlers run: real time, or fake time moved a little. */
  const settle = async () => {
    if (fake) await rs.advanceTimersByTimeAsync(20);
    else await new Promise((resolve) => setTimeout(resolve, 20));
  };
  const finish = async (event: {
    turnId: string;
    agentName: string;
    chatId: string;
    text?: string;
    status?: AgentTurnFinishedEvent["status"];
  }) => {
    for (const listener of listeners) {
      listener({
        type: "agent-turn-finished",
        version: 1,
        turn: {
          sessionId: "runtime-x",
          turnId: event.turnId,
          agentName: event.agentName,
          threadContext: { channel: "webchat", threadId: event.chatId },
        },
        status: event.status ?? "completed",
        timing: { startedAt: "", finishedAt: "", durationMs: 0 },
        output: { text: event.text ?? "", state: "final" },
        metrics: { toolCallCount: 0, skillWritten: false },
      });
    }
    await settle();
  };
  const tool = async (name: string, input: Record<string, unknown>) => {
    const tools = await buildConciergeTools(service, context());
    const found = tools.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return await found.handler(input);
  };
  /** Moves a posted input to the turn that takes it, as the input queue does. */
  const assignInput = (chatId: string, inputId: string, turnId: string) => {
    const row = messages.get(chatId)?.find((candidate) => candidate.id === inputId);
    if (row) row.turnId = turnId;
  };
  return {
    service,
    deps,
    tasks,
    taskRepo,
    storedChats,
    quietFlags,
    startEvents,
    settle,
    /** Moves the clock by hand from here on, so event delivery can be timed. */
    fakeTimers: () => {
      fake = true;
      rs.useFakeTimers();
    },
    createApproval: (approval: Record<string, unknown>) => {
      for (const listener of approvalListeners) listener(approval);
    },
    chats,
    send,
    messages,
    backendTurns,
    order,
    context,
    finish,
    tool,
    posted,
    assignInput,
    refuseSends: (result: Exclude<SendResult, { ok: true }>) => {
      refuseWith = result;
    },
    onBackendTurn: (handler: typeof onBackendTurn) => {
      onBackendTurn = handler;
    },
  };
}

describe("Concierge tools", () => {
  it("register only for the Concierge agent while the setting is on", async () => {
    const on = setup();
    expect((await buildConciergeTools(on.service, on.context())).map((t) => t.name)).toEqual([
      "say",
      "task_upsert",
      "task_list",
      "chat_start",
      "chat_send",
      "chat_read",
      "chat_stop",
      "chat_list",
      "chat_forward",
      "chat_card",
    ]);
    expect(await buildConciergeTools(on.service, on.context("core:main"))).toEqual([]);
    const off = setup({ enabled: false });
    expect(await buildConciergeTools(off.service, off.context())).toEqual([]);
  });

  it("say posts one message under the running turn", async () => {
    const s = setup();
    await s.tool("say", { text: "on it" });
    await s.tool("say", { text: "# Report", format: "long" });
    expect(s.messages.get(CONCIERGE_CHAT)?.map((row) => JSON.parse(row.content))).toEqual([
      [{ type: "text", content: "on it" }],
      [{ type: "text", content: "# Report", format: "long" }],
    ]);
  });

  it("chat_start marks the task chat before its first turn and names it after", async () => {
    const s = setup();
    const result = await s.tool("chat_start", {
      title: "Flights",
      brief: "Find flights",
      card: true,
    });
    expect(JSON.parse(result.content[0].text)).toEqual({
      chatId: "task-1",
      taskId: expect.any(String),
    });
    expect(s.order).toEqual(["trigger", "post", "rename"]);
    expect(s.send).toHaveBeenCalledWith(
      { chat: { platform: "webchat", id: "task-1" } },
      { text: "Find flights" },
      CONCIERGE_ACCOUNT,
    );
    expect(JSON.parse(s.messages.get(CONCIERGE_CHAT)?.[0].content ?? "")).toEqual([
      { type: "task_chat", chatId: "task-1", title: "Flights" },
    ]);
  });

  it("chat_start answers the started chat when naming it fails", async () => {
    const s = setup();
    rs.mocked(s.deps.webchatRepo.updateSessionName).mockRejectedValueOnce(new Error("disk full"));
    const result = await s.tool("chat_start", {
      title: "Flights",
      brief: "Find flights",
      card: true,
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual({
      chatId: "task-1",
      taskId: expect.any(String),
    });
    expect(JSON.parse(s.messages.get(CONCIERGE_CHAT)?.[0].content ?? "")).toEqual([
      { type: "task_chat", chatId: "task-1", title: "Flights" },
    ]);
  });

  it("chat_start takes a project by the absolute path the prompt lists", async () => {
    const s = setup();
    const root = mkdtempSync(join(tmpdir(), "rome-concierge-projects-"));
    rs.stubEnv("ROME_PROJECTS_ROOT", root);
    try {
      await s.tool("chat_start", {
        title: "Fix",
        brief: "Fix it",
        project: join(root, "rome-oss"),
      });
      expect(s.chats.startChat).toHaveBeenCalledWith({
        agentName: undefined,
        projectPath: "rome-oss",
      });
    } finally {
      rs.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("chat_start rejects an unknown project and names the valid ones", async () => {
    const s = setup();
    const root = mkdtempSync(join(tmpdir(), "rome-concierge-projects-"));
    rs.stubEnv("ROME_PROJECTS_ROOT", root);
    try {
      const result = await s.tool("chat_start", { title: "Fix", brief: "Fix it", project: "rome" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("one of: default, rome-oss");
      expect(s.chats.startChat).not.toHaveBeenCalled();
    } finally {
      rs.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses chats it did not start", async () => {
    const s = setup();
    const result = await s.tool("chat_send", { chatId: CONCIERGE_CHAT, text: "hi" });
    expect(result.isError).toBe(true);
  });

  it("chat_send says the follow-up as Concierge's account", async () => {
    const s = setup();
    await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    const result = await s.tool("chat_send", { chatId: "task-1", text: "Trains too" });
    expect(result.isError).toBeFalsy();
    expect(s.send).toHaveBeenLastCalledWith(
      { chat: { platform: "webchat", id: "task-1" } },
      { text: "Trains too" },
      CONCIERGE_ACCOUNT,
    );
  });

  it("chat_send fails with the send's own words when the chat refuses it", async () => {
    const s = setup();
    await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    const error = "This chat is archived and read-only";
    s.refuseSends({ ok: false, error, delivery: { state: "failed", error, at: new Date(0) } });
    const result = await s.tool("chat_send", { chatId: "task-1", text: "Trains too" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("This chat is archived and read-only");
  });

  it("chat_read reads the latest messages that carry text, past card-only ones", async () => {
    const s = setup();
    await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    const said = (role: string, parts: unknown[]) =>
      s.messages.get("task-1")?.push({ role, content: JSON.stringify(parts) });
    said("assistant", [{ type: "text", content: "3 options" }]);
    for (let index = 0; index < 40; index += 1) said("assistant", [{ type: "recap" }]);
    s.chats.isRunning = () => true;
    const result = await s.tool("chat_read", { chatId: "task-1", last: 2 });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      chatId: "task-1",
      status: "running",
      messages: [
        { role: "user", text: "Find flights" },
        { role: "assistant", text: "3 options" },
      ],
    });
  });

  it("chat_forward says the latest answer, not a later follow-up", async () => {
    const s = setup();
    await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    s.messages.get("task-1")?.push({
      role: "assistant",
      content: JSON.stringify([{ type: "text", content: "# Report" }]),
    });
    await s.tool("chat_send", { chatId: "task-1", text: "Trains too" });
    const result = await s.tool("chat_forward", { chatId: "task-1" });
    expect(JSON.parse(result.content[0].text)).toEqual({ forwardedChars: 8 });
    expect(s.messages.get(CONCIERGE_CHAT)?.map((row) => JSON.parse(row.content))).toEqual([
      [
        {
          type: "text",
          content: "# Report",
          format: "long",
          forwardedFrom: { chatId: "task-1", title: "Flights" },
        },
      ],
    ]);
  });

  it("chat_stop stops each of the task chat's turns", async () => {
    const s = setup();
    await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    s.chats.activeTurns = () => ["t1", "t2"];
    const result = await s.tool("chat_stop", { chatId: "task-1" });
    expect(JSON.parse(result.content[0].text)).toEqual({ stopped: 2 });
    expect(s.chats.interruptTurn).toHaveBeenCalledWith("t1");
    expect(s.chats.interruptTurn).toHaveBeenCalledWith("t2");
  });

  it("chat_list lists only the task chats it started", async () => {
    const s = setup();
    await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    const result = await s.tool("chat_list", {});
    expect(JSON.parse(result.content[0].text)).toEqual([
      { chatId: "task-1", title: "Flights", status: "idle" },
    ]);
  });

  it("chat_card shows the card for a task chat started without one", async () => {
    const s = setup();
    await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    expect(s.messages.get(CONCIERGE_CHAT)).toBeUndefined();
    const result = await s.tool("chat_card", { chatId: "task-1" });
    expect(result.isError).toBeFalsy();
    expect(s.messages.get(CONCIERGE_CHAT)?.map((row) => JSON.parse(row.content))).toEqual([
      [{ type: "task_chat", chatId: "task-1", title: "Flights" }],
    ]);
  });

  it("chat_forward stores the task chat it came from, and the intro in the same message", async () => {
    const s = setup();
    await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    s.messages.get("task-1")?.push({
      role: "assistant",
      content: JSON.stringify([{ type: "text", content: "# Report\n\nThree options." }]),
    });
    const result = await s.tool("chat_forward", { chatId: "task-1", intro: "Here it is" });
    expect(result.isError).toBeFalsy();
    expect(s.messages.get(CONCIERGE_CHAT)?.map((row) => JSON.parse(row.content))).toEqual([
      [
        { type: "text", content: "Here it is" },
        {
          type: "text",
          content: "# Report\n\nThree options.",
          format: "long",
          forwardedFrom: { chatId: "task-1", title: "Flights" },
        },
      ],
    ]);
  });

  it("chat_forward without an intro stores the report alone", async () => {
    const s = setup();
    await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    s.messages.get("task-1")?.push({
      role: "assistant",
      content: JSON.stringify([{ type: "text", content: "Three options." }]),
    });
    await s.tool("chat_forward", { chatId: "task-1" });
    expect(s.messages.get(CONCIERGE_CHAT)?.map((row) => JSON.parse(row.content))).toEqual([
      [
        {
          type: "text",
          content: "Three options.",
          format: "long",
          forwardedFrom: { chatId: "task-1", title: "Flights" },
        },
      ],
    ]);
  });

  it("say marks no origin on what the agent writes itself", async () => {
    const s = setup();
    await s.tool("say", { text: "# Plan", format: "long" });
    expect(JSON.parse(s.messages.get(CONCIERGE_CHAT)?.[0].content ?? "")[0]).not.toHaveProperty(
      "forwardedFrom",
    );
  });

  it("chat_card refuses chats it did not start", async () => {
    const s = setup();
    const result = await s.tool("chat_card", { chatId: CONCIERGE_CHAT });
    expect(result.isError).toBe(true);
    expect(s.messages.get(CONCIERGE_CHAT)).toBeUndefined();
  });
});

describe("Concierge task list tools", () => {
  const text = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);

  it("chat_start without a taskId puts a doing row on the list and answers its id", async () => {
    const s = setup();
    const result = text(await s.tool("chat_start", { title: "Flights", brief: "Find flights" }));
    expect(await s.taskRepo.get(result.taskId)).toMatchObject({
      title: "Flights",
      state: "doing",
      sessionId: "task-1",
    });
    expect((await s.taskRepo.findBySession("task-1"))?.id).toBe(result.taskId);
  });

  it("chat_start with a taskId links the planned row and sets it doing", async () => {
    const s = setup();
    const [planned] = await s.taskRepo.upsertMany([
      { title: "Book flights", state: "next", rank: 1, waitingOn: "a date" },
    ]);
    const result = text(
      await s.tool("chat_start", { title: "Flights", brief: "Find flights", taskId: planned.id }),
    );
    expect(result).toEqual({ chatId: "task-1", taskId: planned.id });
    expect(await s.taskRepo.get(planned.id)).toMatchObject({
      title: "Book flights",
      state: "doing",
      rank: 1,
      waitingOn: null,
      sessionId: "task-1",
    });
    expect(await s.taskRepo.listForAgent(true)).toHaveLength(1);
  });

  it("chat_start refuses a taskId that is unknown or already has a chat, before starting anything", async () => {
    const s = setup();
    const missing = await s.tool("chat_start", { title: "A", brief: "b", taskId: "nope" });
    expect(missing.isError).toBe(true);
    expect(s.chats.startChat).not.toHaveBeenCalled();

    const first = text(await s.tool("chat_start", { title: "A", brief: "b" }));
    const taken = await s.tool("chat_start", { title: "B", brief: "b", taskId: first.taskId });
    expect(taken.isError).toBe(true);
    expect(taken.content[0].text).toContain("already has chat task-1");
    expect(s.chats.startChat).toHaveBeenCalledTimes(1);
  });

  it("chat_send gives a task chat from before the list its row", async () => {
    const s = setup();
    s.deps.webchatRepo.getSession = (async (id: string) =>
      id === "legacy"
        ? { id, name: "Old chat", triggerKind: "concierge", triggerName: "Old task" }
        : null) as never;
    await s.storedChats.createSession("legacy", "Old chat");
    expect((await s.tool("chat_send", { chatId: "legacy", text: "More" })).isError).toBeFalsy();
    expect(await s.taskRepo.findBySession("legacy")).toMatchObject({
      title: "Old task",
      state: "doing",
    });
    // A second send does not add a second row.
    await s.tool("chat_send", { chatId: "legacy", text: "Again" });
    expect(await s.taskRepo.listForAgent(true)).toHaveLength(1);
  });

  it("task_upsert creates and updates rows in one batch and answers each row's id", async () => {
    const s = setup();
    const created = text(
      await s.tool("task_upsert", {
        tasks: [
          { title: "Renew passport", state: "next", rank: 2, dueAt: "2026-11-01T09:00:00Z" },
          { title: "Watch CI", state: "watching", waitingOn: "CI" },
        ],
      }),
    );
    expect(created.tasks.map((task: { title: string }) => task.title)).toEqual([
      "Renew passport",
      "Watch CI",
    ]);
    const [passport, ci] = created.tasks;
    const updated = text(
      await s.tool("task_upsert", {
        tasks: [
          { id: passport.id, state: "doing" },
          { id: ci.id, state: "done", summary: "Green", waitingOn: null },
          { title: "Pay rent" },
        ],
      }),
    );
    expect(updated.tasks.map((task: { state: string }) => task.state)).toEqual([
      "doing",
      "done",
      "next",
    ]);
    expect(await s.taskRepo.get(ci.id)).toMatchObject({
      state: "done",
      summary: "Green",
      waitingOn: null,
    });
    expect((await s.taskRepo.get(passport.id))?.dueAt?.toISOString()).toBe(
      "2026-11-01T09:00:00.000Z",
    );
  });

  it("task_upsert validates states, times, ranks, chats and titles, and writes nothing on a bad batch", async () => {
    const s = setup();
    const bad = async (entry: Record<string, unknown>, message: string) => {
      const result = await s.tool("task_upsert", { tasks: [{ title: "Fine" }, entry] });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(message);
    };
    await bad({ title: "x", state: "failed" }, "state must be one of");
    await bad({ title: "x", dueAt: "tomorrow-ish" }, "dueAt must be an ISO 8601 time");
    await bad({ title: "x", rank: 1.5 }, "rank must be an integer");
    await bad({ title: "x", chatId: CONCIERGE_CHAT }, "No task chat");
    await bad({ state: "doing" }, "title is required to create a row");
    await bad({ id: "nope", state: "done" }, "No task nope");
    expect((await s.tool("task_upsert", { tasks: [] })).isError).toBe(true);
    expect(await s.taskRepo.listForAgent(true)).toEqual([]);
  });

  it("task_upsert links a task chat once, and says which row holds it", async () => {
    const s = setup();
    const started = text(await s.tool("chat_start", { title: "Flights", brief: "Find flights" }));
    const result = await s.tool("task_upsert", { tasks: [{ title: "Dupe", chatId: "task-1" }] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(`already linked to task ${started.taskId}`);
  });

  it("task_upsert caps a summary at 120 characters", async () => {
    const s = setup();
    const made = text(
      await s.tool("task_upsert", { tasks: [{ title: "Long", summary: "x".repeat(300) }] }),
    );
    expect((await s.taskRepo.get(made.tasks[0].id))?.summary).toHaveLength(120);
  });

  it("task_upsert tells the list's listeners about every row it writes", async () => {
    const s = setup();
    const seen: string[] = [];
    s.taskRepo.onChange(({ row }) => seen.push(row.title));
    await s.tool("task_upsert", { tasks: [{ title: "A" }, { title: "B" }] });
    expect(seen).toEqual(["A", "B"]);
  });

  it("task_list answers compact open rows, and the finished ones on request", async () => {
    const s = setup();
    await s.tool("task_upsert", {
      tasks: [
        { title: "Open", state: "watching", waitingOn: "CI", dueAt: "2026-11-01T09:00:00Z" },
        { title: "Finished", state: "done" },
      ],
    });
    const open = text(await s.tool("task_list", {}));
    expect(open.tasks).toEqual([
      {
        id: expect.any(String),
        title: "Open",
        state: "watching",
        waitingOn: "CI",
        dueAt: "2026-11-01T09:00:00.000Z",
        updatedAt: expect.any(String),
      },
    ]);
    expect(text(await s.tool("task_list", { includeDone: true })).tasks).toHaveLength(2);
  });
});

describe("Concierge events", () => {
  /** A task chat the Concierge started, with a reply it wrote. */
  const startTask = async (s: ReturnType<typeof setup>, reply = "3 options") => {
    const started = JSON.parse(
      (await s.tool("chat_start", { title: "Flights", brief: "Find flights" })).content[0].text,
    );
    s.messages.get(started.chatId)?.push({
      role: "assistant",
      content: JSON.stringify([{ type: "text", content: reply }]),
    });
    return started as { chatId: string; taskId: string };
  };
  const finishTask = (
    s: ReturnType<typeof setup>,
    chatId: string,
    extra: { turnId?: string; status?: AgentTurnFinishedEvent["status"] } = {},
  ) =>
    s.finish({
      turnId: extra.turnId ?? "task-turn-1",
      agentName: "core:main",
      chatId,
      status: extra.status,
      text: "x",
    });

  it("tells the Concierge of a result it asked for two seconds after the turn ends, as one batch", async () => {
    const s = setup();
    const { chatId, taskId } = await startTask(s);
    s.fakeTimers();
    await finishTask(s, chatId);
    await rs.advanceTimersByTimeAsync(1_900);
    expect(s.backendTurns).toEqual([]);
    await rs.advanceTimersByTimeAsync(200);
    expect(s.backendTurns).toHaveLength(1);
    expect(s.backendTurns[0]).toMatchObject({
      agentName: CONCIERGE_AGENT_ID,
      threadId: CONCIERGE_CHAT,
    });
    expect(s.backendTurns[0].prompt).toBe(
      `<task_events>\n<task id="${taskId}" chat_id="task-1" title="Flights" state="doing" changes="turn_end:completed by=concierge">\nreply: 3 options\n</task>\n</task_events>`,
    );
    expect(s.quietFlags).toEqual([false]);
  });

  it("reads the reply from the chat when it builds, so a reply written after the turn ended is in", async () => {
    const s = setup();
    const { chatId } = await startTask(s, "first answer");
    s.fakeTimers();
    await finishTask(s, chatId);
    s.messages.get(chatId)?.push({
      role: "assistant",
      content: JSON.stringify([{ type: "text", content: "final answer" }]),
    });
    await rs.advanceTimersByTimeAsync(2_000);
    expect(s.backendTurns[0].prompt).toContain("reply: final answer");
    expect(s.backendTurns[0].prompt).not.toContain("first answer");
  });

  it("cuts a long reply to 600 characters", async () => {
    const s = setup();
    const { chatId } = await startTask(s, "y".repeat(2_000));
    s.fakeTimers();
    await finishTask(s, chatId);
    await rs.advanceTimersByTimeAsync(2_000);
    expect(s.backendTurns[0].prompt).toContain(`reply: ${"y".repeat(600)}…`);
  });

  it("puts tasks that finish together in one turn", async () => {
    const s = setup();
    const first = await startTask(s);
    const second = JSON.parse(
      (await s.tool("chat_start", { title: "Hotels", brief: "Find hotels" })).content[0].text,
    );
    s.fakeTimers();
    await finishTask(s, first.chatId);
    await s.finish({ turnId: "task-turn-1", agentName: "core:main", chatId: second.chatId });
    await rs.advanceTimersByTimeAsync(2_000);
    expect(s.backendTurns).toHaveLength(1);
    expect(s.backendTurns[0].prompt.match(/<task /g)).toHaveLength(2);
  });

  it("holds the guardian's own turn in a task chat for a minute and runs it quietly", async () => {
    const s = setup();
    const { chatId } = await startTask(s);
    s.fakeTimers();
    s.messages.get(chatId)?.push({
      id: "g1",
      role: "user",
      content: JSON.stringify([{ type: "text", content: "hi" }]),
      turnId: "task-turn-2",
    });
    await finishTask(s, chatId, { turnId: "task-turn-2" });
    await rs.advanceTimersByTimeAsync(59_000);
    expect(s.backendTurns).toEqual([]);
    await rs.advanceTimersByTimeAsync(1_000);
    expect(s.backendTurns).toHaveLength(1);
    expect(s.backendTurns[0].prompt).toContain('changes="turn_end:completed by=guardian"');
    expect(s.backendTurns[0].prompt).toContain('quiet="true"');
    expect(s.quietFlags).toEqual([true]);
  });

  it("tells the Concierge of a failed turn at once, and holds a stopped one", async () => {
    const s = setup();
    const { chatId } = await startTask(s);
    s.fakeTimers();
    await finishTask(s, chatId, { status: "error" });
    await rs.advanceTimersByTimeAsync(2_000);
    expect(s.backendTurns[0].prompt).toContain('changes="turn_end:error by=concierge"');

    const stopped = setup();
    const task = await startTask(stopped);
    stopped.fakeTimers();
    await finishTask(stopped, task.chatId, { status: "interrupted" });
    await rs.advanceTimersByTimeAsync(2_000);
    expect(stopped.backendTurns).toEqual([]);
    await rs.advanceTimersByTimeAsync(58_000);
    expect(stopped.quietFlags).toEqual([true]);
  });

  it("tells the Concierge of a question card at once, with the question", async () => {
    const s = setup();
    const { chatId } = await startTask(s);
    s.messages.get(chatId)?.push({
      role: "assistant",
      content: JSON.stringify([
        {
          type: "pending_interaction",
          render: {
            builtin: true,
            props: { questions: [{ question: "Which airport?", options: ["LIS", "OPO"] }] },
          },
        },
      ]),
    });
    s.fakeTimers();
    await finishTask(s, chatId);
    await rs.advanceTimersByTimeAsync(2_000);
    const prompt = s.backendTurns[0].prompt;
    expect(prompt).toContain('changes="turn_end:completed question by=concierge"');
    expect(prompt).toContain("question: Which airport? (options: LIS | OPO)");
  });

  it("tells the Concierge what the guardian said in a task chat, read from the turn's own rows", async () => {
    const s = setup();
    const { chatId, taskId } = await startTask(s);
    // The real repository, as the dashboard stores it: the guardian's input is
    // recorded through the user-input path, which announces nothing, and the
    // turn that takes it in is assigned afterwards.
    s.deps.webchatRepo.getTurnChatMessages = (id: string, turnId: string) =>
      s.storedChats.getTurnChatMessages(id, turnId);
    await s.storedChats.recordUserInput(
      "input-g1",
      chatId,
      JSON.stringify([{ type: "text", content: "Make it a window seat" }]),
    );
    await s.storedChats.updateUserInput(chatId, {
      type: "input_status",
      inputId: "input-g1",
      state: "accepted",
      turnId: "guardian-turn",
    });
    s.fakeTimers();
    await s.finish({ turnId: "guardian-turn", agentName: "core:main", chatId });
    await rs.advanceTimersByTimeAsync(59_000);
    expect(s.backendTurns).toEqual([]);
    await rs.advanceTimersByTimeAsync(2_000);
    expect(s.backendTurns).toHaveLength(1);
    expect(s.backendTurns[0].prompt).toContain(`<task id="${taskId}"`);
    expect(s.backendTurns[0].prompt).toContain('changes="turn_end:completed by=guardian"');
    expect(s.backendTurns[0].prompt).toContain("guardian: Make it a window seat");
    expect(s.quietFlags).toEqual([true]);
  });

  it("tells the Concierge of a pending approval in a task chat at once", async () => {
    const s = setup();
    const { chatId } = await startTask(s);
    s.fakeTimers();
    s.createApproval({
      status: "approved",
      description: "auto",
      payload: { channelContext: { threadId: chatId } },
    });
    s.createApproval({
      status: "pending",
      description: "elsewhere",
      payload: { channelContext: { threadId: "other-chat" } },
    });
    await s.settle();
    await rs.advanceTimersByTimeAsync(5_000);
    expect(s.backendTurns).toEqual([]);
    s.createApproval({
      status: "pending",
      description: "Send the booking email",
      payload: { channelContext: { threadId: chatId } },
    });
    await s.settle();
    await rs.advanceTimersByTimeAsync(2_000);
    expect(s.backendTurns[0].prompt).toContain('changes="approval"');
    expect(s.backendTurns[0].prompt).toContain("approval: Send the booking email");
    expect(s.quietFlags).toEqual([false]);
  });

  it("tells the Concierge quietly that a task chat was deleted, and the row stays", async () => {
    const s = setup();
    const { chatId, taskId } = await startTask(s);
    s.fakeTimers();
    const linked = await s.service.taskOfChat(chatId);
    expect(linked).toBe(taskId);
    await s.storedChats.deleteSession(chatId);
    s.service.chatDeleted(taskId);
    await rs.advanceTimersByTimeAsync(59_000);
    expect(s.backendTurns).toEqual([]);
    await rs.advanceTimersByTimeAsync(1_000);
    expect(s.backendTurns[0].prompt).toBe(
      `<task_events>\n<task id="${taskId}" title="Flights" state="doing" changes="chat_deleted" quiet="true">\nThe task chat was deleted.\n</task>\n</task_events>`,
    );
    expect(await s.taskRepo.get(taskId)).toMatchObject({ sessionId: null, title: "Flights" });
  });

  it("after a restart, hands over rows whose chat was active since the row was written", async () => {
    const s = setup({ startEvents: false });
    await s.storedChats.createSession("behind", "Behind");
    await s.storedChats.createSession("current", "Current");
    s.messages.set("behind", [
      { role: "assistant", content: JSON.stringify([{ type: "text", content: "all done" }]) },
    ]);
    const longAgo = new Date(Date.now() - 3_600_000);
    const [behind] = await s.taskRepo.upsertMany(
      [{ title: "Behind", state: "doing", sessionId: "behind" }],
      longAgo,
    );
    await s.taskRepo.upsertMany([{ title: "Current", state: "doing", sessionId: "current" }]);
    s.fakeTimers();
    s.startEvents();
    await s.settle();
    await rs.advanceTimersByTimeAsync(59_000);
    expect(s.backendTurns).toEqual([]);
    await rs.advanceTimersByTimeAsync(1_000);
    expect(s.backendTurns).toHaveLength(1);
    expect(s.backendTurns[0].prompt).toContain(`<task id="${behind.id}"`);
    expect(s.backendTurns[0].prompt).toContain('changes="catch_up"');
    // The block says what the chat holds now, so the Concierge can judge the row.
    expect(s.backendTurns[0].prompt).toContain("chat: idle\nreply: all done");
    expect(s.backendTurns[0].prompt.match(/<task /g)).toHaveLength(1);
    expect(s.quietFlags).toEqual([true]);
  });

  it("stops asking once the Concierge writes the row, and marks the row not synced when it never does", async () => {
    const answered = setup();
    const task = await startTask(answered);
    answered.fakeTimers();
    await finishTask(answered, task.chatId);
    await rs.advanceTimersByTimeAsync(2_000);
    await answered.taskRepo.upsertMany([{ id: task.taskId, state: "done", summary: "3 options" }]);
    await rs.advanceTimersByTimeAsync(120_000);
    expect(answered.backendTurns).toHaveLength(1);

    const ignored = setup();
    const quiet = await startTask(ignored);
    ignored.fakeTimers();
    await finishTask(ignored, quiet.chatId);
    await rs.advanceTimersByTimeAsync(2_000);
    expect(ignored.backendTurns).toHaveLength(1);
    expect((await ignored.tasks.listForPanel())[0].notSynced).toBe(false);
    await rs.advanceTimersByTimeAsync(10_000);
    expect(ignored.backendTurns).toHaveLength(2);
    expect((await ignored.tasks.listForPanel())[0].notSynced).toBe(true);
    await rs.advanceTimersByTimeAsync(120_000);
    expect(ignored.backendTurns).toHaveLength(2);
    // A later write by the Concierge clears the mark.
    await ignored.taskRepo.upsertMany([{ id: quiet.taskId, summary: "ok" }]);
    expect((await ignored.tasks.listForPanel())[0].notSynced).toBe(false);
  });

  it("says nothing while the setting is off", async () => {
    const s = setup({ enabled: false });
    await s.taskRepo.upsertMany([{ title: "Row" }]);
    s.fakeTimers();
    await s.finish({ turnId: "t", agentName: "core:main", chatId: "task-1", text: "x" });
    await rs.advanceTimersByTimeAsync(120_000);
    expect(s.backendTurns).toEqual([]);
  });

  it("does not report a task chat the list does not know", async () => {
    const s = setup();
    s.deps.webchatRepo.getSession = (async (id: string) => ({
      id,
      name: "Old",
      triggerKind: "concierge",
    })) as never;
    s.fakeTimers();
    await s.finish({ turnId: "t", agentName: "core:main", chatId: "legacy", text: "x" });
    await rs.advanceTimersByTimeAsync(120_000);
    expect(s.backendTurns).toEqual([]);
  });

  it("ignores turns of chats Concierge did not start", async () => {
    const s = setup();
    await s.finish({ turnId: "t", agentName: "core:main", chatId: "other", text: "x" });
    expect(s.backendTurns).toEqual([]);
  });

  it("reminds a turn that spoke an acknowledgement but left its answer unsent", async () => {
    const s = setup();
    await s.tool("say", { text: "let me check" });
    await s.finish({
      turnId: "concierge-turn-1",
      agentName: CONCIERGE_AGENT_ID,
      chatId: CONCIERGE_CHAT,
      text: "It was 7291.",
    });
    expect(s.backendTurns.map((turn) => turn.prompt)).toEqual([NUDGE_PROMPT]);
  });

  it("reminds a Concierge turn that ended on unsent text, once", async () => {
    const s = setup();
    await s.finish({
      turnId: "c1",
      agentName: CONCIERGE_AGENT_ID,
      chatId: CONCIERGE_CHAT,
      text: "hi",
    });
    expect(s.backendTurns.map((turn) => turn.prompt)).toEqual([NUDGE_PROMPT]);
    await s.finish({
      turnId: "c2",
      agentName: CONCIERGE_AGENT_ID,
      chatId: CONCIERGE_CHAT,
      text: "done",
    });
    await s.finish({
      turnId: "c3",
      agentName: CONCIERGE_AGENT_ID,
      chatId: CONCIERGE_CHAT,
      text: "hi",
      status: "interrupted",
    });
    expect(s.backendTurns).toHaveLength(1);
  });
});

describe("Concierge reminder", () => {
  // The reminder's own finish event fires while the reminder runs; a slow
  // settings read must not let it see the guard already cleared.
  it("never reminds the reminder, even when the settings read is slow", async () => {
    const s = setup({ settingsDelayMs: 10 });
    s.onBackendTurn(() => {
      void s.finish({
        turnId: `reminder-${s.backendTurns.length}`,
        agentName: CONCIERGE_AGENT_ID,
        chatId: CONCIERGE_CHAT,
        text: "still not done",
      });
    });
    await s.finish({
      turnId: "c1",
      agentName: CONCIERGE_AGENT_ID,
      chatId: CONCIERGE_CHAT,
      text: "hi",
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(s.backendTurns.map((turn) => turn.prompt)).toEqual([NUDGE_PROMPT]);
  });
});

describe("Concierge chat", () => {
  const serviceWith = (state: Record<string, unknown>, exists: boolean) => {
    const createSession = rs.fn(async () => {});
    const service = new ConciergeService({
      settingsRepo: { get: async () => true },
      webchatRepo: {
        getSession: async (id: string) => (exists && id === CONCIERGE_CHAT_ID ? { id } : null),
        createSession,
      },
      aiToolState: { get: () => state },
    } as unknown as ConciergeDeps);
    return { service, createSession };
  };
  const signedOut = { loggedIn: false, quotaExhausted: false };
  const codexOnly = {
    claude: signedOut,
    codex: { loggedIn: true, quotaExhausted: false, solAccess: true, lunaAccess: true },
  };

  it("creates the chat at its fixed id, on the model the signed-in providers serve best", async () => {
    const { service, createSession } = serviceWith(codexOnly, false);
    const [first, second] = await Promise.all([service.ensureChatId(), service.ensureChatId()]);
    expect([first, second]).toEqual(["concierge", "concierge"]);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith(
      "concierge",
      "Concierge",
      undefined,
      undefined,
      "gpt-6-luna",
      undefined,
      CONCIERGE_AGENT_ID,
    );
  });

  it("leaves an existing chat and its model alone", async () => {
    const { service, createSession } = serviceWith(codexOnly, true);
    expect(await service.ensureChatId()).toBe("concierge");
    expect(createSession).not.toHaveBeenCalled();
  });
});
