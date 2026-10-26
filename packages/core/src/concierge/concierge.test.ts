import { describe, expect, it, rs } from "@rstest/core";
import type { AgentTurnFinishedEvent, BackendTurnParams } from "@rome-os/app-runtime";
import type { SessionToolContext } from "../core/session-tools.js";
import type { ChatApi } from "./chat-api.js";
import { startConciergeEvents } from "./events.js";
import { NUDGE_PROMPT } from "./nudge.js";
import {
  CONCIERGE_AGENT_ID,
  CONCIERGE_CHAT_ID,
  ConciergeService,
  type ConciergeDeps,
} from "./service.js";
import { buildConciergeTools } from "./tools.js";

const CONCIERGE_CHAT = CONCIERGE_CHAT_ID;

function setup(options: { enabled?: boolean } = {}) {
  const sessions = new Map<string, Record<string, unknown>>([
    [CONCIERGE_CHAT, { id: CONCIERGE_CHAT, name: "Concierge", triggerKind: null }],
  ]);
  const messages = new Map<string, Array<{ role: string; content: string }>>();
  const backendTurns: BackendTurnParams[] = [];
  const order: string[] = [];
  const chatApi: ChatApi = {
    createChat: rs.fn(async () => {
      sessions.set("task-1", { id: "task-1", name: "New Chat", triggerKind: null });
      return "task-1";
    }),
    renameChat: rs.fn(async () => {
      order.push("rename");
    }),
    postTurn: rs.fn(async () => {
      order.push("post");
      return { turnId: "task-turn-1", disposition: "started" as const };
    }),
    listChats: rs.fn(async () => []),
    activeTurns: rs.fn(async () => []),
    interruptTurn: rs.fn(async () => {}),
  };
  const deps = {
    settingsRepo: { get: async () => options.enabled ?? true },
    webchatRepo: {
      getSession: async (id: string) => sessions.get(id) ?? null,
      getMessages: async (id: string) => messages.get(id) ?? [],
      getTurnChatMessages: async (id: string) => messages.get(id) ?? [],
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
    },
    sessionManager: { findReusableSession: async () => ({ id: "runtime-1" }) },
    aiToolState: {
      get: () => ({
        claude: { loggedIn: true, quotaExhausted: false },
        codex: { loggedIn: false, quotaExhausted: false, solAccess: false, lunaAccess: false },
      }),
    },
    chatApi,
    runBackendTurn: async (params: BackendTurnParams) => {
      backendTurns.push(params);
    },
  } as unknown as ConciergeDeps;
  const service = new ConciergeService(deps);
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
  return { service, deps, chatApi, messages, backendTurns, order, context, finish, tool };
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
    expect(JSON.parse(result.content[0].text)).toEqual({ chatId: "task-1", turnId: "task-turn-1" });
    expect(s.order).toEqual(["trigger", "post", "rename"]);
    expect(JSON.parse(s.messages.get(CONCIERGE_CHAT)?.[0].content ?? "")).toEqual([
      { type: "task_chat", chatId: "task-1", title: "Flights" },
    ]);
  });

  it("refuses chats it did not start", async () => {
    const s = setup();
    const result = await s.tool("chat_send", { chatId: CONCIERGE_CHAT, text: "hi" });
    expect(result.isError).toBe(true);
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
