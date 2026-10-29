import { describe, expect, it, rs } from "@rstest/core";
import type { Account, AgentTurnFinishedEvent, BackendTurnParams } from "@rome-os/app-runtime";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessagePage } from "../chats/message-repository.js";
import type { SaidMessage } from "../chats/message.js";
import type { Place } from "../chats/place.js";
import type { Body, SendResult } from "../chats/send.js";
import type { SessionToolContext } from "../core/session-tools.js";
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
import { buildConciergeTools } from "./tools.js";

const CONCIERGE_CHAT = CONCIERGE_CHAT_ID;

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

function setup(options: { enabled?: boolean; settingsDelayMs?: number } = {}) {
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
  const chats: TaskChats = {
    startChat: rs.fn(async () => {
      sessions.set("task-1", { id: "task-1", name: "New Chat", triggerKind: null });
      return "task-1";
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
    runBackendTurn: async (params: BackendTurnParams) => {
      backendTurns.push(params);
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
  startConciergeEvents(service, {
    onFinished: (listener) => {
      listeners.push(listener);
      return () => {};
    },
  });
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
    await new Promise((resolve) => setTimeout(resolve, 20));
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
    expect(JSON.parse(result.content[0].text)).toEqual({ chatId: "task-1" });
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
    expect(JSON.parse(result.content[0].text)).toEqual({ chatId: "task-1" });
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
      [{ type: "text", content: "# Report", format: "long" }],
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

  it("chat_card refuses chats it did not start", async () => {
    const s = setup();
    const result = await s.tool("chat_card", { chatId: CONCIERGE_CHAT });
    expect(result.isError).toBe(true);
    expect(s.messages.get(CONCIERGE_CHAT)).toBeUndefined();
  });
});

describe("Concierge events", () => {
  it("reports a task-chat turn it started as a task event", async () => {
    const s = setup();
    await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    await s.finish({
      turnId: "task-turn-1",
      agentName: "core:main",
      chatId: "task-1",
      text: "3 options",
    });
    expect(s.backendTurns).toHaveLength(1);
    expect(s.backendTurns[0]).toMatchObject({
      agentName: CONCIERGE_AGENT_ID,
      threadId: CONCIERGE_CHAT,
    });
    expect(s.backendTurns[0].prompt).toContain('type="task_finished"');
    expect(s.backendTurns[0].prompt).toContain('initiator="concierge"');
    expect(s.backendTurns[0].prompt).toContain("3 options");
  });

  // The receipt of a queued or deferred follow-up names the running turn; a
  // later turn answers it.
  it("reports the turn that answers a queued chat_send follow-up as Concierge's", async () => {
    const s = setup();
    await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    await s.tool("chat_send", { chatId: "task-1", text: "Trains too" });
    s.assignInput("task-1", s.posted[1], "task-turn-2");
    await s.finish({ turnId: "task-turn-1", agentName: "core:main", chatId: "task-1", text: "f" });
    await s.finish({ turnId: "task-turn-2", agentName: "core:main", chatId: "task-1", text: "t" });
    expect(s.backendTurns.map((turn) => turn.prompt.match(/initiator="(\w+)"/)?.[1])).toEqual([
      "concierge",
      "concierge",
    ]);
  });

  it("reports a task-chat turn the guardian started there as the guardian's", async () => {
    const s = setup();
    await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    await s.finish({ turnId: "task-turn-1", agentName: "core:main", chatId: "task-1", text: "f" });
    s.messages
      .get("task-1")
      ?.push({ id: "g1", role: "user", content: "hi", turnId: "task-turn-2" });
    await s.finish({ turnId: "task-turn-2", agentName: "core:main", chatId: "task-1", text: "x" });
    expect(s.backendTurns.at(-1)?.prompt).toContain('initiator="guardian"');
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
