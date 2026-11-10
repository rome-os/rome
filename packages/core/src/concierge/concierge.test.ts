import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type {
  Account,
  AgentTurnFinishedEvent,
  AgentTurnFailure,
  BackendTurnParams,
  ChatId,
} from "@rome-os/app-runtime";
import type { ChatThreadPlacement } from "../db/repositories/webchat.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessagePage } from "../chats/message-repository.js";
import type { SaidMessage } from "../chats/message.js";
import type { Place } from "../chats/place.js";
import type { Body, SendResult } from "../connections/send.js";
import type { SessionToolContext } from "../core/session-tools.js";
import type { NotifyLevel, SendOutcome, SystemNotifyContent } from "../lib/notify-client.js";
import type { ConciergeFollowing } from "./following.js";
import { ChatRepository as StoredChats } from "../chats/storage/chat-repository.js";
import { MessageRepository as StoredMessages } from "../chats/storage/message-repository.js";
import { placeIn } from "../chats/storage/place.js";
import { chatKey } from "../connections/chat-ids.js";
import { ConciergeTasksRepository } from "../db/repositories/concierge-tasks.js";
import { createTestDb, type TestDb } from "../test/db.js";
import { readWebchatMessages } from "../chats/dashboard/webchat.js";
import type { AgentTurnFailedBeforeStart, TurnLifecycleListener } from "../agent/index.js";
import { startConciergeEvents } from "./events.js";
import { RETRY_MS } from "./task-events.js";
import { NUDGE_PROMPT, quotaRecoveryPrompt } from "./nudge.js";
import { mainChatIdOf } from "./owner.js";
import { createConciergeOwners } from "./owners.js";
import {
  CONCIERGE_ACCOUNT,
  CONCIERGE_AGENT_ID,
  CONCIERGE_CHAT_ID,
  ConciergeService,
  type ConciergeDeps,
  type SystemTurnOptions,
  type TaskChats,
  TASK_CHAT_TRIGGER_KIND,
} from "./service.js";
import { ConciergeTasks } from "./tasks.js";
import { buildConciergeTools } from "./tools.js";
import { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";
import {
  reportOf,
  bothAvailable,
  fakeAccounts,
  RESTRICTED_PLAN,
} from "../test/kit/model-accounts.js";
import type { ModelAccountReports } from "../agent/index.js";

const CONCIERGE_CHAT = CONCIERGE_CHAT_ID;
/** A topic chat: another Concierge chat. */
const TOPIC_CHAT = "topic-1";
const isConciergeChatId = (id: string) => id === CONCIERGE_CHAT || id === TOPIC_CHAT;

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
  /** The chat thread the row is in, and whether it is placed there for good. */
  chatThread?: string;
  settled?: boolean;
  /** Where the input stands; `queued` waits for a later turn. */
  inputState?: string;
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

/** The line that opens every Concierge turn's input in the main chat. */
const MAIN_LINE =
  '<concierge_chat id="concierge" name="Concierge" main="true"/>\n<concierge_owner role="guardian"/>\n\n';

/** What the Concierge has already said in its running turn, unless a test says it has not. */
const ACKNOWLEDGEMENT: Row = {
  id: "ack-1",
  role: "assistant",
  content: JSON.stringify([{ type: "text", content: "On it" }]),
  turnId: "concierge-turn-1",
};

function setup(
  options: {
    settingsDelayMs?: number;
    delay?: (ms: number) => Promise<void>;
    startEvents?: boolean;
    /** False: the turn has said nothing yet, so a new task row has no message to point to. */
    said?: boolean;
    /** False: no Rome Cloud push sender is wired. */
    notify?: boolean;
  } = {},
) {
  const testDb = createTestDb();
  opened.push(testDb);
  // The Concierge chats' messages in Chats, each recorded the first time a
  // row points to it, as the fakes here hold their lines elsewhere.
  const sourceChats = new StoredChats(testDb.db);
  const sourceChat = (chatId: string) =>
    sourceChats.start(chatKey("webchat", chatId as ChatId), "dm", null).ref;
  const sourceLines = new StoredMessages(testDb.db);
  const taskRepo = new ConciergeTasksRepository(testDb.db, {
    idOf: (chatId, key) =>
      sourceLines.idOf(sourceChat(chatId), key) ??
      sourceLines.record({
        direction: "toRome",
        key,
        place: placeIn(sourceChat(chatId)),
        saidBy: { account: { platform: "webchat", id: "guardian" } },
        body: { text: "" },
        at: new Date(),
      })?.id ??
      null,
    keysOf: (refs) => {
      const chatOf = new Map(refs.map((ref) => [ref.id, sourceChat(ref.chatId).id]));
      return new Map(
        sourceLines
          .byIds(refs.map((ref) => ref.id))
          .filter((message) => message.place.chat.id === chatOf.get(message.id))
          .map((message) => [message.id, message.key]),
      );
    },
  });
  const tasks = new ConciergeTasks(taskRepo);
  /** The real chat rows the task rows link to. */
  const storedChats = new ChatsWebChatRepository(testDb.db);
  const approvalListeners = new Set<(approval: unknown) => void>();
  const resolvedListeners = new Set<(approval: unknown) => void>();
  const quietFlags: boolean[] = [];
  /** Every guardian setting written, in order. */
  const settingsWrites: [string, unknown][] = [];
  const turnOptions: (SystemTurnOptions | undefined)[] = [];
  /** Every push asked of Rome Cloud, in order. */
  const pushes: SystemNotifyContent[] = [];
  let pushOutcome: () => Promise<SendOutcome> = async () => ({
    kind: "ok",
    attempted: 1,
    sent: 1,
    failed: 0,
  });
  let fake = false;
  const sessions = new Map<string, Record<string, unknown>>([
    [CONCIERGE_CHAT, { id: CONCIERGE_CHAT, name: "Concierge", triggerKind: null }],
    [
      TOPIC_CHAT,
      {
        id: TOPIC_CHAT,
        name: "Calendar",
        triggerKind: null,
        agentName: CONCIERGE_AGENT_ID,
        createdAt: new Date(0),
      },
    ],
  ]);
  // Chat threads as Chats keeps them: a settled row is never moved.
  const placeInThread = (chatId: string, id: string, placement: ChatThreadPlacement) => {
    const rows = messages.get(chatId) ?? [];
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) return null;
    if (row.settled) return row.chatThread ?? id;
    const threadOf = (key: string) =>
      rows.find((candidate) => candidate.id === key)?.chatThread ?? key;
    if ("in" in placement) {
      // A message in no thread that a reply joins becomes its root, as Chats does.
      const root = rows.find((candidate) => candidate.id === placement.in);
      if (root && !root.chatThread && root !== row) {
        root.chatThread = root.id;
        root.settled = true;
      }
    }
    row.chatThread = "in" in placement ? threadOf(placement.in) : id;
    row.settled = placement.settle === true;
    return row.chatThread;
  };
  /** The Concierge chat the tools' turn runs in. */
  const here = {
    chat: CONCIERGE_CHAT as string,
    pushLevel: undefined as NotifyLevel | undefined,
    threadAnchor: undefined as string | undefined,
    turnId: "concierge-turn-1",
  };
  const messages = new Map<string, Row[]>();
  /** Every input posted to a task chat, by id, in order. */
  const posted: string[] = [];
  /** What the next send answers when it is refused. */
  let refuseWith: Exclude<SendResult, { ok: true }> | null = null;
  const backendTurns: BackendTurnParams[] = [];
  const order: string[] = [];
  let startedChats = 0;
  let saidCount = 0;
  const chats: TaskChats = {
    startChat: rs.fn(async () => {
      const id = `task-${++startedChats}`;
      sessions.set(id, { id, name: "New Chat", triggerKind: null });
      await storedChats.createSession(id, "New Chat");
      return id;
    }),
    openSession: rs.fn(async (chatId: string) => `opened-${chatId}`),
    sendAsGuardian: rs.fn(async () => {}),
    isRunning: rs.fn(() => false),
    isBusy: rs.fn(() => false),
    openTool: rs.fn(() => null),
    onTurnChange: rs.fn(() => () => {}),
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
    skillCatalog: {
      find: (name: string) => (name === "coding:app_creation" ? { name } : undefined),
    },
    settingsRepo: {
      get: async () => {
        if (options.settingsDelayMs)
          await new Promise((resolve) => setTimeout(resolve, options.settingsDelayMs));
        return null;
      },
      set: async (key: string, value: unknown) => {
        settingsWrites.push([key, value]);
      },
    },
    webchatRepo: {
      getSession: async (id: string) => sessions.get(id) ?? null,
      listSessions: async () => [...sessions.values()],
      updateSessionLargeModelSelection: rs.fn(async (id: string, largeModelSelection: string) => {
        sessions.set(id, { ...sessions.get(id), largeModelSelection });
      }),
      updateSessionName: rs.fn(async (id: string, name: string) => {
        order.push("rename");
        sessions.set(id, { ...sessions.get(id), name });
      }),
      getTurnChatMessages: async (id: string, turnId: string) =>
        [
          ...(isConciergeChatId(id) && options.said !== false ? [ACKNOWLEDGEMENT] : []),
          ...(messages.get(id) ?? []),
        ].filter((row) => !row.turnId || row.turnId === turnId),
      addBackendMessage: rs.fn(
        async (
          chatId: string,
          turnId: string,
          parts: unknown[],
          placed: { chatThread?: ChatThreadPlacement } = {},
        ) => {
          const list = messages.get(chatId) ?? [];
          const id = `said-${++saidCount}`;
          list.push({ id, role: "assistant", content: JSON.stringify(parts), turnId });
          messages.set(chatId, list);
          if (placed.chatThread) placeInThread(chatId, id, placed.chatThread);
          return { id };
        },
      ),
      placeInChatThread: async (chatId: string, id: string, placement: ChatThreadPlacement) =>
        placeInThread(chatId, id, placement),
      getReplyTarget: async (chatId: string, messageId: string) => {
        const row = [
          ...(isConciergeChatId(chatId) && options.said !== false ? [ACKNOWLEDGEMENT] : []),
          ...(messages.get(chatId) ?? []),
        ].find(
          (candidate) =>
            candidate.id === messageId &&
            (candidate.role === "user" || candidate.role === "assistant"),
        );
        return row ? { ...row, chatThreadId: row.chatThread ?? null } : null;
      },
      setSessionTrigger: rs.fn(
        async (id: string, trigger: { triggerKind: string; triggerName: string | null }) => {
          order.push("trigger");
          sessions.set(id, { ...sessions.get(id), ...trigger });
        },
      ),
      createSession: rs.fn(async () => {}),
      listProjects: async () => [{ path: "default" }, { path: "rome-oss" }],
      // The activity's own sources (activity.test.ts covers it).
      onMessageInserted: () => () => {},
      awaitingGuardianSince: async () => new Map<string, number>(),
      ownerSpokeAt: async () => null,
    },
    tasks,
    approvals: {
      onCreated: (listener: (approval: unknown) => void) => {
        approvalListeners.add(listener);
        return () => approvalListeners.delete(listener);
      },
      onResolved: (listener: (approval: unknown) => void) => {
        resolvedListeners.add(listener);
        return () => resolvedListeners.delete(listener);
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
    sessionRepository: { current: async () => ({ id: "runtime-1" }) },
    agentSessionManager: { find: rs.fn(() => ({ selectModel: rs.fn() })) },
    accounts: fakeAccounts({
      anthropic: reportOf("available"),
      openai: reportOf("unauthorized"),
    }),
    runBackendTurn: async (params: BackendTurnParams, turn?: SystemTurnOptions) => {
      backendTurns.push(params);
      quietFlags.push(turn?.quiet === true);
      turnOptions.push(turn);
      return (await onBackendTurn(params)) ?? "completed";
    },
    ...(options.notify === false
      ? {}
      : {
          notify: {
            send: async (content: SystemNotifyContent) => {
              pushes.push(content);
              return await pushOutcome();
            },
          },
        }),
  } as unknown as ConciergeDeps;
  /** A system turn's outcome: it ran to its end unless the hook says it failed. */
  type BackendOutcome = "completed" | "stopped" | "interrupted" | "failed" | undefined;
  let onBackendTurn: (
    params: BackendTurnParams,
  ) => Promise<BackendOutcome | void> | BackendOutcome | void = () => {};
  const service = new ConciergeService(deps);
  service.attachDashboard({ chats, send });
  const context = (agentName = CONCIERGE_AGENT_ID): SessionToolContext => ({
    agentName,
    channelThreadKey: `webchat:${here.chat}`,
    sessionId: "runtime-1",
    isSubagent: false,
    getTurnId: () => here.turnId,
    getThreadContext: () => ({
      channel: "webchat",
      threadId: here.chat,
      channelUserId: "guardian",
    }),
    getTurnPushLevel: () => here.pushLevel,
    getTurnThreadAnchor: () => here.threadAnchor,
  });
  const listeners: Array<(event: AgentTurnFinishedEvent) => void> = [];
  const failedBeforeStartListeners: Array<(event: AgentTurnFailedBeforeStart) => void> = [];
  const startEvents = () =>
    startConciergeEvents(
      service,
      {
        listen: (listener: TurnLifecycleListener) => {
          if (listener.ended) listeners.push(listener.ended);
          if (listener.couldNotStart) failedBeforeStartListeners.push(listener.couldNotStart);
          return () => {};
        },
      },
      { delay: options.delay },
    );
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
    failure?: AgentTurnFailure;
    startedAt?: string;
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
        timing: { startedAt: event.startedAt ?? "", finishedAt: "", durationMs: 0 },
        output: {
          text: event.text ?? "",
          state: "final",
          ...(event.failure ? { failure: event.failure } : {}),
        },
        metrics: { toolCallCount: 0, skillWritten: false },
      });
    }
    await settle();
  };
  /** A turn in a chat that failed before it started, as an agent session tells it. */
  const failBeforeStart = async (event: { turnId: string; chatId: string; error: string }) => {
    for (const listener of failedBeforeStartListeners) {
      listener({
        turn: {
          sessionId: "runtime-x",
          turnId: event.turnId,
          agentName: "core:main",
          threadContext: { channel: "webchat", threadId: event.chatId },
        },
        error: event.error,
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
    settingsWrites,
    turnOptions,
    pushes,
    /** Runs the tools' turn as one the guardian did not start, pushed at this level. */
    pushLevel: (level: NotifyLevel | undefined) => {
      here.pushLevel = level;
    },
    /** Runs the tools' turn as one that answers this message without having started from it. */
    threadAnchor: (messageId: string | undefined) => {
      here.threadAnchor = messageId;
    },
    /** The tools run in turn `turnId` from here on. */
    inTurn: (turnId: string) => {
      here.turnId = turnId;
    },
    pushAnswers: (outcome: () => Promise<SendOutcome>) => {
      pushOutcome = outcome;
    },
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
    resolveApproval: (approval: Record<string, unknown>) => {
      for (const listener of resolvedListeners) listener(approval);
    },
    chats,
    send,
    messages,
    backendTurns,
    order,
    context,
    finish,
    failBeforeStart,
    tool,
    posted,
    assignInput,
    sessions,
    /** Runs the tools' turn in another Concierge chat. */
    turnIn: (chatId: string) => {
      here.chat = chatId;
    },
    refuseSends: (result: Exclude<SendResult, { ok: true }>) => {
      refuseWith = result;
    },
    onBackendTurn: (handler: typeof onBackendTurn) => {
      onBackendTurn = handler;
    },
  };
}

describe("Concierge tools", () => {
  it("register only for the Concierge agent", async () => {
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
      "topic_start",
      "chat_forward",
      "chat_card",
      "connect_card",
    ]);
    expect(await buildConciergeTools(on.service, on.context("core:main"))).toEqual([]);
  });

  it("uses task cards as the needs_user anchor for task questions and approvals", async () => {
    const s = setup();
    const tools = await buildConciergeTools(s.service, s.context());
    const upsert = tools.find((tool) => tool.name === "task_upsert")!;
    const schema = upsert.inputSchema as {
      properties: { tasks: { items: { properties: { messageId: { description: string } } } } };
    };
    for (const description of [
      upsert.description,
      schema.properties.tasks.items.properties.messageId.description,
    ]) {
      expect(description).toContain("show a task question or approval with chat_card");
      expect(description).toContain("otherwise ask with say or chat_forward");
      expect(description).toContain("Use the returned messageId as the row anchor");
    }
    const card = tools.find((tool) => tool.name === "chat_card")!;
    expect(card.description).toContain("for a task question or approval");
    expect(card.description).toContain("returned messageId as the needs_user row anchor");
    expect(card.description).toContain(
      "An existing task row automatically points to this card in this Concierge chat",
    );
    expect(schema.properties.tasks.items.properties.messageId.description).toContain(
      "chat_card and chat_forward update this anchor automatically",
    );
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

  describe("chat threads", () => {
    const threadOf = (s: ReturnType<typeof setup>, id: string) =>
      s.messages.get(CONCIERGE_CHAT)?.find((row) => row.id === id)?.chatThread;
    const guardianSays = (s: ReturnType<typeof setup>, row: Partial<Row> & { id: string }) => {
      const list = s.messages.get(CONCIERGE_CHAT) ?? [];
      list.push({ role: "user", content: "[]", turnId: "concierge-turn-1", ...row });
      s.messages.set(CONCIERGE_CHAT, list);
    };
    const saidId = (result: unknown) =>
      JSON.parse((result as { content: { text: string }[] }).content[0]!.text).messageId as string;

    it("leaves a plain question and its answer in no thread", async () => {
      const s = setup({ said: false });
      guardianSays(s, { id: "g1" });

      const said = saidId(await s.tool("say", { text: "Sunny, 24°" }));

      expect(threadOf(s, "g1")).toBeUndefined();
      expect(threadOf(s, said)).toBeUndefined();
    });

    it("answers a message in a thread in that thread, and one in none in none", async () => {
      const s = setup({ said: false });
      guardianSays(s, { id: "g1" });
      guardianSays(s, { id: "g2", chatThread: "flights", settled: true });

      const first = saidId(await s.tool("say", { text: "About the first" }));
      const second = saidId(await s.tool("say", { text: "Flights update", answers: "g2" }));

      expect(threadOf(s, first)).toBeUndefined();
      expect(threadOf(s, second)).toBe("flights");
      expect(threadOf(s, "g1")).toBeUndefined();
      await expect(s.tool("say", { text: "x", answers: "elsewhere" })).resolves.toMatchObject({
        isError: true,
      });
      // In a turn the guardian started, a named thread changes nothing.
      const ignored = saidId(await s.tool("say", { text: "Still here", thread: "flights" }));
      expect(threadOf(s, ignored)).toBeUndefined();
    });

    it("puts an answer in no thread when the turn holds several guardian messages and names none", async () => {
      const s = setup({ said: false });
      // Three tasks started from one message, which is now their thread's root.
      guardianSays(s, { id: "tasks", chatThread: "tasks", settled: true, turnId: "older" });
      // Taken by one turn: the Nile follow-up, already relayed into the tasks' thread, and an unrelated question.
      guardianSays(s, { id: "nile", chatThread: "tasks", settled: true });
      guardianSays(s, { id: "squared" });

      const answer = saidId(await s.tool("say", { text: "Also, 9 squared is 81." }));
      const relayed = saidId(await s.tool("say", { text: "Asked for miles", answers: "nile" }));

      expect(threadOf(s, answer)).toBeUndefined();
      expect(threadOf(s, relayed)).toBe("tasks");
    });

    it("puts a task's result and card in the thread of the guardian message that started it", async () => {
      const s = setup({ said: false });
      guardianSays(s, { id: "g0" });
      const ack = saidId(await s.tool("say", { text: "On it" }));
      const { chatId } = JSON.parse(
        (await s.tool("chat_start", { title: "Flights", brief: "Find flights" })).content[0].text,
      );
      // The answer to the guardian's message stays where it was: in no thread.
      expect(threadOf(s, ack)).toBeUndefined();

      // Later, a turn about the task, which no guardian message started.
      s.inTurn("task-event-turn");
      s.threadAnchor(ack);
      const result = saidId(await s.tool("say", { text: "Found 3 flights" }));
      const card = saidId(await s.tool("chat_card", { chatId }));

      expect(threadOf(s, "g0")).toBe("g0");
      expect(threadOf(s, result)).toBe("g0");
      expect(threadOf(s, card)).toBe("g0");
      expect(threadOf(s, ack)).toBeUndefined();
    });

    it("keeps a task's story under one root: a later card in its thread may take the anchor", async () => {
      const s = setup({ said: false });
      guardianSays(s, { id: "g0" });
      const ack = saidId(await s.tool("say", { text: "On it" }));
      const { chatId, taskId } = JSON.parse(
        (await s.tool("chat_start", { title: "Flights", brief: "Find flights" })).content[0].text,
      );
      s.inTurn("task-event-turn");
      s.threadAnchor(ack);
      await s.tool("say", { text: "Found 3 flights" });

      // A later turn shows the task's card again: it reports in the task's
      // thread, so the row may point to it, under the same root.
      s.inTurn("later-turn");
      s.threadAnchor(undefined);
      const card = saidId(await s.tool("chat_card", { chatId }));
      expect(threadOf(s, card)).toBe("g0");
      expect((await s.tasks.repo.getWithChat(taskId))?.sourceMessageId).toBe(card);
      s.inTurn("next-event-turn");
      s.threadAnchor(card);
      expect(threadOf(s, saidId(await s.tool("say", { text: "Booked" })))).toBe("g0");
    });

    it("lets a turn about several tasks name the thread a message reports on, never a new one", async () => {
      const s = setup({ said: false });
      guardianSays(s, { id: "g0", chatThread: "g0", settled: true, turnId: "older" });
      s.inTurn("task-events-turn");

      const named = saidId(await s.tool("say", { text: "Both done", thread: "g0" }));
      expect(threadOf(s, named)).toBe("g0");
      await expect(s.tool("say", { text: "x", thread: "new" })).resolves.toMatchObject({
        isError: true,
      });
    });

    it("keeps a task's root when a later task_upsert points it at another message", async () => {
      const s = setup({ said: false });
      guardianSays(s, { id: "g0" });
      const ack = saidId(await s.tool("say", { text: "On it" }));
      const { taskId } = JSON.parse(
        (await s.tool("chat_start", { title: "Flights", brief: "Find flights" })).content[0].text,
      );
      s.inTurn("task-event-turn");
      s.threadAnchor(ack);
      await s.tool("say", { text: "Found 3 flights" });

      s.inTurn("later-turn");
      guardianSays(s, { id: "g1", turnId: "later-turn" });
      const later = saidId(await s.tool("say", { text: "Which one?" }));
      const result = JSON.parse(
        (await s.tool("task_upsert", { tasks: [{ id: taskId, messageId: later }] })).content[0]
          .text,
      );
      expect(result.tasks[0]).toMatchObject({ anchor: ack, anchorKept: true });
      expect((await s.tasks.repo.getWithChat(taskId))?.sourceMessageId).toBe(ack);
      expect(threadOf(s, "g1")).toBeUndefined();
    });

    it("sends on only the guardian message it names, or the turn's only one", async () => {
      const s = setup({ said: false });
      guardianSays(s, { id: "g0", turnId: "start-turn" });
      s.inTurn("start-turn");
      await s.tool("say", { text: "On it" });
      const { chatId } = JSON.parse(
        (await s.tool("chat_start", { title: "Flights", brief: "Find flights" })).content[0].text,
      );

      s.inTurn("two-messages");
      guardianSays(s, { id: "saturday", turnId: "two-messages" });
      guardianSays(s, { id: "squared", turnId: "two-messages" });
      await s.tool("chat_send", { chatId, text: "Make it Saturday" });
      expect([threadOf(s, "saturday"), threadOf(s, "squared")]).toEqual([undefined, undefined]);

      await s.tool("chat_send", { chatId, text: "Make it Saturday", answers: "saturday" });
      expect([threadOf(s, "saturday"), threadOf(s, "squared")]).toEqual(["g0", undefined]);
    });

    it("lets a report name the thread a guardian's reply started", async () => {
      const s = setup({ said: false });
      guardianSays(s, { id: "answer", role: "assistant", turnId: "older" });
      guardianSays(s, { id: "reply", turnId: "older" });
      await s.deps.webchatRepo.placeInChatThread(CONCIERGE_CHAT, "reply", {
        in: "answer",
        settle: true,
      });
      expect(threadOf(s, "answer")).toBe("answer");

      s.inTurn("task-events-turn");
      const said = saidId(await s.tool("say", { text: "Update", thread: "answer" }));
      expect(threadOf(s, said)).toBe("answer");
    });

    it("puts a task's card in its thread when the guardian asks for it from the timeline", async () => {
      const s = setup({ said: false });
      guardianSays(s, { id: "g0" });
      const ack = saidId(await s.tool("say", { text: "On it" }));
      const { chatId } = JSON.parse(
        (await s.tool("chat_start", { title: "Flights", brief: "Find flights" })).content[0].text,
      );
      s.inTurn("task-event-turn");
      s.threadAnchor(ack);
      await s.tool("say", { text: "Found 3 flights" });

      // "Show me the flights task", typed in the main composer.
      s.inTurn("show-turn");
      s.threadAnchor(undefined);
      guardianSays(s, { id: "show", turnId: "show-turn" });
      const card = saidId(await s.tool("chat_card", { chatId }));
      expect(threadOf(s, card)).toBe("g0");
      expect(threadOf(s, "show")).toBeUndefined();
    });

    it("keeps a task's root before its first result, and jumps to the forwarded result after", async () => {
      const s = setup({ said: false });
      guardianSays(s, { id: "g0" });
      const ack = saidId(await s.tool("say", { text: "On it" }));
      const { chatId, taskId } = JSON.parse(
        (await s.tool("chat_start", { title: "Flights", brief: "Find flights" })).content[0].text,
      );
      // "How's it going?" before any result: the card does not take the task.
      s.inTurn("progress-turn");
      guardianSays(s, { id: "g1", turnId: "progress-turn" });
      await s.tool("chat_card", { chatId });
      expect((await s.tasks.repo.getWithChat(taskId))?.sourceMessageId).toBe(ack);

      // The first result is forwarded: it roots at g0, and the row now jumps to it.
      s.messages.get(chatId)?.push({
        role: "assistant",
        content: JSON.stringify([{ type: "text", content: "3 options" }]),
      });
      s.inTurn("task-event-turn");
      s.threadAnchor(ack);
      const forwarded = JSON.parse((await s.tool("chat_forward", { chatId })).content[0].text)
        .messageId as string;
      expect(threadOf(s, forwarded)).toBe("g0");
      expect(threadOf(s, "g1")).toBeUndefined();
      expect((await s.tasks.repo.getWithChat(taskId))?.sourceMessageId).toBe(forwarded);
    });

    it("takes the guardian's words sent on to a task into the task's thread, but never a reply", async () => {
      const s = setup({ said: false });
      guardianSays(s, { id: "g0", turnId: "start-turn" });
      s.inTurn("start-turn");
      const ack = saidId(await s.tool("say", { text: "On it" }));
      const { chatId } = JSON.parse(
        (await s.tool("chat_start", { title: "Flights", brief: "Find flights" })).content[0].text,
      );

      // A follow-up typed in the composer, sent on to the task.
      s.inTurn("follow-up-turn");
      guardianSays(s, { id: "g1", turnId: "follow-up-turn" });
      guardianSays(s, { id: "g2", turnId: "follow-up-turn", chatThread: "weather", settled: true });
      await s.tool("chat_send", { chatId, text: "Make it Saturday" });
      const answer = saidId(await s.tool("say", { text: "Told it Saturday", answers: "g1" }));

      expect(threadOf(s, "g0")).toBe("g0");
      expect(threadOf(s, "g1")).toBe("g0");
      expect(threadOf(s, answer)).toBe("g0");
      // A reply the guardian made elsewhere stays put.
      expect(threadOf(s, "g2")).toBe("weather");
      expect(threadOf(s, ack)).toBeUndefined();
    });

    it("a task event's turn answers the message that started the first task it names", async () => {
      const s = setup();
      const [row] = await s.tasks.repo.upsertMany([
        { title: "Flights", state: "doing", chatId: CONCIERGE_CHAT, sourceMessageId: "ack-1" },
      ]);
      const resolved = await s.service.resolveTurn({
        agentName: CONCIERGE_AGENT_ID,
        sessionId: "runtime-1",
        channel: "webchat",
        threadId: CONCIERGE_CHAT,
        prompt: `<task_events>\n<task id="${row!.id}" title="Flights">\n</task>\n</task_events>`,
      });
      const woken = await s.service.resolveTurn({
        agentName: CONCIERGE_AGENT_ID,
        sessionId: "runtime-1",
        channel: "webchat",
        threadId: CONCIERGE_CHAT,
        prompt: `⏰ Time's up: check task:${row!.id}`,
      });

      expect(resolved.threadAnchor).toBe("ack-1");
      expect(woken.threadAnchor).toBe("ack-1");
    });
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

  it("chat_start passes a catalog skill to the task chat's first turn", async () => {
    const s = setup();
    const result = await s.tool("chat_start", {
      title: "Build a tracker",
      brief: "Build a habit tracker",
      skill: "coding:app_creation",
    });
    expect(result.isError).not.toBe(true);
    expect(s.send).toHaveBeenCalledWith(
      expect.objectContaining({ chat: expect.objectContaining({ id: "task-1" }) }),
      { text: "Build a habit tracker", skillName: "coding:app_creation" },
      CONCIERGE_ACCOUNT,
    );
    expect(s.order).toEqual(["trigger", "post", "rename"]);
  });

  it.each([
    "missing:skill",
  ])("chat_start rejects an invalid skill %s before starting anything", async (skill) => {
    const s = setup();
    const result = await s.tool("chat_start", { title: "Build", brief: "Build it", skill });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown skill");
    expect(s.chats.startChat).not.toHaveBeenCalled();
    expect(s.send).not.toHaveBeenCalled();
    expect(await s.tasks.repo.listForAgent(false)).toEqual([]);
  });

  it.each([null, ""])("chat_start treats skill %s as no skill", async (skill) => {
    const s = setup();
    const result = await s.tool("chat_start", { title: "Build", brief: "Build it", skill });
    expect(result.isError).not.toBe(true);
    expect(s.send).toHaveBeenCalledWith(expect.anything(), { text: "Build it" }, CONCIERGE_ACCOUNT);
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
      expect(s.chats.startChat).toHaveBeenCalledWith(
        { agentName: undefined, projectPath: "rome-oss" },
        "guardian",
      );
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

  it("chat_read and chat_list call a task chat whose latest turn failed failed, unless it runs or waits", async () => {
    const s = setup();
    await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    const status = async () =>
      JSON.parse((await s.tool("chat_read", { chatId: "task-1" })).content[0].text).status;
    s.sessions.set("task-1", { ...s.sessions.get("task-1"), lastTurnFailed: true });
    expect(await status()).toBe("failed");
    const failed = await s.tool("chat_list", { status: "failed" });
    expect(JSON.parse(failed.content[0].text)).toMatchObject([
      { chatId: "task-1", status: "failed" },
    ]);

    s.sessions.set("task-1", { ...s.sessions.get("task-1"), awaitingGuardian: true });
    expect(await status()).toBe("waiting_input");
    s.chats.isRunning = () => true;
    expect(await status()).toBe("running");
  });

  it("chat_forward says the latest answer, not a later follow-up", async () => {
    const s = setup();
    const started = JSON.parse(
      (await s.tool("chat_start", { title: "Flights", brief: "Find flights" })).content[0].text,
    );
    s.messages.get("task-1")?.push({
      role: "assistant",
      content: JSON.stringify([{ type: "text", content: "# Report" }]),
    });
    await s.tool("chat_send", { chatId: "task-1", text: "Trains too" });
    const result = await s.tool("chat_forward", { chatId: "task-1" });
    expect(JSON.parse(result.content[0].text)).toEqual({
      forwardedChars: 8,
      messageId: "said-1",
      taskAnchored: started.taskId,
    });
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

  it("chat_list labels each chat with its kind, and a task chat with the Concierge chat it came from", async () => {
    const s = setup();
    await s.storedChats.createSession(TOPIC_CHAT, "Calendar");
    await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    s.turnIn(TOPIC_CHAT);
    await s.tool("chat_start", { title: "Agenda", brief: "Read the calendar" });
    s.turnIn(CONCIERGE_CHAT);
    const result = await s.tool("chat_list", {});
    expect(JSON.parse(result.content[0].text)).toEqual([
      { chatId: TOPIC_CHAT, title: "Calendar", kind: "topic chat" },
      {
        chatId: "task-1",
        title: "Flights",
        kind: "task chat",
        from: { chatId: CONCIERGE_CHAT, title: "Concierge" },
        status: "idle",
      },
      {
        chatId: "task-2",
        title: "Agenda",
        kind: "task chat",
        from: { chatId: TOPIC_CHAT, title: "Calendar" },
        status: "idle",
      },
    ]);
    // From the topic chat, the main chat is the other one.
    s.turnIn(TOPIC_CHAT);
    const fromTopic = await s.tool("chat_list", {});
    expect(JSON.parse(fromTopic.content[0].text)[0]).toEqual({
      chatId: CONCIERGE_CHAT,
      title: "Concierge",
      kind: "main chat",
    });
    // A status filter lists task chats only.
    const idle = await s.tool("chat_list", { status: "idle" });
    expect(JSON.parse(idle.content[0].text).map((chat: { kind: string }) => chat.kind)).toEqual([
      "task chat",
      "task chat",
    ]);
  });

  it("chat_read reads another Concierge chat, and refuses a chat that is neither kind", async () => {
    const s = setup();
    s.messages.set(TOPIC_CHAT, [
      { role: "user", content: JSON.stringify([{ type: "text", content: "only interviews" }]) },
    ]);
    const read = await s.tool("chat_read", { chatId: TOPIC_CHAT });
    expect(read.isError).toBeFalsy();
    expect(JSON.parse(read.content[0].text)).toMatchObject({
      chatId: TOPIC_CHAT,
      title: "Calendar",
      kind: "topic chat",
      messages: [{ role: "user", text: "only interviews" }],
    });
    s.sessions.set("plain", { id: "plain", name: "Plain", triggerKind: null });
    const refused = await s.tool("chat_read", { chatId: "plain" });
    expect(refused.isError).toBe(true);
    // Sending stays for task chats.
    const send = await s.tool("chat_send", { chatId: TOPIC_CHAT, text: "hi" });
    expect(send.isError).toBe(true);
  });

  it("a task started in a topic chat comes from it, and its events go back there", async () => {
    const s = setup();
    await s.storedChats.createSession(TOPIC_CHAT, "Calendar");
    s.turnIn(TOPIC_CHAT);
    const started = JSON.parse(
      (await s.tool("chat_start", { title: "Agenda", brief: "Read the calendar" })).content[0].text,
    ) as { taskId: string };
    const [row] = await s.tasks.listForPanel();
    expect(row).toMatchObject({
      id: started.taskId,
      conciergeChat: { id: TOPIC_CHAT, name: "Calendar", main: false },
    });
    await s.finish({ turnId: "task-turn-1", agentName: "main", chatId: "task-1" });
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    expect(s.backendTurns.at(-1)).toMatchObject({ threadId: TOPIC_CHAT });
    expect(s.backendTurns.at(-1)?.prompt).toContain(
      '<concierge_chat id="topic-1" name="Calendar" main="false"/>',
    );
  });

  it("topic_start starts a topic chat and answers its link", async () => {
    const s = setup();
    const result = await s.tool("topic_start", { name: "Trips" });
    const started = JSON.parse(result.content[0].text) as { chatId: string; link: string };
    expect(started.link).toBe(`/chat/${started.chatId}`);
    expect(s.deps.webchatRepo.createSession).toHaveBeenCalledWith(
      started.chatId,
      "Trips",
      undefined,
      undefined,
      // The main chat has no stored model, so the pick for a new chat.
      "claude-sonnet",
      undefined,
      CONCIERGE_AGENT_ID,
      "webchat",
      null,
      { ownerKey: "guardian" },
    );
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
      sourceMessageId: null,
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

describe("Concierge task anchors", () => {
  const text = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);
  const anchorOf = async (s: ReturnType<typeof setup>, taskId: string) =>
    (await s.taskRepo.getWithChat(taskId))?.sourceMessageId;
  const created = async (s: ReturnType<typeof setup>, entry: Record<string, unknown>) =>
    text(await s.tool("task_upsert", { tasks: [{ title: "Pay rent", ...entry }] })).tasks[0].id;

  it("say, chat_card and chat_forward answer the id of the message they stored", async () => {
    const s = setup();
    const said = text(await s.tool("say", { text: "On it" }));
    expect(said).toEqual({ sent: expect.any(String), messageId: "said-1" });
    await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    s.messages.get("task-1")?.push({
      role: "assistant",
      content: JSON.stringify([{ type: "text", content: "3 options" }]),
    });
    expect(text(await s.tool("chat_card", { chatId: "task-1" }))).toEqual({
      sent: expect.any(String),
      messageId: "said-2",
    });
    expect(text(await s.tool("chat_forward", { chatId: "task-1" })).messageId).toBe("said-3");
  });

  it.each([
    [CONCIERGE_CHAT, CONCIERGE_CHAT],
    [TOPIC_CHAT, TOPIC_CHAT],
    [CONCIERGE_CHAT, TOPIC_CHAT],
    [TOPIC_CHAT, CONCIERGE_CHAT],
  ] as const)("anchors a task created in %s to its result forwarded in %s before completion", async (createdIn, forwardedIn) => {
    const s = setup({ said: false });
    await s.storedChats.createSession(CONCIERGE_CHAT, "Concierge");
    await s.storedChats.createSession(TOPIC_CHAT, "Calendar");
    s.turnIn(createdIn);
    const acknowledgment = text(await s.tool("say", { text: "Looking into flights" })).messageId;
    const { chatId, taskId } = text(
      await s.tool("chat_start", { title: "Flights", brief: "Find flights" }),
    );
    expect(await anchorOf(s, taskId)).toBe(acknowledgment);
    expect((await s.taskRepo.get(taskId))?.chatId).toBe(
      createdIn === CONCIERGE_CHAT ? null : createdIn,
    );
    const [before] = await s.taskRepo.upsertMany(
      [{ id: taskId, summary: "Searching", waitingOn: "Results", rank: 3, dueAt: new Date(1000) }],
      new Date(0),
    );
    s.tasks.markNotSynced(taskId);
    await s.settle();
    const emit = rs.fn();
    s.tasks.subscribe(emit);
    s.messages.get(chatId)?.push({
      role: "assistant",
      content: JSON.stringify([{ type: "text", content: "3 options" }]),
    });

    s.turnIn(forwardedIn);
    const result = await s.tool("chat_forward", { chatId });
    expect(result.isError).toBeFalsy();
    const forwarded = text(result);
    expect(s.messages.get(forwardedIn)?.at(-1)?.id).toBe(forwarded.messageId);
    expect(await anchorOf(s, taskId)).toBe(forwarded.messageId);
    expect(forwarded).toEqual({ forwardedChars: 9, messageId: "said-2", taskAnchored: taskId });
    expect(await s.taskRepo.get(taskId)).toEqual({
      ...before,
      chatId: forwardedIn === CONCIERGE_CHAT ? null : forwardedIn,
      sourceMessageId: expect.any(Number),
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("task_upsert", {
      task: expect.objectContaining({
        id: taskId,
        conciergeChat: expect.objectContaining({ id: forwardedIn }),
        sourceMessageId: forwarded.messageId,
        notSynced: true,
      }),
    });

    const completed = text(await s.tool("task_upsert", { tasks: [{ id: taskId, state: "done" }] }));
    expect(completed.tasks[0]).toMatchObject({ anchor: forwarded.messageId, anchorKept: true });
    expect(await anchorOf(s, taskId)).toBe(forwarded.messageId);
    expect((await s.tasks.listForPanel())[0]).toMatchObject({
      state: "done",
      conciergeChat: expect.objectContaining({ id: forwardedIn }),
      sourceMessageId: forwarded.messageId,
      notSynced: false,
    });
  });

  it("forwarding again keeps a finished row's completion time and other fields", async () => {
    const s = setup();
    const { chatId, taskId } = text(
      await s.tool("chat_start", { title: "Flights", brief: "Find flights" }),
    );
    const [before] = await s.taskRepo.upsertMany(
      [{ id: taskId, state: "done", archived: true, summary: "3 options", rank: 2 }],
      new Date(0),
    );
    s.messages.get(chatId)?.push({
      role: "assistant",
      content: JSON.stringify([{ type: "text", content: "3 options" }]),
    });
    const forwarded = text(await s.tool("chat_forward", { chatId }));
    expect(await anchorOf(s, taskId)).toBe(forwarded.messageId);
    expect(forwarded.taskAnchored).toBe(taskId);
    expect(await s.taskRepo.get(taskId)).toEqual({
      ...before,
      sourceMessageId: expect.any(Number),
    });
  });

  it("forwards a task chat without a task row without creating one", async () => {
    const s = setup();
    const chatId = await s.chats.startChat({}, "guardian");
    await s.deps.webchatRepo.setSessionTrigger(chatId, {
      triggerKind: TASK_CHAT_TRIGGER_KIND,
      triggerName: null,
    });
    s.messages.set(chatId, [
      {
        role: "assistant",
        content: JSON.stringify([{ type: "text", content: "3 options" }]),
      },
    ]);
    const result = await s.tool("chat_forward", { chatId });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toEqual({ forwardedChars: 9, messageId: "said-1" });
    expect(await s.taskRepo.findBySession(chatId)).toBeNull();
    expect(await s.taskRepo.listForAgent(true)).toEqual([]);
  });

  it("repeated chat_card re-anchors a needs_user row without another task_upsert", async () => {
    const s = setup();
    const { chatId, taskId } = text(
      await s.tool("chat_start", { title: "Flights", brief: "Find flights" }),
    );
    const first = text(await s.tool("chat_card", { chatId })).messageId;
    expect(
      (
        await s.tool("task_upsert", {
          tasks: [{ id: taskId, state: "needs_user", messageId: first, summary: "Pick a flight" }],
        })
      ).isError,
    ).toBeFalsy();
    expect(await anchorOf(s, taskId)).toBe(first);
    const second = text(await s.tool("chat_card", { chatId })).messageId;
    expect(second).not.toBe(first);
    expect(await anchorOf(s, taskId)).toBe(second);
    expect(await s.taskRepo.get(taskId)).toMatchObject({
      state: "needs_user",
      summary: "Pick a flight",
    });
  });

  it("chat_card shows a task without a row without creating one", async () => {
    const s = setup();
    const chatId = await s.chats.startChat({}, "guardian");
    await s.deps.webchatRepo.setSessionTrigger(chatId, {
      triggerKind: TASK_CHAT_TRIGGER_KIND,
      triggerName: null,
    });
    const result = await s.tool("chat_card", { chatId });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toMatchObject({ sent: expect.any(String), messageId: expect.any(String) });
    expect(await s.taskRepo.findBySession(chatId)).toBeNull();
    expect(await s.taskRepo.listForAgent(true)).toEqual([]);
  });

  it("anchors needs_user to chat_card rather than an introductory say", async () => {
    const s = setup();
    await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    await s.tool("say", { text: "The task needs your input." });
    const { messageId } = text(await s.tool("chat_card", { chatId: "task-1" }));
    const task = (await s.taskRepo.findBySession("task-1"))!;
    const result = await s.tool("task_upsert", {
      tasks: [{ id: task.id, state: "needs_user", messageId }],
    });
    expect(result.isError).toBeFalsy();
    expect(await anchorOf(s, task.id)).toBe(messageId);
    expect((await s.taskRepo.get(task.id))?.state).toBe("needs_user");
  });

  it("points a new row at the latest thing the Concierge said this turn", async () => {
    const s = setup({ said: false });
    await s.tool("say", { text: "First" });
    await s.tool("say", { text: "Second" });
    expect(await anchorOf(s, await created(s, {}))).toBe("said-2");
  });

  it("points a new row at the message passed, which says, cards and forwards returned", async () => {
    const s = setup({ said: false });
    const first = text(await s.tool("say", { text: "First" })).messageId;
    await s.tool("say", { text: "Second" });
    expect(await anchorOf(s, await created(s, { messageId: first }))).toBe(first);
  });

  it("refuses a message that is not in the Concierge chat, and writes nothing", async () => {
    const s = setup({ said: false });
    s.messages.set("task-1", [
      { id: "foreign-1", role: "assistant", content: "[]", turnId: "concierge-turn-1" },
    ]);
    await s.tool("say", { text: "First" });
    for (const messageId of ["foreign-1", "no-such-message"]) {
      const result = await s.tool("task_upsert", { tasks: [{ title: "Pay rent", messageId }] });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(`No message ${messageId} in this chat`);
    }
    expect(await s.taskRepo.listForAgent(true)).toEqual([]);
  });

  it("refuses a new row when nothing was said this turn, and never falls back to the guardian's words", async () => {
    const s = setup({ said: false });
    s.messages.set(CONCIERGE_CHAT, [
      { id: "user-1", role: "user", content: "[]", turnId: "concierge-turn-1" },
      { id: "older-said", role: "assistant", content: "[]", turnId: "concierge-turn-0" },
    ]);
    const result = await s.tool("task_upsert", { tasks: [{ title: "Pay rent" }] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Call say first");
    expect(await s.taskRepo.listForAgent(true)).toEqual([]);
  });

  it("keeps a row's message on an update, and a new messageId replaces it", async () => {
    const s = setup({ said: false });
    const first = text(await s.tool("say", { text: "Pay the rent?" })).messageId;
    const id = await created(s, { state: "next" });
    const asked = text(await s.tool("say", { text: "Which account?" })).messageId;

    await s.tool("task_upsert", { tasks: [{ id, summary: "Waiting" }] });
    expect(await anchorOf(s, id)).toBe(first);

    await s.tool("task_upsert", { tasks: [{ id, state: "needs_user", messageId: asked }] });
    expect(await anchorOf(s, id)).toBe(asked);

    const bad = await s.tool("task_upsert", { tasks: [{ id, messageId: "no-such-message" }] });
    expect(bad.isError).toBe(true);
    expect(await anchorOf(s, id)).toBe(asked);
  });

  it("refuses needs_user without a messageId, on a create and on an update, and writes nothing", async () => {
    const s = setup({ said: false });
    await s.tool("say", { text: "Which account?" });
    const id = await created(s, { state: "next" });
    const before = await s.taskRepo.get(id);

    // The turn has said something, so a create of another state would have an anchor; needs_user still needs the id.
    const create = await s.tool("task_upsert", {
      tasks: [
        { title: "Fine", state: "next" },
        { title: "Pick one", state: "needs_user" },
      ],
    });
    expect(create.isError).toBe(true);
    expect(create.content[0].text).toContain(
      "tasks[1]: needs_user requires messageId: show a task question or approval with chat_card",
    );
    const update = await s.tool("task_upsert", { tasks: [{ id, state: "needs_user" }] });
    expect(update.isError).toBe(true);
    expect(update.content[0].text).toContain("tasks[0]: needs_user requires messageId");
    // The batch is atomic: not even the valid first entry was written.
    expect((await s.taskRepo.listForAgent(true)).map(({ row }) => row.title)).toEqual(["Pay rent"]);
    expect(await s.taskRepo.get(id)).toEqual(before);
  });

  it("takes needs_user with a valid messageId, which replaces the anchor", async () => {
    const s = setup({ said: false });
    await s.tool("say", { text: "Planning" });
    const id = await created(s, { state: "doing" });
    const asked = text(await s.tool("say", { text: "Which one?" })).messageId;
    const result = text(
      await s.tool("task_upsert", {
        tasks: [{ id, state: "needs_user", waitingOn: "a choice", messageId: asked }],
      }),
    );
    expect(await anchorOf(s, id)).toBe(asked);
    expect(result.tasks[0]).toMatchObject({ state: "needs_user", anchor: asked });
    expect(result.tasks[0]).not.toHaveProperty("anchorKept");

    // A new needs_user row takes the id too, whatever the turn said last.
    await s.tool("say", { text: "Something else" });
    const made = await created(s, { title: "Choose", state: "needs_user", messageId: asked });
    expect(await anchorOf(s, made)).toBe(asked);
  });

  it("refuses a needs_user messageId that is not a message of the Concierge chat", async () => {
    const s = setup({ said: false });
    await s.tool("say", { text: "Planning" });
    const id = await created(s, { state: "doing" });
    s.messages.set("task-1", [
      { id: "foreign-1", role: "assistant", content: "[]", turnId: "concierge-turn-1" },
    ]);
    for (const messageId of ["foreign-1", "no-such-message"]) {
      const result = await s.tool("task_upsert", {
        tasks: [{ id, state: "needs_user", messageId }],
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(`No message ${messageId} in this chat`);
    }
    expect((await s.taskRepo.get(id))?.state).toBe("doing");
  });

  it("leaves an update that sets no needs_user alone: the anchor stays and the result says so", async () => {
    const s = setup({ said: false });
    const first = text(await s.tool("say", { text: "Planning" })).messageId;
    const id = await created(s, { state: "doing" });
    await s.tool("say", { text: "Later" });
    const result = text(
      await s.tool("task_upsert", { tasks: [{ id, state: "watching", summary: "Waiting" }] }),
    );
    expect(await anchorOf(s, id)).toBe(first);
    expect(result.tasks[0]).toMatchObject({ state: "watching", anchor: first, anchorKept: true });
    // A write with no state field touches a needs_user row without the requirement.
    const asked = text(await s.tool("say", { text: "Which?" })).messageId;
    await s.tool("task_upsert", { tasks: [{ id, state: "needs_user", messageId: asked }] });
    const touched = text(
      await s.tool("task_upsert", { tasks: [{ id, summary: "Still waiting" }] }),
    );
    expect(touched.tasks[0]).toMatchObject({
      state: "needs_user",
      anchor: asked,
      anchorKept: true,
    });
  });

  it("answers a created row's anchor without the kept flag, and leaves out an anchor a legacy row never had", async () => {
    const s = setup({ said: false });
    await s.tool("say", { text: "Planning" });
    const made = text(await s.tool("task_upsert", { tasks: [{ title: "New" }] }));
    expect(made.tasks[0]).toEqual({
      id: expect.any(String),
      title: "New",
      state: "next",
      anchor: "said-1",
    });
    const [legacy] = await s.taskRepo.upsertMany([{ title: "Old", state: "next" }]);
    const kept = text(await s.tool("task_upsert", { tasks: [{ id: legacy.id, summary: "x" }] }));
    expect(kept.tasks[0]).toEqual({
      id: legacy.id,
      title: "Old",
      state: "next",
      anchorKept: true,
    });
  });

  it("chat_start linking a taskId sets doing and needs no messageId", async () => {
    const s = setup({ said: false });
    const first = text(await s.tool("say", { text: "Planning" })).messageId;
    const planned = await created(s, { state: "next" });
    const result = await s.tool("chat_start", { title: "Go", brief: "Do it", taskId: planned });
    expect(result.isError).toBeFalsy();
    expect(await anchorOf(s, planned)).toBe(first);
    expect((await s.taskRepo.get(planned))?.state).toBe("doing");
  });

  it("chat_start points the row it creates at the latest message of the turn", async () => {
    const s = setup({ said: false });
    await s.tool("say", { text: "Looking into flights" });
    const started = text(await s.tool("chat_start", { title: "Flights", brief: "Find flights" }));
    expect(await anchorOf(s, started.taskId)).toBe("said-1");
  });

  it("chat_start starts no chat when the row has no message to point to", async () => {
    const s = setup({ said: false });
    const none = await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    expect(none.isError).toBe(true);
    expect(none.content[0].text).toContain("Call say first");
    const bogus = await s.tool("chat_start", {
      title: "Flights",
      brief: "Find flights",
      messageId: "no-such-message",
    });
    expect(bogus.isError).toBe(true);
    expect(s.chats.startChat).not.toHaveBeenCalled();
    expect(s.posted).toEqual([]);
    expect(await s.taskRepo.listForAgent(true)).toEqual([]);
  });

  it("chat_start keeps a linked row's message unless a messageId replaces it", async () => {
    const s = setup({ said: false });
    const first = text(await s.tool("say", { text: "Planning" })).messageId;
    const planned = await created(s, { state: "next" });
    await s.tool("say", { text: "Starting now" });
    await s.tool("chat_start", { title: "Flights", brief: "Find flights", taskId: planned });
    expect(await anchorOf(s, planned)).toBe(first);

    const other = await created(s, { title: "Other", state: "next" });
    const chosen = text(await s.tool("say", { text: "Choose" })).messageId;
    await s.tool("chat_start", {
      title: "Hotels",
      brief: "Find hotels",
      taskId: other,
      messageId: chosen,
    });
    expect(await anchorOf(s, other)).toBe(chosen);
  });

  it("chat_start with a taskId needs no message of the turn when the row has none", async () => {
    const s = setup({ said: false });
    const [legacy] = await s.taskRepo.upsertMany([{ title: "Old", state: "next" }]);
    const result = await s.tool("chat_start", {
      title: "Old",
      brief: "Do it",
      taskId: legacy.id,
    });
    expect(result.isError).toBeFalsy();
    expect(await anchorOf(s, legacy.id)).toBeNull();
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
      `${MAIN_LINE}<task_events>\n<task id="${taskId}" chat_id="task-1" title="Flights" state="doing" changes="turn_end:completed by=concierge">\nreply: 3 options\n</task>\n</task_events>`,
    );
    expect(s.quietFlags).toEqual([false]);
    // The guardian did not start it, so its first message goes to the phone.
    expect(s.turnOptions[0]?.pushLevel).toBe("active");
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

  const replyLine = async (text: string) => {
    const s = setup();
    const { chatId } = await startTask(s, text);
    s.fakeTimers();
    await finishTask(s, chatId);
    await rs.advanceTimersByTimeAsync(2_000);
    rs.useRealTimers();
    return /\nreply: ([\s\S]*)\n<\/task>/.exec(s.backendTurns[0].prompt)?.[1];
  };
  const leftOut = (count: number) =>
    `\n[… ${count} characters left out; chat_read shows the full reply]\n`;

  it("keeps the start and the end of a long reply, so a closing question reaches the Concierge", async () => {
    const question = "你更看重续航还是相机？";
    expect(await replyLine(`${"y".repeat(1_989)}${question}`)).toBe(
      `${"y".repeat(400)}${leftOut(1_300)}${"y".repeat(289)}${question}`,
    );
  });

  it("cuts a long reply on whole characters, near a space, and keeps one of 700 whole", async () => {
    const family = "👨‍👩‍👧";
    expect(await replyLine(family.repeat(1_000))).toBe(
      `${family.repeat(400)}${leftOut(300)}${family.repeat(300)}`,
    );
    expect(await replyLine("abcd ".repeat(200))).toBe(
      `${"abcd ".repeat(79)}abcd${leftOut(301)}${"abcd ".repeat(59)}abcd`,
    );
    expect(await replyLine("我".repeat(700))).toBe("我".repeat(700));
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

  it("hands a task's result over again once the Concierge's own turns run, however long it was out", async () => {
    const s = setup();
    const { chatId, taskId } = await startTask(s);
    s.fakeTimers();
    s.onBackendTurn(() => "failed");
    await finishTask(s, chatId);
    await rs.advanceTimersByTimeAsync(2_000);
    await rs.advanceTimersByTimeAsync(3 * RETRY_MS);
    expect(s.backendTurns).toHaveLength(4);

    s.onBackendTurn(() => "completed");
    await rs.advanceTimersByTimeAsync(RETRY_MS);
    expect(s.backendTurns).toHaveLength(5);
    expect(s.backendTurns[4].prompt).toContain(
      `<task id="${taskId}" chat_id="${chatId}" title="Flights" state="doing" changes="turn_end:completed by=concierge">`,
    );
  });

  it("does not hand a task's result over again after the guardian stops the Concierge's turn", async () => {
    const s = setup();
    const { chatId } = await startTask(s);
    s.fakeTimers();
    s.onBackendTurn(() => "stopped");
    await finishTask(s, chatId);
    await rs.advanceTimersByTimeAsync(2_000);
    expect(s.backendTurns).toHaveLength(1);
    await rs.advanceTimersByTimeAsync(2 * RETRY_MS);
    expect(s.backendTurns).toHaveLength(1);
  });

  it("hands a task's result over again when a newer message, not a Stop, cut the turn short", async () => {
    const s = setup();
    const { chatId } = await startTask(s);
    s.fakeTimers();
    s.onBackendTurn(() => "interrupted");
    await finishTask(s, chatId);
    await rs.advanceTimersByTimeAsync(2_000);
    expect(s.backendTurns).toHaveLength(1);
    s.onBackendTurn(() => "completed");
    await rs.advanceTimersByTimeAsync(RETRY_MS);
    expect(s.backendTurns).toHaveLength(2);
  });

  it("tells the Concierge of a failed turn at once, with its cause, and holds a stopped one", async () => {
    const s = setup();
    const { chatId } = await startTask(s);
    s.fakeTimers();
    await s.finish({
      turnId: "task-turn-1",
      agentName: "core:main",
      chatId,
      status: "error",
      failure: { message: "Claude is out of quota", provider: "anthropic" },
    });
    await rs.advanceTimersByTimeAsync(2_000);
    expect(s.backendTurns[0].prompt).toContain('changes="turn_end:error by=concierge"');
    expect(s.backendTurns[0].prompt).toContain("error: Claude is out of quota");

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

  it("reports at once a task turn the guardian started by answering the task's own card", async () => {
    const s = setup();
    const { chatId } = await startTask(s);
    s.fakeTimers();
    s.messages.get(chatId)?.push({
      id: "answer",
      role: "user",
      content: JSON.stringify([
        { type: "interaction_result", toolUseId: "ask-1", output: { answers: ["LIS"] } },
      ]),
      turnId: "task-turn-2",
    });
    await finishTask(s, chatId, { turnId: "task-turn-2" });
    await rs.advanceTimersByTimeAsync(2_000);
    expect(s.backendTurns).toHaveLength(1);
    expect(s.backendTurns[0].prompt).toContain('changes="turn_end:completed by=concierge"');
    expect(s.quietFlags).toEqual([false]);
  });

  it("keeps a typed reply that dismisses the open card the guardian's own, quiet turn", async () => {
    const s = setup();
    const { chatId } = await startTask(s);
    s.fakeTimers();
    s.messages.get(chatId)?.push({
      id: "typed",
      role: "user",
      content: JSON.stringify([
        { type: "text", content: "Actually, Porto" },
        { type: "interaction_result", toolUseId: "ask-1", output: { dismissed: true } },
      ]),
      turnId: "task-turn-2",
    });
    await finishTask(s, chatId, { turnId: "task-turn-2" });
    await rs.advanceTimersByTimeAsync(2_000);
    expect(s.backendTurns).toEqual([]);
    await rs.advanceTimersByTimeAsync(58_000);
    expect(s.backendTurns[0].prompt).toContain('changes="turn_end:completed by=guardian"');
    expect(s.quietFlags).toEqual([true]);
  });

  it("reports at once the task turn that carries on from the guardian's answer to its approval", async () => {
    const s = setup();
    const { chatId } = await startTask(s);
    s.fakeTimers();
    s.resolveApproval({ status: "approved", payload: { channelContext: { threadId: chatId } } });
    // The carried-on turn's prompt is the action's result, recorded with no sender.
    s.messages.get(chatId)?.push({
      id: "result",
      role: "user",
      content: JSON.stringify([{ type: "text", content: "Sent." }]),
      turnId: "task-turn-2",
    });
    await s.finish({
      turnId: "task-turn-2",
      agentName: "core:main",
      chatId,
      startedAt: new Date(Date.now() + 1_000).toISOString(),
    });
    await rs.advanceTimersByTimeAsync(2_000);
    expect(s.backendTurns).toHaveLength(1);
    expect(s.backendTurns[0].prompt).toContain('changes="turn_end:completed by=concierge"');

    // Only that one turn: the guardian's next typed message is theirs again.
    s.messages.get(chatId)?.push({
      id: "typed",
      role: "user",
      content: JSON.stringify([{ type: "text", content: "Thanks" }]),
      turnId: "task-turn-3",
    });
    await s.finish({
      turnId: "task-turn-3",
      agentName: "core:main",
      chatId,
      startedAt: new Date(Date.now() + 5_000).toISOString(),
    });
    await rs.advanceTimersByTimeAsync(2_000);
    expect(s.backendTurns).toHaveLength(1);
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

  it("tells the Concierge at once of a task turn that failed before it started, either way it is told", async () => {
    const error = "Selected model provider is unavailable: Claude is not signed in";
    const expectFailedTurn = (s: ReturnType<typeof setup>, chatId: string, taskId: string) => {
      expect(s.backendTurns).toHaveLength(1);
      expect(s.backendTurns[0].prompt).toContain(
        `<task id="${taskId}" chat_id="${chatId}" title="Flights" state="doing" changes="turn_end:error by=concierge">`,
      );
      expect(s.backendTurns[0].prompt).toContain(`error: ${error}`);
      expect(s.quietFlags).toEqual([false]);
    };

    // A reused agent session: it could not resolve the model for the turn.
    const reused = setup();
    const first = await startTask(reused);
    reused.fakeTimers();
    await reused.failBeforeStart({ turnId: "task-turn-1", chatId: first.chatId, error });
    await reused.failBeforeStart({ turnId: "other-turn", chatId: "not-a-task-chat", error });
    await rs.advanceTimersByTimeAsync(2_000);
    expectFailedTurn(reused, first.chatId, first.taskId);

    // No agent session opened: the dashboard tells the Concierge itself.
    const cold = setup();
    const second = await startTask(cold);
    cold.fakeTimers();
    cold.service.turnFailedBeforeStart({
      turn: {
        sessionId: second.chatId,
        turnId: "task-turn-1",
        agentName: "core:main",
        threadContext: { channel: "webchat", threadId: second.chatId },
      },
      error,
    });
    await cold.settle();
    await rs.advanceTimersByTimeAsync(2_000);
    expectFailedTurn(cold, second.chatId, second.taskId);
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
      `${MAIN_LINE}<task_events>\n<task id="${taskId}" title="Flights" state="doing" changes="chat_deleted" quiet="true">\nThe task chat was deleted.\n</task>\n</task_events>`,
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
    await ignored.tool("chat_forward", { chatId: quiet.chatId });
    await rs.advanceTimersByTimeAsync(10_000);
    expect(ignored.backendTurns).toHaveLength(2);
    expect((await ignored.tasks.listForPanel())[0].notSynced).toBe(true);
    await rs.advanceTimersByTimeAsync(120_000);
    expect(ignored.backendTurns).toHaveLength(2);
    // A later write by the Concierge clears the mark.
    await ignored.taskRepo.upsertMany([{ id: quiet.taskId, summary: "ok" }]);
    expect((await ignored.tasks.listForPanel())[0].notSynced).toBe(false);
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
    expect(s.backendTurns.map((turn) => turn.prompt)).toEqual([MAIN_LINE + NUDGE_PROMPT]);
  });

  it("reminds a Concierge turn that ended on unsent text, once", async () => {
    const s = setup();
    await s.finish({
      turnId: "c1",
      agentName: CONCIERGE_AGENT_ID,
      chatId: CONCIERGE_CHAT,
      text: "hi",
    });
    expect(s.backendTurns.map((turn) => turn.prompt)).toEqual([MAIN_LINE + NUDGE_PROMPT]);
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
    expect(s.backendTurns.map((turn) => turn.prompt)).toEqual([MAIN_LINE + NUDGE_PROMPT]);
  });
});

describe("Concierge system turns", () => {
  const serviceWith = (session: { id: string } | null, outcome: "completed" | "failed") => {
    const turns: BackendTurnParams[] = [];
    const service = new ConciergeService({
      sessionRepository: { current: async () => session },
      webchatRepo: { getSession: async () => null },
      settingsRepo: { get: async () => null },
      runBackendTurn: async (params: BackendTurnParams) => {
        turns.push(params);
        return outcome;
      },
    } as unknown as ConciergeDeps);
    return { service, turns };
  };

  it("answers whether the turn ran to its end", async () => {
    const done = serviceWith({ id: "runtime-1" }, "completed");
    expect(await done.service.runSystemTurn(CONCIERGE_CHAT_ID, "lines")).toBe(true);
    const failed = serviceWith({ id: "runtime-1" }, "failed");
    expect(await failed.service.runSystemTurn(CONCIERGE_CHAT_ID, "lines")).toBe(false);
  });

  it("answers false, running nothing, before the chat's first turn", async () => {
    const none = serviceWith(null, "completed");
    expect(await none.service.runSystemTurn(CONCIERGE_CHAT_ID, "lines")).toBe(false);
    expect(none.turns).toEqual([]);
  });
});

describe("Concierge pushes", () => {
  const sayIn = async (s: ReturnType<typeof setup>, text: string) => {
    await s.tool("say", { text });
    await s.settle();
  };
  // Local time, as the guardian's timezone falls back to this machine's.
  const hhmm = (at: number) => {
    const date = new Date(at);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  };
  /** Quiet hours from an hour ago to an hour from now, for `owner` only. */
  const quietNow = (s: ReturnType<typeof setup>, owner = "guardian") =>
    s.service.attachFollowing({
      rules: async () => ({
        digestTimes: ["09:00"],
        quietHours: { start: hhmm(Date.now() - 3_600_000), end: hhmm(Date.now() + 3_600_000) },
      }),
      quietUntil: async (_at: number, asked: string) =>
        asked === owner ? Date.now() + 3_600_000 : null,
    } as unknown as ConciergeFollowing);

  it("hands a system turn's push level to the turn it runs", async () => {
    const s = setup();
    await s.service.runSystemTurn(CONCIERGE_CHAT, "<task_events/>", { pushLevel: "active" });
    expect(s.turnOptions[0]?.pushLevel).toBe("active");
  });

  it("pushes the first message of a turn the guardian did not start, with its chat", async () => {
    const s = setup();
    s.pushLevel("active");
    await sayIn(s, "Your flight to **Rome** moved to 9:40.");
    expect(s.pushes).toEqual([
      { body: "Your flight to Rome moved to 9:40.", level: "active", chatId: CONCIERGE_CHAT },
    ]);
  });

  it("pushes a digest's message without an alert", async () => {
    const s = setup();
    s.pushLevel("passive");
    await sayIn(s, "Nothing new since this morning.");
    expect(s.pushes.map((push) => push.level)).toEqual(["passive"]);
  });

  it("pushes a message said in a topic chat with that chat's id", async () => {
    const s = setup();
    s.turnIn(TOPIC_CHAT);
    s.pushLevel("active");
    await sayIn(s, "The 3pm moved to 4pm.");
    expect(s.pushes.map((push) => push.chatId)).toEqual([TOPIC_CHAT]);
  });

  it("pushes a turn's first message at once and holds a second said right after for the merge window", async () => {
    const s = setup();
    s.pushLevel("active");
    await sayIn(s, "The build failed.");
    await sayIn(s, "I restarted it.");
    expect(s.pushes.map((push) => push.body)).toEqual(["The build failed."]);
  });

  it("pushes the fixed line for a message the Concierge marks private", async () => {
    const s = setup();
    s.pushLevel("active");
    await s.tool("say", { text: "Your code is 7291.", private: true });
    await s.settle();
    expect(s.pushes).toEqual([
      { body: "A task has an update", level: "active", chatId: CONCIERGE_CHAT },
    ]);
    expect(s.messages.get(CONCIERGE_CHAT)?.map((row) => textOf(row.content))).toEqual([
      "Your code is 7291.",
    ]);
  });

  /** A finished task chat whose latest answer is `answer`, with the row the Concierge titled. */
  const finishedTask = async (s: ReturnType<typeof setup>, answer: string) => {
    const started = JSON.parse(
      (await s.tool("chat_start", { title: "Bank sign-in", brief: "Sign in to the bank" }))
        .content[0].text,
    ) as { chatId: string };
    s.messages.get(started.chatId)?.push({
      role: "assistant",
      content: JSON.stringify([{ type: "text", content: answer }]),
    });
    return started.chatId;
  };
  const SECRET_ANSWER = "Your one-time login code is 7291.";

  it("pushes a fixed line, never the forwarded answer or the task's title, for a forward with no intro", async () => {
    const s = setup();
    const chatId = await finishedTask(s, SECRET_ANSWER);
    s.pushLevel("active");
    await s.tool("chat_forward", { chatId });
    await s.settle();
    expect(s.pushes).toEqual([
      { body: "A task has an update", level: "active", chatId: CONCIERGE_CHAT },
    ]);
  });

  it("pushes only the intro of a forward that has one", async () => {
    const s = setup();
    const chatId = await finishedTask(s, SECRET_ANSWER);
    s.pushLevel("active");
    await s.tool("chat_forward", { chatId, intro: "The bank sent a sign-in code." });
    await s.settle();
    expect(s.pushes.map((push) => push.body)).toEqual(["The bank sent a sign-in code."]);
  });

  it("pushes a fixed line for a card", async () => {
    const s = setup();
    const chatId = await finishedTask(s, SECRET_ANSWER);
    s.pushLevel("active");
    await s.tool("chat_card", { chatId });
    await s.settle();
    expect(s.pushes.map((push) => push.body)).toEqual(["A task has an update"]);
  });

  it("keeps a legacy task chat's name off the lock screen after its row is filled in from it", async () => {
    const s = setup();
    // A task chat from before the task list, named from its output.
    const chatId = "task-unlisted";
    s.sessions.set(chatId, {
      id: chatId,
      name: "Login code 7291",
      triggerKind: TASK_CHAT_TRIGGER_KIND,
    });
    await s.storedChats.createSession(chatId, "Login code 7291");
    s.messages.set(chatId, [
      { role: "assistant", content: JSON.stringify([{ type: "text", content: SECRET_ANSWER }]) },
    ]);
    // A guardian's turn sends into it, which fills in its row from the chat's name.
    await s.tool("chat_send", { chatId, text: "Anything new?" });
    expect((await s.tasks.repo.findBySession(chatId))?.title).toBe("Login code 7291");
    // A later turn the guardian did not start forwards its answer, then shows its card.
    s.pushLevel("active");
    await s.tool("chat_forward", { chatId });
    await s.tool("chat_card", { chatId });
    await s.settle();
    expect(s.pushes.map((push) => push.body)).toEqual(["A task has an update"]);
    expect(JSON.stringify(s.pushes)).not.toContain("7291");
  });

  it("never sends a forwarded answer to Rome Cloud, whatever the turn says", async () => {
    const s = setup();
    const chatId = await finishedTask(s, SECRET_ANSWER);
    s.pushLevel("active");
    await s.tool("chat_forward", { chatId });
    await sayIn(s, "Anything else?");
    expect(JSON.stringify(s.pushes)).not.toContain("7291");
  });

  it("keeps a private message off the lock screen", async () => {
    const s = setup();
    s.pushLevel("active");
    const result = await s.tool("say", {
      text: "Your code is 7291.",
      private: true,
    });
    await s.settle();
    expect(result.isError).toBeFalsy();
    expect(s.pushes).toEqual([
      { body: "A task has an update", level: "active", chatId: CONCIERGE_CHAT },
    ]);
  });

  it("pushes a visitor's Concierge to that visitor, never to the guardian", async () => {
    const s = setup();
    s.sessions.set("visitor-topic", {
      id: "visitor-topic",
      name: "Ann's calendar",
      triggerKind: null,
      agentName: CONCIERGE_AGENT_ID,
      ownerKey: "visitor:acct-ann",
    });
    s.turnIn("visitor-topic");
    s.pushLevel("active");
    await sayIn(s, "Your 3pm moved.");
    expect(s.pushes).toEqual([
      { body: "Your 3pm moved.", level: "active", chatId: "visitor-topic", recipient: "acct-ann" },
    ]);
    expect(s.messages.get("visitor-topic")).toHaveLength(1);
  });

  it("holds back a visitor's push in the visitor's quiet hours, not the guardian's", async () => {
    const s = setup();
    s.sessions.set("visitor-topic", {
      id: "visitor-topic",
      name: "Ann's calendar",
      triggerKind: null,
      agentName: CONCIERGE_AGENT_ID,
      ownerKey: "visitor:acct-ann",
    });
    quietNow(s, "visitor:acct-ann");
    s.turnIn("visitor-topic");
    s.pushLevel("active");
    await sayIn(s, "Your 3pm moved.");
    s.turnIn(CONCIERGE_CHAT);
    await sayIn(s, "A PR needs your review.");
    expect(s.pushes.map((push) => push.chatId)).toEqual([CONCIERGE_CHAT]);
  });

  it("pushes nothing for a turn the guardian started", async () => {
    const s = setup();
    await sayIn(s, "Here are three flights.");
    expect(s.pushes).toEqual([]);
  });

  it("pushes nothing in quiet hours, and the message stays in the chat", async () => {
    const s = setup();
    quietNow(s);
    s.pushLevel("active");
    await sayIn(s, "A PR needs your review.");
    expect(s.pushes).toEqual([]);
    expect(s.messages.get(CONCIERGE_CHAT)?.map((row) => textOf(row.content))).toEqual([
      "A PR needs your review.",
    ]);
  });

  it("pushes nothing without a push sender, and still says the message", async () => {
    const s = setup({ notify: false });
    s.pushLevel("active");
    await sayIn(s, "A PR needs your review.");
    expect(s.messages.get(CONCIERGE_CHAT)).toHaveLength(1);
  });

  it("keeps the turn going when the push fails or has no instance credential", async () => {
    for (const outcome of [
      async (): Promise<SendOutcome> => ({ kind: "no_token" }),
      async (): Promise<SendOutcome> => {
        throw new Error("network down");
      },
    ]) {
      const s = setup();
      s.pushLevel("active");
      s.pushAnswers(outcome);
      expect((await s.tool("say", { text: "A PR needs your review." })).isError).toBeFalsy();
      await s.settle();
      expect(s.pushes).toHaveLength(1);
      expect(s.messages.get(CONCIERGE_CHAT)).toHaveLength(1);
    }
  });

  it("runs the reminder after a guardian's turn as one that pushes nothing", async () => {
    const s = setup();
    await s.finish({
      turnId: "c1",
      agentName: CONCIERGE_AGENT_ID,
      chatId: CONCIERGE_CHAT,
      text: "It was 7291.",
    });
    expect(s.backendTurns.map((turn) => turn.prompt)).toEqual([MAIN_LINE + NUDGE_PROMPT]);
    expect(s.turnOptions[0]?.pushLevel).toBeUndefined();
  });
});

describe("Concierge chat", () => {
  const serviceWith = (
    state: Record<string, unknown>,
    exists: boolean,
    stored: string | null = null,
  ) => {
    const createSession = rs.fn(async () => {});
    const update = rs.fn(async () => {});
    const service = new ConciergeService({
      settingsRepo: { get: async () => null },
      webchatRepo: {
        getSession: async (id: string) =>
          exists && id === CONCIERGE_CHAT_ID ? { id, largeModelSelection: stored } : null,
        createSession,
        updateSessionLargeModelSelection: update,
      },
      accounts: fakeAccounts(() => state),
    } as unknown as ConciergeDeps);
    return { service, createSession, update };
  };
  const signedOut = reportOf("unauthorized");
  const codexOnly: ModelAccountReports = {
    anthropic: signedOut,
    openai: reportOf("available"),
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
      "webchat",
      null,
      {},
    );
  });

  it("creates a visitor's own main chat on first open, owned by them", async () => {
    const { service, createSession } = serviceWith(codexOnly, false);
    const id = await service.ensureChatId("visitor:acct-ann");
    expect(id).toBe(mainChatIdOf("visitor:acct-ann"));
    expect(id).toMatch(/^concierge-v-[0-9a-f]{24}$/);
    expect(createSession).toHaveBeenCalledWith(
      id,
      "Concierge",
      undefined,
      undefined,
      "gpt-6-luna",
      undefined,
      CONCIERGE_AGENT_ID,
      "webchat",
      null,
      { ownerKey: "visitor:acct-ann" },
    );
  });

  it("opens every turn with the person the chat serves, who may be a visitor", async () => {
    const allowed = new Set(["ann@example.com"]);
    const owners = createConciergeOwners({
      settingsRepo: {
        get: (async (key: string) => (key === "guardianName" ? "Eric" : null)) as never,
      },
      visitorProfiles: {
        getMany: async (ids: readonly string[]) =>
          new Map(
            ids.includes("acct-ann")
              ? [["acct-ann", { email: "ann@example.com", avatarUrl: null }]]
              : [],
          ),
      },
      dashboardAccess: { isCloudEmailAllowed: (email: string) => allowed.has(email) },
    });
    const annMain = mainChatIdOf("visitor:acct-ann");
    const service = new ConciergeService({
      settingsRepo: { get: async () => null },
      webchatRepo: {
        getSession: async (id: string) =>
          id === annMain
            ? { id, agentName: CONCIERGE_AGENT_ID, ownerKey: "visitor:acct-ann" }
            : { id, agentName: CONCIERGE_AGENT_ID, ownerKey: null },
      },
      owners,
    } as unknown as ConciergeDeps);
    expect(await service.turnHeader({ id: annMain, name: "Concierge", main: true })).toBe(
      `<concierge_chat id="${annMain}" name="Concierge" main="true"/>\n<concierge_owner role="visitor" email="ann@example.com"/>`,
    );
    expect(await service.turnHeader({ id: "concierge", name: "Concierge", main: true })).toBe(
      '<concierge_chat id="concierge" name="Concierge" main="true"/>\n<concierge_owner role="guardian" name="Eric"/>',
    );
    // A visitor is served while on the dashboard allow-list, the guardian always.
    expect(await service.isServed("visitor:acct-ann")).toBe(true);
    expect(await service.isServed("visitor:acct-unknown")).toBe(false);
    allowed.clear();
    expect(await service.isServed("visitor:acct-ann")).toBe(false);
    expect(await service.isServed("guardian")).toBe(true);
  });

  it("leaves an existing chat and its model alone", async () => {
    const { service, createSession, update } = serviceWith(codexOnly, true, "claude-sonnet");
    expect(await service.ensureChatId()).toBe("concierge");
    expect(createSession).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("gives a chat created before any login its model once a provider is signed in", async () => {
    const { service, update } = serviceWith(codexOnly, true, null);
    await service.ensureChatId();
    expect(update).toHaveBeenCalledWith("concierge", "gpt-6-luna");
  });

  it("falls back to Terra without Luna access, and to Sonnet on a Claude login", async () => {
    const terra = serviceWith(
      { anthropic: signedOut, openai: reportOf("available", RESTRICTED_PLAN) },
      true,
      null,
    );
    await terra.service.ensureChatId();
    expect(terra.update).toHaveBeenCalledWith("concierge", "gpt-5-6-terra");
    const claude = serviceWith(
      { anthropic: reportOf("available"), openai: codexOnly.openai },
      true,
      null,
    );
    await claude.service.ensureChatId();
    expect(claude.update).toHaveBeenCalledWith("concierge", "claude-sonnet");
  });

  it("stores nothing for an existing chat while no provider is signed in", async () => {
    const { service, update } = serviceWith(
      { anthropic: signedOut, openai: reportOf("unauthorized") },
      true,
      null,
    );
    expect(await service.ensureChatId()).toBe("concierge");
    expect(update).not.toHaveBeenCalled();
  });
});

describe("Concierge quota failover", () => {
  const state = () => ({
    anthropic: reportOf("usage_limit_reached"),
    openai: reportOf("available"),
  });
  it("stores a selection, changes a live session, and persists a pushed notice excluded from history", async () => {
    const s = setup({ startEvents: false });
    await s.storedChats.createSession(CONCIERGE_CHAT, "Concierge");
    await s.storedChats.updateSessionLargeModelSelection(CONCIERGE_CHAT, "claude-sonnet");
    s.service.deps.webchatRepo = s.storedChats;
    const raw = state();
    s.deps.accounts = fakeAccounts(() => raw);
    s.deps.sessionRepository.current = rs.fn(async () => ({ provider: "openai" }) as never);
    const selectModel = rs.fn();
    s.deps.agentSessionManager.find = rs.fn(() => ({ selectModel }) as never);
    const inserted = rs.fn();
    s.storedChats.onMessageInserted(inserted);
    expect(await s.service.switchIfExhausted(CONCIERGE_CHAT)).toEqual({
      from: "anthropic",
      to: "openai",
      selectionId: "gpt-6-luna",
      reason: "quota",
    });
    expect(selectModel).toHaveBeenCalledWith("gpt-6-luna");
    expect((await s.storedChats.getSession(CONCIERGE_CHAT))?.largeModelSelection).toBe(
      "gpt-6-luna",
    );
    expect(inserted).toHaveBeenCalledTimes(1);
    const [notice] = await s.storedChats.getMessages(CONCIERGE_CHAT);
    expect(JSON.parse(notice.content)).toEqual([
      {
        type: "quota_switch",
        from: "anthropic",
        to: "openai",
        model: "gpt-6-luna",
        reason: "quota",
        fromModel: "claude-sonnet-5-5",
      },
    ]);
    // Transcript order breaks same-second ties by turn id, so it must sort by time.
    expect(notice.turnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(await readWebchatMessages(s.storedChats, CONCIERGE_CHAT, new Date(0))).toEqual([]);
    raw.anthropic = reportOf("available");
    expect(await s.service.switchIfExhausted(CONCIERGE_CHAT)).toBeNull();
  });
  it.each([
    "both out",
    "not exhausted",
    "credits",
    "reauth",
    "api key",
    "other chat",
  ])("leaves %s alone", async (reason) => {
    const s = setup({ startEvents: false });
    const raw = state();
    s.deps.accounts = fakeAccounts(() => raw);
    if (reason === "both out") raw.openai = reportOf("usage_limit_reached");
    if (reason === "not exhausted") raw.anthropic = reportOf("available");
    if (reason === "credits") raw.openai = reportOf("unauthorized");
    if (reason === "reauth") raw.openai = reportOf("expired");
    if (reason === "api key")
      raw.openai = reportOf("available", { accountType: "api_key", usageLimited: false });
    expect(
      await s.service.switchIfExhausted(reason === "other chat" ? "task-chat" : CONCIERGE_CHAT),
    ).toBeNull();
    expect(s.deps.webchatRepo.updateSessionLargeModelSelection).not.toHaveBeenCalled();
    expect(s.deps.webchatRepo.addBackendMessage).not.toHaveBeenCalled();
  });
  it("uses the runtime provider before the sole-exhausted fallback", async () => {
    const s = setup({ startEvents: false });
    s.deps.accounts = fakeAccounts(state);
    s.deps.sessionRepository.current = rs.fn(async () => ({ provider: "openai" }) as never);
    expect(await s.service.switchIfExhausted(CONCIERGE_CHAT)).toBeNull();
    s.deps.sessionRepository.current = rs.fn(async () => null);
    expect(await s.service.switchIfExhausted(CONCIERGE_CHAT)).toMatchObject({
      from: "anthropic",
      to: "openai",
    });
  });
  it("runs one recovery and never recovers the recovery, even across a slow settings read", async () => {
    const s = setup({ settingsDelayMs: 10 });
    const raw = state();
    s.deps.accounts = fakeAccounts(() => raw);
    s.onBackendTurn(() => {
      raw.anthropic = reportOf("available");
      raw.openai = reportOf("usage_limit_reached");
      if (s.backendTurns.length < 3)
        void s.finish({
          turnId: "recovery",
          agentName: CONCIERGE_AGENT_ID,
          chatId: CONCIERGE_CHAT,
          status: "error",
        });
    });
    await s.finish({
      turnId: "quota",
      failure: { provider: "anthropic", message: "usage limit", code: "usage_limit" },
      agentName: CONCIERGE_AGENT_ID,
      chatId: CONCIERGE_CHAT,
      status: "error",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(s.backendTurns.map((turn) => turn.prompt)).toEqual([
      MAIN_LINE + quotaRecoveryPrompt("Claude"),
    ]);
    expect(s.deps.webchatRepo.updateSessionLargeModelSelection).toHaveBeenCalledTimes(1);
  });
  it.each([
    "no failure",
    "unrecognized error",
    "task chat",
  ])("does not recover %s", async (reason) => {
    const s = setup();
    const switchModel = rs.spyOn(s.service, "switchIfExhausted");
    await s.finish({
      turnId: reason,
      agentName: reason === "task chat" ? "main" : CONCIERGE_AGENT_ID,
      chatId: reason === "task chat" ? "task-chat" : CONCIERGE_CHAT,
      status: "error",
    });
    expect(s.backendTurns).toEqual([]);
    expect(s.deps.webchatRepo.updateSessionLargeModelSelection).not.toHaveBeenCalled();
    if (reason === "task chat") expect(switchModel).not.toHaveBeenCalled();
  });
});

describe("Concierge provider recovery", () => {
  const healthy = () => ({
    anthropic: reportOf("available"),
    openai: reportOf("available"),
  });
  const failure = (message: string, provider = "anthropic"): AgentTurnFailure => ({
    message,
    provider,
  });
  const finish = (s: ReturnType<typeof setup>, error?: AgentTurnFailure, turnId = "failed") =>
    s.finish({
      turnId,
      agentName: CONCIERGE_AGENT_ID,
      chatId: CONCIERGE_CHAT,
      status: error ? "error" : "completed",
      failure: error,
      text: "done",
    });
  async function prepared(options: Parameters<typeof setup>[0] = {}) {
    const s = setup(options);
    const raw = healthy();
    s.deps.accounts = fakeAccounts(() => raw);
    await s.deps.webchatRepo.updateSessionLargeModelSelection(CONCIERGE_CHAT, "claude-sonnet");
    return { s, raw };
  }
  it.each([
    [
      "anthropic",
      "claude-sonnet",
      "You've hit your Sonnet limit",
      "model_limit",
      "claude-opus-5-5",
    ],
    ["openai", "gpt-6-luna", "Selected model is at capacity.", "model_limit", "gpt-5-6-terra"],
    ["anthropic", "claude-sonnet", "monthly spend limit", "quota", "gpt-6-luna"],
    ["openai", "gpt-6-luna", "Failed to authenticate", "login", "claude-sonnet"],
  ] as const)("moves %s from %s on %s", async (provider, selection, message, reason, target) => {
    const { s } = await prepared({ startEvents: false });
    await s.deps.webchatRepo.updateSessionLargeModelSelection(CONCIERGE_CHAT, selection);
    expect(
      await s.service.switchForFailure(CONCIERGE_CHAT, failure(message, provider), reason),
    ).toMatchObject({ selectionId: target, reason });
    expect(s.deps.agentSessionManager.find).toHaveBeenCalled();
  });
  it("falls back on the same provider only for ambiguous quota, without marking it", async () => {
    const { s, raw } = await prepared({ startEvents: false });
    raw.openai = reportOf("unauthorized");
    expect(
      await s.service.switchForFailure(CONCIERGE_CHAT, failure("You've hit your limit"), "quota"),
    ).toMatchObject({ selectionId: "claude-opus-5-5" });
    expect(raw.anthropic?.state).toBe("available");
  });
  it.each([
    "api source",
    "credits target",
    "both out",
    "other chat",
  ])("refuses %s", async (kind) => {
    const { s, raw } = await prepared({ startEvents: false });
    if (kind === "api source")
      raw.anthropic = reportOf("available", {
        authMethod: "environment",
        usageLimited: false,
      });
    if (kind === "credits target") raw.openai = reportOf("unauthorized");
    if (kind === "both out") {
      raw.anthropic = reportOf("usage_limit_reached");
      raw.openai = reportOf("usage_limit_reached");
    }
    expect(
      await s.service.switchForFailure(
        kind === "other chat" ? "task" : CONCIERGE_CHAT,
        failure("monthly spend limit"),
        "quota",
      ),
    ).toBeNull();
    expect(s.deps.webchatRepo.addBackendMessage).not.toHaveBeenCalled();
  });
  it("blocks a return for ten minutes but permits it after the interval", async () => {
    const { s } = await prepared({ startEvents: false });
    const now = rs.spyOn(Date, "now").mockReturnValue(1_000_000);
    expect(
      await s.service.switchForFailure(CONCIERGE_CHAT, failure("Sign-in failed"), "login"),
    ).not.toBeNull();
    expect(
      await s.service.switchForFailure(
        CONCIERGE_CHAT,
        failure("Sign-in failed", "openai"),
        "login",
      ),
    ).toBeNull();
    now.mockReturnValue(1_600_001);
    expect(
      await s.service.switchForFailure(
        CONCIERGE_CHAT,
        failure("Sign-in failed", "openai"),
        "login",
      ),
    ).not.toBeNull();
  });
  it.each(["loggedOut", "reauth"])("switches before a turn when %s", async (kind) => {
    const { s, raw } = await prepared({ startEvents: false });
    raw.anthropic = reportOf(kind === "loggedOut" ? "unauthorized" : "expired");
    expect(await s.service.switchIfExhausted(CONCIERGE_CHAT)).toMatchObject({
      reason: "login",
      to: "openai",
    });
  });
  it("moves an Auto chat whose first turn failed before any provider was recorded", async () => {
    const s = setup({ startEvents: false });
    await s.storedChats.createSession(CONCIERGE_CHAT, "Concierge");
    s.service.deps.webchatRepo = s.storedChats;
    // No turn has succeeded, so the runtime row records no provider, and
    // neither provider is marked: only the failed turn names its provider.
    s.service.deps.sessionRepository = {
      current: rs.fn(async () => ({ provider: null, model: null })),
    } as never;
    s.service.deps.accounts = fakeAccounts(bothAvailable());
    expect(
      await s.service.switchForFailure(
        CONCIERGE_CHAT,
        { message: "You've hit your limit", provider: "anthropic" },
        "quota",
      ),
    ).toMatchObject({ from: "anthropic", to: "openai" });
  });
  it("keeps a Codex pick on Rome credits, and still moves on a Codex reauth", async () => {
    const s = setup({ startEvents: false });
    await s.storedChats.createSession(CONCIERGE_CHAT, "Concierge");
    await s.storedChats.updateSessionLargeModelSelection(CONCIERGE_CHAT, "gpt-6-luna");
    s.service.deps.webchatRepo = s.storedChats;
    const raw: ModelAccountReports = {
      anthropic: reportOf("available"),
      openai: reportOf("unauthorized"),
    };
    s.deps.accounts = fakeAccounts(() => raw);
    expect(await s.service.switchIfExhausted(CONCIERGE_CHAT)).toBeNull();
    raw.openai = reportOf("expired");
    expect(await s.service.switchIfExhausted(CONCIERGE_CHAT)).toMatchObject({ reason: "login" });
  });
  it("drops a pending retry when the failed subscription stops paying during the wait", async () => {
    let release!: () => void;
    const delay = rs.fn(
      (_ms: number) =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { s } = await prepared({ delay });
    const raw: ModelAccountReports = bothAvailable();
    s.deps.accounts = fakeAccounts(() => raw);
    await finish(s, failure("Selected model is busy: API Error: 503", "openai"));
    expect(delay).toHaveBeenCalledTimes(1);
    raw.openai = reportOf("unauthorized");
    release();
    await s.settle();
    expect(s.backendTurns).toHaveLength(0);
  });
  it("waits about thirty seconds before one same-model retry, then stops on success", async () => {
    let release!: () => void;
    const delay = rs.fn(
      (_ms: number) =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { s } = await prepared({ delay });
    s.onBackendTurn(() => {
      void finish(s);
    });
    await finish(s, failure("Repeated 529 Overloaded errors"));
    expect(delay).toHaveBeenCalledWith(30_000);
    expect(s.backendTurns).toHaveLength(0);
    release();
    await s.settle();
    expect(s.backendTurns).toHaveLength(1);
    expect(s.deps.webchatRepo.addBackendMessage).not.toHaveBeenCalled();
  });
  it.each([
    "temporary",
    "model_limit",
  ] as const)("tries one cross-provider recovery after %s recovery fails, then terminates", async (reason) => {
    const { s } = await prepared({ delay: async () => {} });
    s.onBackendTurn(() => {
      void finish(
        s,
        failure("Connection error", s.backendTurns.length === 2 ? "openai" : "anthropic"),
        "recovery",
      );
    });
    await finish(
      s,
      failure(reason === "temporary" ? "Connection error" : "You've hit your Sonnet limit"),
    );
    await s.settle();
    expect(s.backendTurns).toHaveLength(2);
    expect(s.backendTurns.every((t) => t.prompt.includes("Do only what remains"))).toBe(true);
    expect(s.deps.webchatRepo.addBackendMessage).toHaveBeenCalledTimes(
      reason === "temporary" ? 1 : 2,
    );
  });
  it.each([
    ["background failure", false],
    ["background success", false],
    ["guardian completion", false],
    ["background failure", true],
    ["background success", true],
    ["guardian completion", true],
  ] as const)("keeps one retry after %s during the wait (retry fails: %s)", async (during, retryFails) => {
    let release!: () => void;
    const delay = rs.fn(
      (_ms: number) =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { s } = await prepared({ delay });
    let retries = 0;
    s.onBackendTurn((turn) => {
      if (turn.prompt.includes("<task_events>")) {
        void finish(
          s,
          during === "background failure" ? failure("Connection error") : undefined,
          "background",
        );
      } else {
        retries++;
        void finish(
          s,
          retryFails && retries === 1 ? failure("Connection error") : undefined,
          "recovery",
        );
      }
    });
    await finish(s, failure("Connection error"));
    if (during === "guardian completion") await finish(s, undefined, "guardian");
    else await s.service.runSystemTurn(CONCIERGE_CHAT, "<task_events>Task changed</task_events>");
    expect(retries).toBe(0);
    expect(delay).toHaveBeenCalledTimes(1);
    expect(delay).toHaveBeenCalledWith(30_000);
    release();
    await s.settle();
    expect(retries).toBe(retryFails ? 2 : 1);
    expect(s.backendTurns.filter((turn) => turn.prompt.includes("<quota_recovery>"))).toHaveLength(
      retryFails ? 2 : 1,
    );
    expect(s.deps.webchatRepo.addBackendMessage).toHaveBeenCalledTimes(retryFails ? 1 : 0);
    expect(delay).toHaveBeenCalledTimes(1);
  });
  it.each([
    { code: "model_unavailable" },
    { reason: "model_access_denied" },
  ] as const)("moves a structured model refusal %j to another model on the same provider", async (fields) => {
    const { s } = await prepared();
    await s.deps.webchatRepo.updateSessionLargeModelSelection(CONCIERGE_CHAT, "gpt-6-luna");
    s.onBackendTurn(() => {
      void finish(s);
    });
    await finish(s, {
      message: "Model not served",
      provider: "openai",
      httpStatus: 403,
      ...fields,
    });
    await s.settle();
    expect(s.deps.webchatRepo.updateSessionLargeModelSelection).toHaveBeenLastCalledWith(
      CONCIERGE_CHAT,
      "gpt-5-6-terra",
    );
    expect(s.backendTurns).toHaveLength(1);
    expect(s.deps.webchatRepo.addBackendMessage).toHaveBeenCalledTimes(1);
  });
  it.each([
    "Prompt is too long",
    "invalid_request",
    "max_tokens",
    "Content refusal",
    "User stopped the turn",
    "Reached maximum number of turns (2)",
    "Claude Code process exited with code 1",
    "Rome is shutting down",
    "Credit balance is too low",
    "structured output missing",
  ])("does not recover %s", async (message) => {
    const { s } = await prepared({ delay: async () => {} });
    await finish(s, failure(message));
    expect(s.backendTurns).toHaveLength(0);
    expect(s.deps.webchatRepo.addBackendMessage).not.toHaveBeenCalled();
  });
  it("uses the runtime model for a same-provider move without a stored selection", async () => {
    const s = setup({ startEvents: false });
    s.deps.accounts = fakeAccounts(healthy);
    s.deps.sessionRepository.current = rs.fn(
      async () => ({ provider: "anthropic", model: "claude-sonnet-5-5" }) as never,
    );
    expect(
      await s.service.switchForFailure(CONCIERGE_CHAT, failure("Sonnet limit"), "model_limit"),
    ).toMatchObject({ selectionId: "claude-opus-5-5" });
  });
  it("does not return to a same-provider model within the cooldown", async () => {
    const { s, raw } = await prepared({ startEvents: false });
    raw.openai = reportOf("unauthorized");
    expect(
      await s.service.switchForFailure(CONCIERGE_CHAT, failure("Sonnet limit"), "model_limit"),
    ).not.toBeNull();
    expect(
      await s.service.switchForFailure(CONCIERGE_CHAT, failure("Opus limit"), "model_limit"),
    ).toBeNull();
  });
  it("does not move again after an excluded retry failure", async () => {
    const { s } = await prepared({ delay: async () => {} });
    s.onBackendTurn(() => {
      void finish(s, failure("Prompt is too long"));
    });
    await finish(s, failure("Connection error"));
    await s.settle();
    expect(s.backendTurns).toHaveLength(1);
    expect(s.deps.webchatRepo.addBackendMessage).not.toHaveBeenCalled();
  });
  it("recovers a topic chat as the main chat, and keeps each chat's cooldown its own", async () => {
    const { s } = await prepared({ delay: async () => {} });
    await s.deps.webchatRepo.updateSessionLargeModelSelection(TOPIC_CHAT, "claude-sonnet");
    s.onBackendTurn(() => {
      void s.finish({
        turnId: "ok",
        agentName: CONCIERGE_AGENT_ID,
        chatId: TOPIC_CHAT,
        text: "done",
      });
    });
    await s.finish({
      turnId: "failed",
      agentName: CONCIERGE_AGENT_ID,
      chatId: TOPIC_CHAT,
      status: "error",
      failure: failure("monthly spend limit"),
      text: "done",
    });
    await s.settle();
    expect(s.backendTurns.at(-1)).toMatchObject({ threadId: TOPIC_CHAT });
    expect(s.sessions.get(TOPIC_CHAT)).toMatchObject({ largeModelSelection: "gpt-6-luna" });
    // The topic chat left Sonnet; the main chat may still move to it.
    await s.deps.webchatRepo.updateSessionLargeModelSelection(CONCIERGE_CHAT, "gpt-6-luna");
    expect(
      await s.service.switchForFailure(
        CONCIERGE_CHAT,
        failure("monthly spend limit", "openai"),
        "quota",
      ),
    ).toMatchObject({ selectionId: "claude-sonnet" });
  });

  it("ignores a task chat's temporary failure", async () => {
    const { s } = await prepared({ delay: async () => {} });
    await s.finish({
      turnId: "task",
      agentName: "main",
      chatId: "task-chat",
      status: "error",
      failure: failure("Connection error"),
    });
    expect(s.backendTurns).toHaveLength(0);
    expect(s.deps.webchatRepo.addBackendMessage).not.toHaveBeenCalled();
  });
});

describe("Concierge chats", () => {
  it("opens a topic chat's runtime before its first background turn, as its first message would", async () => {
    const s = setup({ startEvents: false });
    s.deps.sessionRepository.current = (async (key: string) =>
      key === `webchat:${TOPIC_CHAT}` ? null : { id: "runtime-1" }) as never;
    expect(await s.service.runSystemTurn(TOPIC_CHAT, "<task_events/>")).toBe(true);
    expect(s.chats.openSession).toHaveBeenCalledWith(TOPIC_CHAT);
    expect(s.backendTurns.at(-1)).toMatchObject({
      sessionId: `opened-${TOPIC_CHAT}`,
      threadId: TOPIC_CHAT,
    });
    // A chat with a runtime keeps it.
    await s.service.runSystemTurn(CONCIERGE_CHAT, "<task_events/>");
    expect(s.chats.openSession).toHaveBeenCalledTimes(1);
    expect(s.backendTurns.at(-1)).toMatchObject({ sessionId: "runtime-1" });
  });

  it.each([
    "archived",
    "deleted",
  ] as const)("sends a defer's wake-up for a topic chat to the main chat once the topic chat is %s", async (how) => {
    const s = setup({ startEvents: false });
    // The wake-up `defer` stored while the task was watched in the topic chat.
    const wakeUp = {
      agentName: CONCIERGE_AGENT_ID,
      sessionId: "runtime-topic",
      channel: "webchat",
      threadId: TOPIC_CHAT,
      prompt: "⏰ Time's up: watch task:abc",
      ownerKey: "guardian",
    };
    expect(await s.service.resolveTurn(wakeUp)).toMatchObject({
      threadId: TOPIC_CHAT,
      sessionId: "runtime-topic",
    });
    if (how === "archived") {
      s.sessions.set(TOPIC_CHAT, { ...s.sessions.get(TOPIC_CHAT), archivedAt: new Date() });
    } else {
      s.sessions.delete(TOPIC_CHAT);
    }
    const fired = await s.service.resolveTurn(wakeUp);
    expect(fired).toMatchObject({ threadId: CONCIERGE_CHAT, sessionId: "runtime-1" });
    expect(fired.prompt).toBe(`${MAIN_LINE}⏰ Time's up: watch task:abc`);
    // A task chat's own wake-up is not the Concierge's, and stays.
    const taskWakeUp = { ...wakeUp, agentName: "main" };
    expect(await s.service.resolveTurn(taskWakeUp)).toEqual(taskWakeUp);
  });

  it("sends a visitor's wake-up for a deleted topic chat to their main chat, and drops one that records no owner", async () => {
    const s = setup({ startEvents: false });
    const owner = "visitor:acct-ann";
    const main = mainChatIdOf(owner);
    s.sessions.set(main, {
      ...s.sessions.get(CONCIERGE_CHAT),
      id: main,
      ownerKey: owner,
    });
    // Its topic chat is gone, as when its project folder was deleted with it.
    const wakeUp = {
      agentName: CONCIERGE_AGENT_ID,
      sessionId: "runtime-topic",
      channel: "webchat",
      threadId: "ann-topic",
      prompt: "⏰ Time's up",
      ownerKey: owner,
    };
    expect(await s.service.resolveTurn(wakeUp)).toMatchObject({ threadId: main });
    // Nothing says whose it was: it reaches nobody's chat, the guardian's included.
    const { ownerKey: _ownerKey, ...unowned } = wakeUp;
    await expect(s.service.resolveTurn(unowned)).rejects.toThrow("no owner");
  });

  it("moves an unused chat off an exhausted provider before opening its runtime for a delivery", async () => {
    const s = setup({ startEvents: false });
    s.deps.sessionRepository.current = (async () => null) as never;
    s.deps.accounts = fakeAccounts({
      anthropic: reportOf("usage_limit_reached"),
      openai: reportOf("available"),
    });
    s.sessions.set(CONCIERGE_CHAT, {
      ...s.sessions.get(CONCIERGE_CHAT),
      largeModelSelection: "claude-sonnet",
    });
    const openedOn: unknown[] = [];
    s.chats.openSession = rs.fn(async (chatId: string) => {
      openedOn.push(s.sessions.get(chatId)?.largeModelSelection);
      return `opened-${chatId}`;
    });
    await s.service.runSystemTurn(CONCIERGE_CHAT, "<external_events/>");
    // The runtime opens on the provider the quota check moved it to.
    expect(openedOn).toEqual(["gpt-6-luna"]);
    expect(s.backendTurns.at(-1)).toMatchObject({ sessionId: `opened-${CONCIERGE_CHAT}` });
  });

  it("lists the main chat first, then the topic chats", async () => {
    const s = setup({ startEvents: false });
    expect(await s.service.listChats()).toEqual([
      { id: CONCIERGE_CHAT, name: "Concierge", main: true },
      { id: TOPIC_CHAT, name: "Calendar", main: false },
    ]);
  });

  it("delivers to a live Concierge chat, and to the main chat for one archived, gone, or not a Concierge chat", async () => {
    const s = setup({ startEvents: false });
    expect(await s.service.deliveryChat(TOPIC_CHAT, "guardian")).toBe(TOPIC_CHAT);
    expect(await s.service.deliveryChat(null, "guardian")).toBe(CONCIERGE_CHAT);
    expect(await s.service.deliveryChat("gone", "guardian")).toBe(CONCIERGE_CHAT);
    s.sessions.set(TOPIC_CHAT, { ...s.sessions.get(TOPIC_CHAT), archivedAt: new Date() });
    expect(await s.service.deliveryChat(TOPIC_CHAT, "guardian")).toBe(CONCIERGE_CHAT);
  });

  it("retiring a topic chat moves its open tasks to the main chat and says so there; the main chat cannot be retired", async () => {
    const s = setup({ startEvents: false });
    await s.storedChats.createSession(TOPIC_CHAT, "Calendar");
    s.turnIn(TOPIC_CHAT);
    await s.tool("task_upsert", { tasks: [{ title: "Book dentist" }] });
    await s.tool("task_upsert", { tasks: [{ title: "Old", state: "done" }] });
    await s.service.retireChat(TOPIC_CHAT, "archived");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const rows = await s.tasks.listForPanel();
    expect(rows.find((row) => row.title === "Book dentist")?.conciergeChat.main).toBe(true);
    // A finished row keeps its chat, and its owner with it.
    expect(rows.find((row) => row.title === "Old")?.conciergeChat.id).toBe(TOPIC_CHAT);
    expect(s.backendTurns.at(-1)).toMatchObject({ threadId: CONCIERGE_CHAT });
    expect(s.backendTurns.at(-1)?.prompt).toContain(
      '<concierge_chat_retired name="Calendar" how="archived" follows="0" tasks="1"/>',
    );
    await expect(s.service.retireChat(CONCIERGE_CHAT, "deleted")).rejects.toThrow("main");
  });

  it("switches a topic chat's provider when its quota runs out, as the main chat's", async () => {
    const s = setup({ startEvents: false });
    s.deps.accounts = fakeAccounts({
      anthropic: reportOf("usage_limit_reached"),
      openai: reportOf("available", { ...RESTRICTED_PLAN }),
    });
    s.sessions.set(TOPIC_CHAT, {
      ...s.sessions.get(TOPIC_CHAT),
      largeModelSelection: "claude-sonnet",
    });
    expect(await s.service.switchIfExhausted(TOPIC_CHAT)).toMatchObject({ from: "anthropic" });
    expect(await s.service.switchIfExhausted("task-1")).toBeNull();
  });
});

describe("Concierge connect_card", () => {
  const text = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);
  const MAIL_CONNECT = {
    kind: "composio",
    method: "POST",
    path: "/api/apps/connector/connectors",
    body: { provider: "mail" },
    needsLogin: true,
    login: { method: "POST", path: "/api/apps/connector/login/start" },
  } as const;

  /** A list of services as the following list reads them. */
  const withServices = (s: ReturnType<typeof setup>, connectors: Record<string, unknown>[]) => {
    const list = rs.fn(async () => ({ connectors, rules: {} }));
    s.service.attachFollowing({ list } as unknown as ConciergeFollowing);
    return list;
  };

  const cards = (s: ReturnType<typeof setup>) =>
    (s.messages.get(CONCIERGE_CHAT) ?? []).map((row) => JSON.parse(row.content));

  it("shows the card of a service that is not connected, with the label and entry the list gave it", async () => {
    const s = setup();
    const list = withServices(s, [
      { service: "mail", label: "Mail", icon: "glyph:gmail", state: null, connect: MAIL_CONNECT },
    ]);

    const result = await s.tool("connect_card", { service: "mail" });

    expect(result.isError).toBeFalsy();
    expect(list).toHaveBeenCalledWith("guardian");
    expect(cards(s)).toEqual([
      [
        {
          type: "connect_card",
          service: "mail",
          label: "Mail",
          icon: "glyph:gmail",
          connect: MAIL_CONNECT,
        },
      ],
    ]);
    expect(text(result)).toMatchObject({ sent: expect.any(String), messageId: "said-1" });
  });

  it.each([
    [
      "a service Rome Cloud signs in",
      {
        kind: "rome_oauth",
        url: "https://cloud.test/connect",
        available: true,
        unavailableReason: null,
      },
    ],
    [
      "a service Rome Cloud cannot sign in here",
      { kind: "rome_oauth", url: null, available: false, unavailableReason: "Not set up" },
    ],
    ["a service only Settings connects", { kind: "dashboard" }],
  ])("carries the entry of %s unchanged", async (_, connect) => {
    const s = setup();
    withServices(s, [
      { service: "code", label: "Code host", icon: "brand:code", state: "broken", connect },
    ]);

    await s.tool("connect_card", { service: "code" });

    expect(cards(s)).toEqual([
      [{ type: "connect_card", service: "code", label: "Code host", icon: "brand:code", connect }],
    ]);
  });

  it("falls back to Settings for a service that is not connected and lists no entry", async () => {
    const s = setup();
    withServices(s, [{ service: "code", label: "Code host", state: null, connect: null }]);

    await s.tool("connect_card", { service: "code" });

    expect(cards(s)[0][0].connect).toEqual({ kind: "dashboard" });
  });

  it("carries no icon for a service whose source names none", async () => {
    const s = setup();
    withServices(s, [
      { service: "code", label: "Code host", icon: null, state: null, connect: null },
    ]);

    await s.tool("connect_card", { service: "code" });

    expect(cards(s)[0][0].icon).toBeNull();
  });

  it("says so and shows no card when the service already works", async () => {
    const s = setup();
    withServices(s, [{ service: "mail", label: "Mail", state: "working", connect: null }]);

    const result = await s.tool("connect_card", { service: "mail" });

    expect(result.isError).toBeFalsy();
    expect(text(result)).toMatchObject({ connected: true });
    expect(cards(s)).toEqual([]);
  });

  it("refuses a service the list does not have", async () => {
    const s = setup();
    withServices(s, [{ service: "mail", label: "Mail", state: null, connect: MAIL_CONNECT }]);

    const result = await s.tool("connect_card", { service: "fax" });

    expect(result.isError).toBe(true);
    expect(cards(s)).toEqual([]);
  });
});

describe("Concierge first sign-in and connection notices", () => {
  it("makes the Concierge's main chat and sends the guardian's message into it", async () => {
    const s = setup({ startEvents: false });

    const chatId = await s.service.startMainChat("Help me follow Gmail.");

    expect(chatId).toBe(CONCIERGE_CHAT);
    expect(s.settingsWrites).toEqual([]);
    expect(s.chats.sendAsGuardian).toHaveBeenCalledTimes(1);
    expect(s.chats.sendAsGuardian).toHaveBeenCalledWith(CONCIERGE_CHAT, "Help me follow Gmail.");
    // The message is the guardian's own, so no system turn or input is made for it.
    expect(s.backendTurns).toEqual([]);
  });

  it("only makes the main chat when there is no message to send", async () => {
    const s = setup({ startEvents: false });

    expect(await s.service.startMainChat(null)).toBe(CONCIERGE_CHAT);

    expect(s.settingsWrites).toEqual([]);
    expect(s.chats.sendAsGuardian).not.toHaveBeenCalled();
  });

  it("answers the chat even when the message cannot be sent", async () => {
    const s = setup({ startEvents: false });
    s.chats.sendAsGuardian = rs.fn(async () => {
      throw new Error("no model");
    });

    expect(await s.service.startMainChat("Help me follow Gmail.")).toBe(CONCIERGE_CHAT);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("tells the Concierge of a connected service quietly, in the chat it was connected from", async () => {
    const s = setup({ startEvents: false });

    s.service.serviceConnected(TOPIC_CHAT, 'ma"il');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(s.backendTurns).toHaveLength(1);
    expect(s.backendTurns[0]).toMatchObject({ threadId: TOPIC_CHAT });
    expect(s.backendTurns[0].prompt).toContain('<service_connected service="ma&quot;il"/>');
    expect(s.turnOptions[0]).toEqual({ quiet: true, inputLabel: "Service connected" });
  });
});
