// The Concierge under Stop: a stopped task-event turn is not delivered again,
// and the tools that act outside the turn (chat_start, task_upsert) finish or
// write nothing, whatever the turn does around them.

import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { Account, BackendTurnParams } from "@rome-os/app-runtime";
import type { Place } from "../chats/place.js";
import type { Body, SendResult } from "../chats/send.js";
import type { SessionToolContext } from "../core/session-tools.js";
import { ConciergeTasksRepository } from "../db/repositories/concierge-tasks.js";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { startConciergeEvents } from "./events.js";
import {
  CONCIERGE_AGENT_ID,
  CONCIERGE_CHAT_ID,
  ConciergeService,
  TASK_CHAT_TRIGGER_KIND,
  type ConciergeDeps,
  type TaskChats,
} from "./service.js";
import { MIN_FLUSH_SPACING_MS, QUIET_DELAY_MS } from "./task-events.js";
import { ConciergeTasks } from "./tasks.js";
import { buildConciergeTools } from "./tools.js";

let testDb: TestDb;
let repo: ConciergeTasksRepository;
let tasks: ConciergeTasks;
let chatsRepo: WebChatRepository;

beforeEach(async () => {
  testDb = createTestDb();
  repo = new ConciergeTasksRepository(testDb.db);
  tasks = new ConciergeTasks(repo);
  chatsRepo = new WebChatRepository(testDb.db);
  await chatsRepo.createSession(CONCIERGE_CHAT_ID, "Concierge");
});

afterEach(() => {
  rs.useRealTimers();
  testDb.close();
});

function serviceWith(overrides: Partial<ConciergeDeps> = {}) {
  const deps = {
    settingsRepo: { get: async () => true },
    webchatRepo: chatsRepo,
    tasks,
    approvals: { onCreated: () => () => {} },
    messages: { recent: async () => ({ messages: [], older: null }) },
    sessionManager: { findReusableSession: async () => ({ id: "runtime-1" }) },
    aiToolState: { get: () => ({}) },
    runBackendTurn: async () => {},
    ...overrides,
  } as unknown as ConciergeDeps;
  return new ConciergeService(deps);
}

describe("a task-event turn the guardian stopped", () => {
  async function deleteChatOfARow(service: ConciergeService) {
    const [row] = await repo.upsertMany([{ title: "Fix the build", state: "doing" }]);
    service.chatDeleted(row.id);
    return row;
  }

  it("is not delivered again, and its row is not given up", async () => {
    rs.useFakeTimers();
    const turns: BackendTurnParams[] = [];
    const service = serviceWith({
      runBackendTurn: async (params, options) => {
        turns.push(params);
        options?.onStopped?.();
      },
    });
    const notSynced = rs.spyOn(tasks, "markNotSynced");
    startConciergeEvents(service, { onFinished: () => () => {} });
    await deleteChatOfARow(service);

    await rs.advanceTimersByTimeAsync(QUIET_DELAY_MS + 10 * MIN_FLUSH_SPACING_MS);

    expect(turns).toHaveLength(1);
    expect(notSynced).not.toHaveBeenCalled();
  });

  it("is delivered once more when a new message superseded it, instead of a Stop", async () => {
    rs.useFakeTimers();
    const turns: BackendTurnParams[] = [];
    const service = serviceWith({
      runBackendTurn: async (params) => {
        turns.push(params);
      },
    });
    const notSynced = rs.spyOn(tasks, "markNotSynced");
    startConciergeEvents(service, { onFinished: () => () => {} });
    const row = await deleteChatOfARow(service);

    await rs.advanceTimersByTimeAsync(QUIET_DELAY_MS + 10 * MIN_FLUSH_SPACING_MS);

    expect(turns).toHaveLength(2);
    expect(notSynced).toHaveBeenCalledWith(row.id);
  });
});

describe("chat_start when the turn ends while it runs", () => {
  function harness() {
    const turn: { id: string | undefined } = { id: "turn-1" };
    const context: SessionToolContext = {
      agentName: CONCIERGE_AGENT_ID,
      channelThreadKey: `webchat:${CONCIERGE_CHAT_ID}`,
      sessionId: "runtime-1",
      isSubagent: false,
      getTurnId: () => turn.id,
      getThreadContext: () => ({
        channel: "webchat",
        threadId: CONCIERGE_CHAT_ID,
        channelUserId: "guardian",
      }),
    };
    let openChat!: () => void;
    const chatOpens = new Promise<void>((resolve) => {
      openChat = resolve;
    });
    const sent: string[] = [];
    const chats: TaskChats = {
      startChat: rs.fn(async () => {
        await chatOpens;
        await chatsRepo.createSession("task-1", "New Chat");
        return "task-1";
      }),
      isRunning: () => false,
      activeTurns: () => [],
      interruptTurn: async () => {},
    };
    const send = async (_place: Place, body: Body, _as: Account): Promise<SendResult> => {
      sent.push(body.text);
      return {
        ok: true,
        sent: { ref: "task-1:input-1", timestamp: 0 },
        delivery: { state: "sent", at: new Date(0) },
      };
    };
    const service = serviceWith();
    service.attachDashboard({ chats, send });
    const tool = async (name: string) => {
      const found = (await buildConciergeTools(service, context)).find((t) => t.name === name);
      if (!found) throw new Error(`no tool ${name}`);
      return found;
    };
    return { turn, openChat, sent, chats, tool };
  }

  it("still ends with the chat started, its row linked, the brief sent and its card shown", async () => {
    const h = harness();
    const said = await chatsRepo.addBackendMessage(CONCIERGE_CHAT_ID, "turn-1", [
      { type: "text", content: "On it." },
    ]);
    const chatStart = await h.tool("chat_start");

    const call = chatStart.handler({
      title: "Fix the build",
      brief: "Make CI green.",
      card: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Stop (or a new message) ends the turn while the chat is still opening.
    h.turn.id = undefined;
    h.openChat();
    const result = await call;

    expect(result.isError).toBeFalsy();
    expect(h.chats.startChat).toHaveBeenCalledTimes(1);
    expect(await repo.findBySession("task-1")).toMatchObject({
      title: "Fix the build",
      state: "doing",
      sessionId: "task-1",
      sourceMessageId: said.id,
    });
    expect(h.sent).toEqual(["Make CI green."]);
    const spoken = await chatsRepo.getMessages(CONCIERGE_CHAT_ID);
    expect(spoken.map((message) => message.content).join("")).toContain("task_chat");
  });
});

describe("chat_forward when the turn ends while it reads the task chat", () => {
  it("still delivers the forward under the turn that called it", async () => {
    await chatsRepo.createSession("task-1", "Fix the build");
    await chatsRepo.setSessionTrigger("task-1", {
      triggerKind: TASK_CHAT_TRIGGER_KIND,
      triggerName: "Fix the build",
    });
    const turn: { id: string | undefined } = { id: "turn-1" };
    let finishRead!: () => void;
    const readEnds = new Promise<void>((resolve) => {
      finishRead = resolve;
    });
    const service = serviceWith({
      messages: {
        recent: async (place: Place) => {
          await readEnds;
          return {
            messages: [
              {
                id: "answer-1",
                direction: "fromRome",
                place,
                body: { text: "The build is green." },
                at: new Date(0),
              },
            ],
            older: null,
          };
        },
      } as unknown as ConciergeDeps["messages"],
    });
    const tools = await buildConciergeTools(service, {
      agentName: CONCIERGE_AGENT_ID,
      channelThreadKey: `webchat:${CONCIERGE_CHAT_ID}`,
      sessionId: "runtime-1",
      isSubagent: false,
      getTurnId: () => turn.id,
      getThreadContext: () => ({
        channel: "webchat",
        threadId: CONCIERGE_CHAT_ID,
        channelUserId: "guardian",
      }),
    });

    const call = tools.find((tool) => tool.name === "chat_forward")!.handler({ chatId: "task-1" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Stop (or a new message) ends the turn while the read is pending.
    turn.id = undefined;
    finishRead();
    const result = await call;

    expect(result.isError).toBeFalsy();
    const forwarded = (await chatsRepo.getMessages(CONCIERGE_CHAT_ID)).filter((message) =>
      message.content.includes("The build is green."),
    );
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].turnId).toBe("turn-1");
  });
});

describe("task_upsert", () => {
  /** What the Concierge said in the turn, which new rows point to. */
  let said: { id: string };

  beforeEach(async () => {
    said = await chatsRepo.addBackendMessage(CONCIERGE_CHAT_ID, "turn-1", [
      { type: "text", content: "Two things on my list." },
    ]);
  });

  async function upsert(batch: Array<Record<string, unknown>>, holdFirstCheck = false) {
    const turn: { id: string | undefined } = { id: "turn-1" };
    let endTurnAndCheck!: () => void;
    if (holdFirstCheck) {
      // Holds the first entry's message check open, as a slow read would.
      const checkMayEnd = new Promise<void>((resolve) => {
        endTurnAndCheck = resolve;
      });
      const read = chatsRepo.getReplyTarget.bind(chatsRepo);
      let held = false;
      rs.spyOn(chatsRepo, "getReplyTarget").mockImplementation(async (chatId, messageId) => {
        if (!held) {
          held = true;
          await checkMayEnd;
        }
        return read(chatId, messageId);
      });
    }
    const [tool] = (
      await buildConciergeTools(serviceWith(), {
        agentName: CONCIERGE_AGENT_ID,
        channelThreadKey: `webchat:${CONCIERGE_CHAT_ID}`,
        sessionId: "runtime-1",
        isSubagent: false,
        getTurnId: () => turn.id,
        getThreadContext: () => ({
          channel: "webchat",
          threadId: CONCIERGE_CHAT_ID,
          channelUserId: "guardian",
        }),
      })
    ).filter((candidate) => candidate.name === "task_upsert");
    const call = tool.handler({ tasks: batch });
    if (holdFirstCheck) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      // Stop (or a new message) ends the turn while the first message is checked.
      turn.id = undefined;
      endTurnAndCheck();
    }
    return await call;
  }

  it("writes every row of a batch although the turn ended while its first message was checked", async () => {
    const result = await upsert(
      [
        { title: "First", state: "doing", messageId: said.id },
        { title: "Second", state: "next" },
      ],
      true,
    );

    expect(result.isError).toBeFalsy();
    const rows = await repo.listForAgent(false);
    expect(rows.map((row) => row.row.title).sort()).toEqual(["First", "Second"]);
    // The first points to the message passed; the second to the latest of the turn.
    expect(rows.map((row) => row.row.sourceMessageId)).toEqual([said.id, said.id]);
  });

  it("writes none of a batch when one entry cannot be written", async () => {
    const result = await upsert([{ title: "First", state: "doing" }, { id: "no-such-row" }]);

    expect(result.isError).toBe(true);
    expect(await repo.listForAgent(true)).toEqual([]);
  });
});
