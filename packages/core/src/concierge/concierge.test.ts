import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { and, eq } from "drizzle-orm";
import { threadIdOf } from "../apps/repositories/approvals.js";
import { approvalWaits } from "../test/open-waits.js";
import { withAskingDevice } from "../connections/device/live-route.js";
import { RESOLVED_BY_EXPIRY, RESOLVED_BY_STOP } from "./approval-expiry.js";
import type { DrizzleTx } from "../db/index.js";
import { POSTPONED_CHECKS } from "./service.js";
import type {
  Account,
  AgentTurnFinishedEvent,
  AgentTurnFailure,
  BackendTurnParams,
  ChatId,
} from "@rome-os/app-runtime";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessagePage } from "../chats/message-repository.js";
import type { SaidMessage } from "../chats/message.js";
import type { Place } from "../chats/place.js";
import type { Body, SendResult } from "../chats/send.js";
import type { SessionToolContext } from "../core/session-tools.js";
import type { NotifyLevel, SendOutcome, SystemNotifyContent } from "../instance/notify-client.js";
import type { ConciergeFollowing } from "./following.js";
import { ChatRepository as StoredChats } from "../chats/storage/chat-repository.js";
import { MessageRepository as StoredMessages } from "../chats/storage/message-repository.js";
import { placeIn } from "../chats/storage/place.js";
import { chatKey } from "../connections/chat-ids.js";
import { ConciergeTasksRepository } from "../db/repositories/concierge-tasks.js";
import { SettingsRepository } from "../db/repositories/settings.js";
import { conciergeMessageTurns } from "../db/schema.js";
import { createTestDb, type TestDb } from "../test/db.js";
import { readWebchatMessages } from "../webchat/adapter.js";
import type { AgentTurnFailedBeforeStart, TurnLifecycleListener } from "../agent/index.js";
import { CONCIERGE_REACTIONS, CONCIERGE_TASK_SUMMARY_MAX_LENGTH } from "@rome/api-types/concierge";
import { resultSummary, startConciergeEvents } from "./events.js";
import { MIN_FLUSH_SPACING_MS, RETRY_MS, TaskEventCoalescer } from "./task-events.js";
import { NUDGE_PROMPT, quotaRecoveryPrompt } from "./nudge.js";
import { mainChatIdOf } from "./main-chat.js";
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
import {
  CONCLUSION_CLOSE,
  CONCLUSION_MAX_CHARS,
  CONCLUSION_OPEN,
  NOTHING_TO_REPORT,
  RECURRING_PREFIX,
} from "./conclusion.js";

const CONCIERGE_CHAT = CONCIERGE_CHAT_ID;
/** A topic chat: another Concierge chat. */
const TOPIC_CHAT = "topic-1";
const isConciergeChatId = (id: string) => id === CONCIERGE_CHAT || id === TOPIC_CHAT;

/** A task chat's final answer: its details, then its conclusion between the markers. */
const concluded = (conclusion: string, details = "Full details of the work.") =>
  `${details}\n\n${CONCLUSION_OPEN}\n${conclusion}\n${CONCLUSION_CLOSE}`;

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
  /** The row it replies to, and the root of its chat thread: the root's key, or unset for its own. */
  replyTo?: string;
  chatThread?: string;
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
  /** The Concierge chat the tools' turn runs in. */
  const here = {
    chat: CONCIERGE_CHAT as string,
    pushLevel: undefined as NotifyLevel | undefined,
    reportedTask: undefined as string | undefined,
    turnId: "concierge-turn-1",
    askingDeviceId: undefined as string | undefined,
  };
  const messages = new Map<string, Row[]>();
  /** Every input posted to a task chat, by id, in order. */
  const posted: string[] = [];
  /** What the next send answers when it is refused. */
  let refuseWith: Exclude<SendResult, { ok: true }> | null = null;
  /** The task chats whose turn runs: from a message sent in until it finishes. */
  const runningTaskChats = new Set<string>();
  const backendTurns: BackendTurnParams[] = [];
  const order: string[] = [];
  /** The reaction each message holds, by `chat:message`. */
  const reactions = new Map<string, string>();
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
    // A task chat runs from the message that starts its turn until that
    // turn finishes, as the dashboard's runtime reports it.
    activeTurns: rs.fn((chatId: string) =>
      runningTaskChats.has(chatId) ? [`task-turn-${chatId}`] : [],
    ),
    interruptTurn: rs.fn(async () => {}),
  };
  const send = rs.fn(async (place: Place, body: Body, as: Account): Promise<SendResult> => {
    if (refuseWith) return refuseWith;
    if (place.chat.id.startsWith("task-")) runningTaskChats.add(place.chat.id);
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
      setAskingDevice: rs.fn(async () => {}),
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
          options: { replyTo?: string } = {},
        ) => {
          const list = messages.get(chatId) ?? [];
          const id = `said-${++saidCount}`;
          // A reply joins the thread of the row it replies to, as Chats records it.
          const quoted = list.find((row) => row.id === options.replyTo);
          list.push({
            id,
            role: "assistant",
            content: JSON.stringify(parts),
            turnId,
            ...(options.replyTo
              ? { replyTo: options.replyTo, chatThread: quoted?.chatThread ?? options.replyTo }
              : {}),
          });
          messages.set(chatId, list);
          return { id };
        },
      ),
      setMessageReaction: rs.fn(
        async (chatId: string, messageId: string, reaction: string | null) => {
          if (!messages.get(chatId)?.some((row) => row.id === messageId)) return false;
          if (reaction === null) reactions.delete(`${chatId}:${messageId}`);
          else reactions.set(`${chatId}:${messageId}`, reaction);
          return true;
        },
      ),
      getReplyTarget: async (chatId: string, messageId: string) => {
        const row = [
          ...(isConciergeChatId(chatId) && options.said !== false ? [ACKNOWLEDGEMENT] : []),
          ...(messages.get(chatId) ?? []),
        ].find(
          (candidate) =>
            candidate.id === messageId &&
            (candidate.role === "user" || candidate.role === "assistant"),
        );
        return row ? { ...row, chatThreadId: row.chatThread ?? row.id ?? null } : null;
      },
      setSessionTrigger: rs.fn(
        async (id: string, trigger: { triggerKind: string; triggerName: string | null }) => {
          order.push("trigger");
          sessions.set(id, { ...sessions.get(id), ...trigger });
        },
      ),
      createSession: rs.fn(async () => {}),
      archiveSessionIn: (tx: DrizzleTx, id: string) => {
        storedChats.archiveSessionIn(tx, id);
        if (sessions.has(id)) sessions.set(id, { ...sessions.get(id), archivedAt: new Date() });
      },
      deleteSessionIn: (tx: DrizzleTx, id: string) => {
        storedChats.deleteSessionIn(tx, id);
        sessions.delete(id);
      },
      deleteSession: rs.fn(async (id: string) => {
        await storedChats.deleteSession(id);
        sessions.delete(id);
      }),
      listProjects: async () => [{ path: "default" }, { path: "rome-oss" }],
      // The activity's own sources (activity.test.ts covers it).
      onMessageInserted: () => () => {},
      awaitingGuardianSince: async () => new Map<string, number>(),
      openWaitsOf: async () => new Map(),
      taskCardsOf: async () => new Map(),
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
    getThreadContext: () =>
      withAskingDevice(
        { channel: "webchat", threadId: here.chat, channelUserId: "guardian" },
        here.askingDeviceId,
      ),
    getTurnPushLevel: () => here.pushLevel,
    getTurnReportedTask: () => here.reportedTask,
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
    /** A newer input cut the turn short and took its work on. */
    handedOn?: boolean;
  }) => {
    if (!isConciergeChatId(event.chatId) && !event.handedOn) runningTaskChats.delete(event.chatId);
    for (const listener of listeners) {
      listener({
        ...(event.handedOn ? { handedOn: true } : {}),
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
  const failBeforeStart = async (event: {
    turnId: string;
    chatId: string;
    error: string;
    agentName?: string;
  }) => {
    runningTaskChats.delete(event.chatId);
    for (const listener of failedBeforeStartListeners) {
      listener({
        turn: {
          sessionId: "runtime-x",
          turnId: event.turnId,
          agentName: event.agentName ?? "core:main",
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
  /** Whether the turn that took message `key` of the Concierge chat answered it, or null when none took it. */
  const answered = (key: string) => {
    const [row] = testDb.db
      .select({ answeredAt: conciergeMessageTurns.answeredAt })
      .from(conciergeMessageTurns)
      .where(
        and(
          eq(conciergeMessageTurns.chatId, CONCIERGE_CHAT),
          eq(conciergeMessageTurns.messageKey, key),
        ),
      )
      .all();
    return row ? row.answeredAt !== null : null;
  };
  return {
    service,
    deps,
    tasks,
    taskRepo,
    reactions,
    answered,
    storedChats,
    quietFlags,
    settingsWrites,
    turnOptions,
    pushes,
    /** Runs the tools' turn as one the guardian started from this device. */
    askFrom: (deviceId: string | undefined) => {
      here.askingDeviceId = deviceId;
    },
    /** Runs the tools' turn as one the guardian did not start, pushed at this level. */
    pushLevel: (level: NotifyLevel | undefined) => {
      here.pushLevel = level;
    },
    /** Runs the tools' turn as one that answers this message without having started from it. */
    reportedTask: (taskId: string | undefined) => {
      here.reportedTask = taskId;
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
    // As the repository tells it: with the chat its payload names kept apart.
    createApproval: (approval: Record<string, unknown>) => {
      for (const listener of approvalListeners)
        listener({ ...approval, threadId: threadIdOf(approval.payload) });
    },
    resolveApproval: (approval: Record<string, unknown>) => {
      for (const listener of resolvedListeners)
        listener({ ...approval, threadId: threadIdOf(approval.payload) });
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
      "react",
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

  it("asks the guardian about a task with its own card, which the row then points to", async () => {
    const s = setup();
    const tools = await buildConciergeTools(s.service, s.context());
    const upsert = tools.find((tool) => tool.name === "task_upsert")!;
    const schema = upsert.inputSchema as {
      properties: { tasks: { items: { properties: Record<string, { description: string }> } } };
    };
    const fields = schema.properties.tasks.items.properties;
    // Rome keeps the status: the Concierge writes none of its fields.
    for (const field of ["state", "waitingOn", "dueAt", "rank", "chatId"]) {
      expect(fields[field]).toBeUndefined();
    }
    expect(upsert.description).toContain("Rome keeps each task's status");
    const card = tools.find((tool) => tool.name === "chat_card")!;
    expect(card.description).toContain("the card is its question or approval alone");
    expect(card.description).toContain(
      "The card replies to the task's start message, and the task's row then points to it.",
    );
    expect(fields.messageId.description).toContain(
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

  it("sends a message repeated word for word in one turn once, so the phone rings once", async () => {
    const s = setup();
    const idOf = (result: unknown) =>
      JSON.parse((result as { content: { text: string }[] }).content[0]!.text).messageId as string;
    const first = idOf(await s.tool("say", { text: "apple.txt is made." }));
    await s.tool("say", { text: "pear.txt is made." });
    const again = idOf(await s.tool("say", { text: "apple.txt is made." }));

    expect(again).toBe(first);
    expect(s.messages.get(CONCIERGE_CHAT)?.map((row) => JSON.parse(row.content))).toEqual([
      [{ type: "text", content: "apple.txt is made." }],
      [{ type: "text", content: "pear.txt is made." }],
    ]);
  });

  it("says the same words about two tasks as two messages, one for each", async () => {
    const s = setup();
    const idOf = (result: unknown) =>
      JSON.parse((result as { content: { text: string }[] }).content[0]!.text).messageId as string;
    const [apple, pear] = await s.taskRepo.upsertMany([
      { title: "Apple", state: "doing", chatId: CONCIERGE_CHAT },
      { title: "Pear", state: "doing", chatId: CONCIERGE_CHAT },
    ]);
    const first = idOf(await s.tool("say", { text: "Done ✅", task: apple!.id }));
    const second = idOf(await s.tool("say", { text: "Done ✅", task: pear!.id }));
    expect(second).not.toBe(first);
    expect(s.messages.get(CONCIERGE_CHAT)).toHaveLength(2);
    // The same words about the same task are still one message.
    expect(idOf(await s.tool("say", { text: "Done ✅", task: pear!.id }))).toBe(second);
  });

  describe("reply targets", () => {
    const replyOf = (s: ReturnType<typeof setup>, id: string) =>
      s.messages.get(CONCIERGE_CHAT)?.find((row) => row.id === id)?.replyTo;
    const threadOf = (s: ReturnType<typeof setup>, id: string) =>
      s.messages.get(CONCIERGE_CHAT)?.find((row) => row.id === id)?.chatThread;
    const guardianSays = (s: ReturnType<typeof setup>, row: Partial<Row> & { id: string }) => {
      const list = s.messages.get(CONCIERGE_CHAT) ?? [];
      list.push({ role: "user", content: "[]", turnId: "concierge-turn-1", ...row });
      s.messages.set(CONCIERGE_CHAT, list);
    };
    const saidId = (result: unknown) =>
      JSON.parse((result as { content: { text: string }[] }).content[0]!.text).messageId as string;
    /** A task of the Concierge chat whose start message is `start`. */
    const taskStartedAt = async (s: ReturnType<typeof setup>, start: string, title = "Flights") =>
      (
        await s.taskRepo.upsertMany([
          { title, state: "doing", chatId: CONCIERGE_CHAT, sourceMessageId: start },
        ])
      )[0]!;

    it("replies to nothing when the turn holds no guardian message and reports no task", async () => {
      const s = setup({ said: false });
      const said = saidId(await s.tool("say", { text: "Good morning" }));
      expect(replyOf(s, said)).toBeUndefined();
      expect(threadOf(s, said)).toBeUndefined();
    });

    it("answers the turn's last guardian message", async () => {
      const s = setup({ said: false });
      guardianSays(s, { id: "g1" });
      guardianSays(s, { id: "g2" });
      const said = saidId(await s.tool("say", { text: "Sunny, 24°" }));
      expect(replyOf(s, said)).toBe("g2");
      expect(threadOf(s, said)).toBe("g2");
      expect(s.deps.webchatRepo.addBackendMessage).toHaveBeenCalledWith(
        CONCIERGE_CHAT,
        "concierge-turn-1",
        [{ type: "text", content: "Sunny, 24°" }],
        { replyTo: "g2" },
      );
    });

    it("answers the guardian message it names, and refuses one the turn does not hold", async () => {
      const s = setup({ said: false });
      guardianSays(s, { id: "g1" });
      guardianSays(s, { id: "g2" });
      const said = saidId(await s.tool("say", { text: "About the first", answers: "g1" }));
      expect(replyOf(s, said)).toBe("g1");
      await expect(s.tool("say", { text: "x", answers: "elsewhere" })).resolves.toMatchObject({
        isError: true,
      });
    });

    it("answers a reply in the thread the guardian message is in", async () => {
      const s = setup({ said: false });
      guardianSays(s, { id: "g0", turnId: "older" });
      guardianSays(s, { id: "g1", replyTo: "g0", chatThread: "g0" });
      const said = saidId(await s.tool("say", { text: "More on that" }));
      expect(replyOf(s, said)).toBe("g1");
      expect(threadOf(s, said)).toBe("g0");
    });

    it("puts a message naming a task under the task's start message, whatever the turn holds", async () => {
      const s = setup({ said: false });
      const task = await taskStartedAt(s, "g0");
      guardianSays(s, { id: "g0", turnId: "older" });
      guardianSays(s, { id: "g1" });
      const said = saidId(await s.tool("say", { text: "Found 3 flights", task: task.id }));
      expect(replyOf(s, said)).toBe("g0");
      expect(threadOf(s, said)).toBe("g0");
    });

    it("replies to nothing for a task with no start message, never to the turn's guardian message", async () => {
      const s = setup({ said: false });
      const [task] = await s.taskRepo.upsertMany([
        { title: "Flights", state: "doing", chatId: CONCIERGE_CHAT },
      ]);
      guardianSays(s, { id: "g1" });
      const said = saidId(await s.tool("say", { text: "Found 3", task: task!.id }));
      expect(replyOf(s, said)).toBeUndefined();
      // A forward and a card for a task whose start message is gone do the same.
      const { chatId, taskId } = JSON.parse(
        (await s.tool("chat_start", { title: "Hotels", brief: "Find hotels" })).content[0].text,
      ) as { chatId: string; taskId: string };
      await s.taskRepo.upsertMany([{ id: taskId, sourceMessageId: null }]);
      s.messages.get(chatId)?.push({
        role: "assistant",
        content: JSON.stringify([{ type: "text", content: concluded("2 hotels") }]),
      });
      const forwarded = saidId(await s.tool("chat_forward", { chatId }));
      expect(replyOf(s, forwarded)).toBeUndefined();
      expect(threadOf(s, forwarded)).toBeUndefined();
    });

    it("answers the start message of the task a turn without a guardian message reports", async () => {
      const s = setup({ said: false });
      const task = await taskStartedAt(s, "g0");
      guardianSays(s, { id: "g0", turnId: "older" });
      s.inTurn("report");
      s.reportedTask(task.id);
      const said = saidId(await s.tool("say", { text: "Found 3 flights" }));
      expect(replyOf(s, said)).toBe("g0");
      // A report turn that also holds a guardian message answers that message.
      guardianSays(s, { id: "g1", turnId: "report" });
      expect(replyOf(s, saidId(await s.tool("say", { text: "And one more" })))).toBe("g1");
    });

    it("replies to nothing for a task another Concierge chat owns", async () => {
      const s = setup({ said: false });
      await s.storedChats.createSession(CONCIERGE_CHAT, "Concierge");
      await s.storedChats.createSession(TOPIC_CHAT, "Calendar");
      const task = await taskStartedAt(s, "g0");
      s.turnIn(TOPIC_CHAT);
      s.inTurn("report");
      s.reportedTask(task.id);
      const said = saidId(await s.tool("say", { text: "Found 3 flights" }));
      expect(s.messages.get(TOPIC_CHAT)?.find((row) => row.id === said)?.replyTo).toBeUndefined();
    });

    it("adds no quote to a reply Rome makes", async () => {
      const s = setup({ said: false });
      guardianSays(s, { id: "g1" });
      const said = saidId(await s.tool("say", { text: "Sunny" }));
      const row = s.messages.get(CONCIERGE_CHAT)?.find((candidate) => candidate.id === said);
      expect(JSON.parse(row!.content)).toEqual([{ type: "text", content: "Sunny" }]);
    });

    /** The turn `turn` starts task "Flights" for the guardian message `g0`. */
    const startTask = async (s: ReturnType<typeof setup>, turn = "ask") => {
      s.inTurn(turn);
      guardianSays(s, { id: "g0", turnId: turn });
      const ack = saidId(await s.tool("say", { text: "On it" }));
      const started = JSON.parse(
        (await s.tool("chat_start", { title: "Flights", brief: "Find flights" })).content[0].text,
      ) as { chatId: string; taskId: string };
      return { ...started, ack };
    };

    it("starts a task at its acknowledgement, and the task's cards and forwards reply to it", async () => {
      const s = setup({ said: false });
      const { chatId, taskId, ack } = await startTask(s);
      expect((await s.tasks.repo.getWithChat(taskId))?.sourceMessageId).toBe(ack);
      expect([replyOf(s, ack), threadOf(s, ack)]).toEqual(["g0", "g0"]);

      s.inTurn("result");
      s.reportedTask(taskId);
      s.messages.get(chatId)?.push({
        role: "assistant",
        content: JSON.stringify([{ type: "text", content: concluded("Found 3 flights") }]),
      });
      const card = saidId(await s.tool("chat_card", { chatId }));
      expect([replyOf(s, card), threadOf(s, card)]).toEqual([ack, "g0"]);
      const forwarded = saidId(await s.tool("chat_forward", { chatId }));
      expect([replyOf(s, forwarded), threadOf(s, forwarded)]).toEqual([card, "g0"]);
    });

    it("starts a task for the guardian message, not for another task's report said in the same turn", async () => {
      const s = setup({ said: false });
      const flights = await startTask(s);
      // One turn holds the owner's new request and the flights task's news.
      s.inTurn("mixed");
      guardianSays(s, { id: "g1", turnId: "mixed" });
      const report = saidId(await s.tool("say", { text: "Found 3 flights", task: flights.taskId }));
      expect(threadOf(s, report)).toBe("g0");
      const hotels = JSON.parse(
        (await s.tool("chat_start", { title: "Hotels", brief: "Find hotels" })).content[0].text,
      ) as { taskId: string };
      expect((await s.tasks.repo.getWithChat(hotels.taskId))?.sourceMessageId).toBe("g1");
      // With the guardian's own acknowledgement said first, the task starts at it.
      const ack = saidId(await s.tool("say", { text: "On it", answers: "g1" }));
      const maps = JSON.parse(
        (await s.tool("chat_start", { title: "Maps", brief: "Find maps" })).content[0].text,
      ) as { taskId: string };
      expect((await s.tasks.repo.getWithChat(maps.taskId))?.sourceMessageId).toBe(ack);
    });

    it("keeps a follow-up in the task's thread when it replies to the thread's last message", async () => {
      const s = setup({ said: false });
      const { chatId, taskId } = await startTask(s);
      // The owner replies inside the thread; the Concierge sends the words on and answers them.
      s.inTurn("follow-up");
      guardianSays(s, { id: "g1", turnId: "follow-up", replyTo: "g0", chatThread: "g0" });
      await s.tool("chat_send", { chatId, text: "Make it Saturday" });
      const answer = saidId(await s.tool("say", { text: "Told it Saturday" }));
      expect([replyOf(s, answer), threadOf(s, answer)]).toEqual(["g1", "g0"]);
      s.inTurn("result");
      s.reportedTask(taskId);
      const result = saidId(await s.tool("say", { text: "Saturday works", task: taskId }));
      expect(threadOf(s, result)).toBe("g0");
    });

    it("sends a guardian message on to any task, and moves no message", async () => {
      const s = setup({ said: false });
      await startTask(s);
      const hotels = JSON.parse(
        (await s.tool("chat_start", { title: "Hotels", brief: "Find hotels", answers: "g0" }))
          .content[0].text,
      ) as { chatId: string };
      // A message in the flights thread is sent on to the hotels task.
      s.inTurn("follow-up");
      guardianSays(s, { id: "g1", turnId: "follow-up", replyTo: "g0", chatThread: "g0" });
      const sent = s.posted.length;
      const result = await s.tool("chat_send", { chatId: hotels.chatId, text: "Near the river" });
      expect(result.isError).toBeFalsy();
      expect(s.posted).toHaveLength(sent + 1);
      expect(threadOf(s, "g1")).toBe("g0");
      // chat_send takes only the words for the task.
      const send = (await buildConciergeTools(s.service, s.context())).find(
        (tool) => tool.name === "chat_send",
      )!;
      expect(Object.keys((send.inputSchema as { properties: object }).properties)).toEqual([
        "chatId",
        "text",
      ]);
    });

    it("starts two tasks for one message in one thread", async () => {
      const s = setup({ said: false });
      const first = await startTask(s);
      const second = JSON.parse(
        (await s.tool("chat_start", { title: "Hotels", brief: "Find hotels", answers: "g0" }))
          .content[0].text,
      ) as { taskId: string };
      expect(second.taskId).not.toBe(first.taskId);
      expect((await s.tasks.repo.getWithChat(second.taskId))?.sourceMessageId).toBe("g0");
      s.inTurn("result");
      s.reportedTask(second.taskId);
      expect(
        threadOf(s, saidId(await s.tool("say", { text: "Two hotels", task: second.taskId }))),
      ).toBe("g0");
    });

    it("hands a task chat the device the guardian asks from, so its live reads ask it", async () => {
      const s = setup({ said: false });
      guardianSays(s, { id: "g0", turnId: "start-turn" });
      s.inTurn("start-turn");
      await s.tool("say", { text: "On it" });
      s.askFrom("dev-asking");
      const { chatId } = JSON.parse(
        (await s.tool("chat_start", { title: "Steps", brief: "Read my steps" })).content[0].text,
      );
      expect(s.deps.webchatRepo.setAskingDevice).toHaveBeenCalledWith(chatId, "dev-asking");
      s.askFrom("dev-other");
      await s.tool("chat_send", { chatId, text: "And sleep" });
      expect(s.deps.webchatRepo.setAskingDevice).toHaveBeenLastCalledWith(chatId, "dev-other");
      // A turn no device started leaves the task chat's device as it is.
      s.askFrom(undefined);
      await s.tool("chat_send", { chatId, text: "And heart rate" });
      expect(s.deps.webchatRepo.setAskingDevice).toHaveBeenCalledTimes(2);
    });

    it("a turn reports on the one task it was started about, and a batch on none", async () => {
      const s = setup();
      const [row, other] = await s.tasks.repo.upsertMany([
        { title: "Flights", state: "doing", chatId: CONCIERGE_CHAT, sourceMessageId: "ack-1" },
        { title: "Hotels", state: "doing", chatId: CONCIERGE_CHAT, sourceMessageId: "ack-1" },
      ]);
      const turn = (prompt: string, taskIds?: string[]) =>
        s.service.resolveTurn({
          agentName: CONCIERGE_AGENT_ID,
          sessionId: "runtime-1",
          channel: "webchat",
          threadId: CONCIERGE_CHAT,
          prompt,
          ...(taskIds ? { taskIds } : {}),
        });
      // A task event's batch of one, whatever its text names.
      const resolved = await turn(
        `<task_events>\n<task id="${row!.id}" title="Flights">\nguardian: see task:${other!.id}\n</task>\n</task_events>`,
        [row!.id],
      );
      expect(resolved.reportedTask).toBe(row!.id);
      // A defer wake-up names its task in Rome's header, not in its note.
      const woken = await turn(
        `⏰ Time's up\n<defer_note scheduled_at="2026-11-12T09:00:00.000Z" task_id="${row!.id}">\nCompare with task:${other!.id} and task_id="${other!.id}"\n</defer_note>`,
      );
      expect(woken.reportedTask).toBe(row!.id);
      // A check that came due labels its replies with its name.
      expect(woken).toMatchObject({
        inputSource: { type: "check", name: null },
        inputLabel: "Check",
      });
      const named = await turn(
        `⏰ Time's up: Tell the time\n<defer_note scheduled_at="2026-11-12T09:00:00.000Z">\nSay the time.\n</defer_note>`,
      );
      expect(named).toMatchObject({
        inputSource: { type: "check", name: "Tell the time" },
        inputLabel: "Check · Tell the time",
      });
      // A turn that is no wake-up carries no source.
      expect(resolved).not.toHaveProperty("inputSource");
      // Text alone names no task.
      expect((await turn(`⏰ Time's up: check task:${row!.id}`)).reportedTask).toBeUndefined();
      // A batch about two tasks answers neither, so an unnamed say replies to none of them.
      const batch = await turn("<task_events>…</task_events>", [row!.id, other!.id]);
      expect(batch.reportedTask).toBeUndefined();
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
      { type: "task_chat", chatId: "task-1", title: "Flights", show: "task" },
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
      { type: "task_chat", chatId: "task-1", title: "Flights", show: "task" },
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
      content: JSON.stringify([{ type: "text", content: concluded("# Report") }]),
    });
    await s.tool("chat_send", { chatId: "task-1", text: "Trains too" });
    const result = await s.tool("chat_forward", { chatId: "task-1" });
    expect(JSON.parse(result.content[0].text)).toEqual({
      forwarded: "conclusion",
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

  it("chat_stop stops each of the task chat's turns, and its task", async () => {
    const s = setup();
    const { taskId } = JSON.parse(
      (await s.tool("chat_start", { title: "Flights", brief: "Find flights" })).content[0].text,
    );
    s.chats.activeTurns = () => ["t1", "t2"];
    const result = await s.tool("chat_stop", { chatId: "task-1" });
    expect(JSON.parse(result.content[0].text)).toEqual({ stopped: 2 });
    expect(s.chats.interruptTurn).toHaveBeenCalledWith("t1");
    expect(s.chats.interruptTurn).toHaveBeenCalledWith("t2");
    expect(await s.taskRepo.get(taskId)).toMatchObject({
      stoppedAt: expect.any(Date),
      stopReason: "concierge",
    });
  });

  it("a stop, an archive or a delete turns down the task chat's approvals, and runs no turn on", async () => {
    const s = setup();
    const turnedDown: [string, number, boolean][] = [];
    s.service.attachApprovalExpiry(async (chatId, turnDown) => {
      turnedDown.push([chatId, turnDown.until, turnDown.continueTurn]);
      return 1;
    });
    const first = JSON.parse(
      (await s.tool("chat_start", { title: "Flights", brief: "Find" })).content[0].text,
    );
    await s.service.stopTask(first.taskId, "guardian");
    const second = JSON.parse(
      (await s.tool("chat_start", { title: "Hotels", brief: "Find hotels" })).content[0].text,
    );
    await s.service.endTaskChat(second.chatId, "archived");
    // Only approvals that began by the stop.
    expect(turnedDown).toEqual([
      [first.chatId, expect.any(Number), false],
      [second.chatId, expect.any(Number), false],
    ]);
    expect(turnedDown.every(([, until]) => Number.isFinite(until))).toBe(true);
  });

  it("turns down an approval the stopped task's turn asked for while it was being stopped", async () => {
    const s = setup();
    const { chatId, taskId } = JSON.parse(
      (await s.tool("chat_start", { title: "Flights", brief: "Find" })).content[0].text,
    );
    s.chats.activeTurns = (id: string) => (id === chatId ? ["t1"] : []);
    let askedAt = 0;
    s.chats.interruptTurn = async () => {
      // The turn asks for an approval just before it stops.
      await new Promise((resolve) => setTimeout(resolve, 5));
      askedAt = Date.now();
    };
    const cutoffs: number[] = [];
    s.service.attachApprovalExpiry(async (_chat, turnDown) => {
      cutoffs.push(turnDown.until);
      return 1;
    });
    await s.service.stopTask(taskId, "guardian");
    expect(cutoffs).toHaveLength(1);
    expect(cutoffs[0]).toBeGreaterThanOrEqual(askedAt);
  });

  it("still turns down a stopped task's approvals when stopping one of its turns throws", async () => {
    const s = setup();
    const { chatId, taskId } = JSON.parse(
      (await s.tool("chat_start", { title: "Flights", brief: "Find" })).content[0].text,
    );
    s.chats.activeTurns = (id: string) => (id === chatId ? ["t1", "t2"] : []);
    const interrupted: string[] = [];
    s.chats.interruptTurn = async (turnId: string) => {
      interrupted.push(turnId);
      // The turn ended on its own meanwhile: the backend answers 409.
      if (turnId === "t1") throw new Error("409 turn not running");
    };
    const turnedDown: string[] = [];
    s.service.attachApprovalExpiry(async (chat) => (turnedDown.push(chat), 1));
    expect(await s.service.stopTask(taskId, "guardian")).toBe(2);
    expect(interrupted).toEqual(["t1", "t2"]);
    expect(turnedDown).toEqual([chatId]);
  });

  it("turns down an approval a stopped task's work asks for after its interrupt was accepted", async () => {
    const s = setup();
    const stopped = JSON.parse(
      (await s.tool("chat_start", { title: "Flights", brief: "Find" })).content[0].text,
    );
    const open = JSON.parse(
      (await s.tool("chat_start", { title: "Hotels", brief: "Find hotels" })).content[0].text,
    );
    await s.service.stopTask(stopped.taskId, "guardian");
    const turnedDown: [string, string][] = [];
    s.service.attachApprovalExpiry(async (chat, turnDown) => {
      turnedDown.push([chat, turnDown.resolvedBy]);
      return 1;
    });
    await s.settle();
    turnedDown.length = 0;
    const ask = (chatId: string) =>
      s.createApproval({
        status: "pending",
        description: "Send the booking email",
        payload: { channelContext: { threadId: chatId } },
      });
    ask(stopped.chatId);
    ask(open.chatId);
    await s.settle();
    expect(turnedDown).toEqual([[stopped.chatId, RESOLVED_BY_STOP]]);
    // A chat still in use keeps its approvals: one whose row only was
    // archived after its task ended, and one unarchived after its archive
    // stopped the task.
    await s.taskRepo.setLastOutcome(open.taskId, "succeeded", new Date(), { reported: false });
    await s.taskRepo.upsertMany([{ id: open.taskId, archived: true }]);
    const restored = JSON.parse(
      (await s.tool("chat_start", { title: "Cars", brief: "Find a car" })).content[0].text,
    );
    s.chats.activeTurns = (id: string) => (id === restored.chatId ? ["t1"] : []);
    await s.service.endTaskChat(restored.chatId, "archived");
    s.chats.activeTurns = () => [];
    turnedDown.length = 0;
    // Still archived: its approvals are the stopped work's.
    ask(restored.chatId);
    await s.settle();
    expect(turnedDown).toEqual([[restored.chatId, RESOLVED_BY_STOP]]);
    await s.service.restoreTaskChat(restored.chatId);
    turnedDown.length = 0;
    ask(open.chatId);
    ask(restored.chatId);
    await s.settle();
    expect(turnedDown).toEqual([]);
  });

  it("drops a stop's turn-down retry once the task is taken up again", async () => {
    const s = setup();
    s.fakeTimers();
    let calls = 0;
    s.service.attachApprovalExpiry(async () => {
      calls += 1;
      if (calls === 1) throw new Error("database is locked");
      return 1;
    });
    const { chatId, taskId } = JSON.parse(
      (await s.tool("chat_start", { title: "Flights", brief: "Find" })).content[0].text,
    );
    await s.service.stopTask(taskId, "guardian");
    expect(calls).toBe(1);
    // The owner types in the task chat before the retry: its new work's approvals are its own.
    await s.service.resumeTaskChat(chatId);
    await rs.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(1);
  });

  it("turns down at start what a stopped task's chat still has pending", async () => {
    const s = setup();
    const { chatId, taskId } = JSON.parse(
      (await s.tool("chat_start", { title: "Flights", brief: "Find" })).content[0].text,
    );
    // Stopped before the approval handling was up, as across a crash.
    await s.service.stopTask(taskId, "guardian");
    const turnedDown: [string, string][] = [];
    s.service.attachApprovalExpiry(async (chat, turnDown) => {
      turnedDown.push([chat, turnDown.resolvedBy]);
      return 1;
    });
    await s.settle();
    expect(turnedDown).toEqual([[chatId, RESOLVED_BY_STOP]]);
  });

  it("lets a failed turn-down reach the expiry, and a stop go ahead anyway", async () => {
    const s = setup();
    s.service.attachApprovalExpiry(async () => {
      throw new Error("database is locked");
    });
    await expect(
      s.service.expireApprovals("task-1", {
        until: 0,
        reason: "No response",
        resolvedBy: RESOLVED_BY_EXPIRY,
        continueTurn: true,
      }),
    ).rejects.toThrow("database is locked");
    const { taskId } = JSON.parse(
      (await s.tool("chat_start", { title: "Flights", brief: "Find" })).content[0].text,
    );
    await s.service.stopTask(taskId, "guardian");
    expect((await s.taskRepo.get(taskId))?.stoppedAt).toEqual(expect.any(Date));
  });

  it("tells the Concierge quietly when the owner cancels a task's checks, and lets a failure through", async () => {
    const s = setup();
    const [row] = await s.taskRepo.upsertMany([{ title: "PR 42", chatId: CONCIERGE_CHAT }]);
    const pending = () =>
      (s.service as unknown as { taskEvents: { pending: string[] } }).taskEvents.pending;
    s.deps.checks = {
      cancelFor: async () => {
        throw new Error("database is locked");
      },
      laterOf: async () => new Map(),
    } as never;
    await expect(s.service.cancelChecksByOwner(row!.id)).rejects.toThrow("database is locked");
    expect(pending()).not.toContain(row!.id);
    s.deps.checks = { cancelFor: async () => 1, laterOf: async () => new Map() } as never;
    await s.service.cancelChecksByOwner(row!.id);
    expect(pending()).toContain(row!.id);
  });

  it("tells the Concierge quietly when the owner cancels a task's check from the chat's checks", async () => {
    const s = setup();
    const [row] = await s.taskRepo.upsertMany([{ title: "PR 42", chatId: CONCIERGE_CHAT }]);
    const pending = () =>
      (s.service as unknown as { taskEvents: { pending: string[] } }).taskEvents.pending;
    s.deps.checks = {
      inChat: async () => [{ id: "r-1", name: "CI", at: 5, waitingFor: null, taskId: row!.id }],
      cancel: async (_chat: string, id: string) => id === "r-1",
      laterOf: async () => new Map(),
    } as never;
    expect(await s.service.cancelCheckByOwner(CONCIERGE_CHAT, "r-9")).toBe(false);
    expect(pending()).not.toContain(row!.id);
    expect(await s.service.cancelCheckByOwner(CONCIERGE_CHAT, "r-1")).toBe(true);
    expect(pending()).toContain(row!.id);
  });

  it("archiving a task that is still open stops it, and leaves an ended one's outcome alone", async () => {
    const s = setup();
    const { taskId } = JSON.parse(
      (await s.tool("chat_start", { title: "Flights", brief: "Find" })).content[0].text,
    );
    s.chats.activeTurns = () => ["t1"];
    await s.tool("task_upsert", { tasks: [{ id: taskId, archived: true }] });
    expect(await s.taskRepo.get(taskId)).toMatchObject({
      stopReason: "concierge",
      archivedAt: expect.any(Date),
    });
    s.chats.activeTurns = () => [];
    const [done] = await s.taskRepo.upsertMany([{ title: "Done" }]);
    await s.taskRepo.setLastOutcome(done!.id, "succeeded", new Date(), { reported: false });
    await s.tool("task_upsert", { tasks: [{ id: done!.id, archived: true }] });
    expect((await s.taskRepo.get(done!.id))?.stoppedAt).toBeNull();
  });

  it("archiving a task chat that waits on an approval stops its task, though the approval is turned down first", async () => {
    const s = setup();
    const { chatId, taskId } = JSON.parse(
      (await s.tool("chat_start", { title: "Flights", brief: "Find" })).content[0].text,
    );
    await s.taskRepo.setLastOutcome(taskId, "succeeded", new Date(), { reported: false });
    const waiting = new Map([[chatId, Date.now()]]);
    s.tasks.attachFacts({
      now: () => Date.now(),
      running: () => false,
      openWaits: async (ids) =>
        approvalWaits(new Map([...waiting].filter(([id]) => ids.includes(id)))),
      reportPending: () => [],
    });
    s.service.attachApprovalExpiry(async (chat) => {
      // Turned down: the chat waits on nothing any more.
      waiting.delete(chat);
      return 1;
    });
    await s.service.endTaskChat(chatId, "archived");
    expect(await s.taskRepo.get(taskId)).toMatchObject({ stopReason: "archived" });
  });

  it("archiving or deleting a task chat stops only an open task, and a finished one stays done", async () => {
    const s = setup();
    const open = JSON.parse(
      (await s.tool("chat_start", { title: "Flights", brief: "Find" })).content[0].text,
    );
    const done = JSON.parse(
      (await s.tool("chat_start", { title: "Hotels", brief: "Find hotels" })).content[0].text,
    );
    await s.taskRepo.setLastOutcome(done.taskId, "succeeded", new Date(), { reported: false });
    s.chats.activeTurns = (chatId: string) => (chatId === open.chatId ? ["t1"] : []);
    await s.service.endTaskChat(open.chatId, "archived");
    await s.service.endTaskChat(done.chatId, "deleted");
    expect(await s.taskRepo.get(open.taskId)).toMatchObject({ stopReason: "archived" });
    expect(await s.taskRepo.get(done.taskId)).toMatchObject({
      stoppedAt: null,
      archivedAt: expect.any(Date),
    });
    const row = await s.taskRepo.get(done.taskId);
    expect((await s.tasks.statusOf([row!])).get(done.taskId)).toMatchObject({
      status: "ended",
      endReason: "done",
    });
  });

  it("takes a stopped task up again when its owner types in its chat, or the Concierge starts its row", async () => {
    const s = setup();
    const { chatId, taskId } = JSON.parse(
      (await s.tool("chat_start", { title: "Flights", brief: "Find" })).content[0].text,
    );
    await s.service.stopTask(taskId, "concierge");
    await s.service.resumeTaskChat(chatId);
    expect((await s.taskRepo.get(taskId))?.stoppedAt).toBeNull();

    const [planned] = await s.taskRepo.upsertMany([{ title: "Later" }]);
    await s.taskRepo.stop(planned!.id, "guardian");
    await s.tool("chat_start", { title: "Later", brief: "Go", taskId: planned!.id });
    expect((await s.taskRepo.get(planned!.id))?.stoppedAt).toBeNull();
  });

  it("chat_start that cannot send its brief leaves no chat, a failed row, and no second task on retry", async () => {
    const s = setup();
    const error = "The chat cannot take a message";
    s.refuseSends({ ok: false, error, delivery: { state: "failed", error, at: new Date(0) } });
    const result = await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("is marked failed");
    expect(await s.storedChats.getSession("task-1")).toBeNull();
    const [row] = await s.tasks.repo.listForAgent(true);
    expect(row.row).toMatchObject({
      title: "Flights",
      sessionId: null,
      lastOutcome: "failed",
      state: "dropped",
    });

    const retry = await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    expect(retry.isError).toBe(true);
    expect(retry.content[0].text).toContain(`Task ${row.row.id} already failed to start`);
    // A retry that renames the task is the same start.
    const renamed = await s.tool("chat_start", { title: "Flight search", brief: "Find flights" });
    expect(renamed.content[0].text).toContain(`Task ${row.row.id} already failed to start`);
    expect(s.chats.startChat).toHaveBeenCalledTimes(1);
    expect(await s.tasks.repo.listForAgent(true)).toHaveLength(1);
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
        from: CONCIERGE_CHAT,
        status: "idle",
      },
      {
        chatId: "task-2",
        title: "Agenda",
        kind: "task chat",
        from: TOPIC_CHAT,
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

  it("chat_list leaves out an ended task's chat unless asked", async () => {
    const s = setup();
    const { taskId } = JSON.parse(
      (await s.tool("chat_start", { title: "Flights", brief: "Find flights" })).content[0].text,
    );
    await s.tool("chat_start", { title: "Hotels", brief: "Find hotels" });
    await s.tool("task_upsert", { tasks: [{ id: taskId, stop: true }] });
    const titles = async (input: Record<string, unknown>) =>
      JSON.parse((await s.tool("chat_list", input)).content[0].text).map(
        (chat: { title: string }) => chat.title,
      );
    expect(await titles({})).toEqual(["Calendar", "Hotels"]);
    expect(await titles({ includeEnded: true })).toEqual(["Calendar", "Flights", "Hotels"]);
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
      [{ type: "task_chat", chatId: "task-1", title: "Flights", show: "task" }],
    ]);
  });

  it("chat_card shows a task waiting on the guardian as its question or approval alone", async () => {
    const s = setup();
    await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    s.tasks.attachFacts({
      now: () => Date.now(),
      running: () => false,
      openWaits: async (ids) => approvalWaits(new Map(ids.map((id) => [id, Date.now() - 60_000]))),
      reportPending: () => [],
    });
    await s.tool("chat_card", { chatId: "task-1" });
    // Once it waits on nobody, the card to find it by is its task card again.
    s.tasks.attachFacts({
      now: () => Date.now(),
      running: () => false,
      openWaits: async () => new Map(),
      reportPending: () => [],
    });
    await s.tool("chat_card", { chatId: "task-1" });
    expect(s.messages.get(CONCIERGE_CHAT)?.map((row) => JSON.parse(row.content))).toEqual([
      // The ask card keeps what the task waited on, so it shows that item
      // even once a newer one is asked and settled.
      [
        {
          type: "task_chat",
          chatId: "task-1",
          title: "Flights",
          show: "ask",
          waitedOn: { kind: "approval", id: "approval-task-1" },
        },
      ],
      [{ type: "task_chat", chatId: "task-1", title: "Flights", show: "task" }],
    ]);
  });

  it("chat_card shows a task whose wait ran out as its task card, since its question takes no answer", async () => {
    const s = setup();
    await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    s.tasks.attachFacts({
      now: () => Date.now(),
      running: () => false,
      openWaits: async (ids) =>
        approvalWaits(new Map(ids.map((id) => [id, Date.now() - 2 * 24 * 60 * 60 * 1000]))),
      reportPending: () => [],
    });
    await s.tool("chat_card", { chatId: "task-1" });
    expect(s.messages.get(CONCIERGE_CHAT)?.map((row) => JSON.parse(row.content))).toEqual([
      [{ type: "task_chat", chatId: "task-1", title: "Flights", show: "task" }],
    ]);
  });

  it("chat_forward stores the task chat it came from, and the intro in the same message", async () => {
    const s = setup();
    await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    s.messages.get("task-1")?.push({
      role: "assistant",
      content: JSON.stringify([{ type: "text", content: concluded("# Report\n\nThree options.") }]),
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
      content: JSON.stringify([{ type: "text", content: concluded("Three options.") }]),
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

  describe("chat_forward passes on a task's conclusion", () => {
    const DETAILS = "A long table of fares that must stay in the task chat.";
    const text = (result: { content: Array<{ text: string }> }) =>
      JSON.parse(result.content[0].text);
    /** A started task chat whose latest answer is `answer`. */
    const withAnswer = async (answer: string) => {
      const s = setup();
      await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
      s.messages.get("task-1")?.push({
        role: "assistant",
        content: JSON.stringify([{ type: "text", content: answer }]),
      });
      return s;
    };
    const stored = (s: Awaited<ReturnType<typeof withAnswer>>) =>
      (s.messages.get(CONCIERGE_CHAT) ?? []).map((row) => JSON.parse(row.content));
    /** The guardian sent a message in the running turn. */
    const guardianAsked = (s: Awaited<ReturnType<typeof withAnswer>>) => {
      const list = s.messages.get(CONCIERGE_CHAT) ?? [];
      list.push({
        id: "g-ask",
        role: "user",
        content: JSON.stringify([{ type: "text", content: "show me the full report" }]),
        turnId: "concierge-turn-1",
      });
      s.messages.set(CONCIERGE_CHAT, list);
    };

    it("forwards only the conclusion, word for word, with its source chat and no marker", async () => {
      const s = await withAnswer(concluded("Found 3 flights. Which one?", DETAILS));
      const result = text(await s.tool("chat_forward", { chatId: "task-1" }));
      expect(result).toMatchObject({
        forwarded: "conclusion",
        forwardedChars: "Found 3 flights. Which one?".length,
      });
      const forwarded = stored(s).at(-1);
      expect(forwarded).toEqual([
        {
          type: "text",
          content: "Found 3 flights. Which one?",
          format: "long",
          forwardedFrom: { chatId: "task-1", title: "Flights" },
        },
      ]);
      expect(JSON.stringify(stored(s))).not.toContain("rome:conclusion");
      expect(JSON.stringify(stored(s))).not.toContain("long table of fares");
    });

    it("anchors the task's row to the forwarded message, so it can be needs_user", async () => {
      const s = await withAnswer(concluded("Which one?", DETAILS));
      const result = text(await s.tool("chat_forward", { chatId: "task-1" }));
      expect(
        await s.taskRepo.getWithChat(result.taskAnchored)?.then((row) => row?.sourceMessageId),
      ).toBe(result.messageId);
    });

    it("refuses an answer with no conclusion, sends nothing, and says what to do instead", async () => {
      const s = await withAnswer(DETAILS);
      const result = await s.tool("chat_forward", { chatId: "task-1", intro: "Done" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("no conclusion section");
      expect(result.content[0].text).toContain("Nothing was sent");
      expect(result.content[0].text).toContain("a few sentences with the key specifics");
      expect(result.content[0].text).not.toContain("open the task chat");
      expect(stored(s)).toEqual([]);
    });

    it("refuses a conclusion with nothing to report, and sends nothing", async () => {
      const s = await withAnswer(concluded(NOTHING_TO_REPORT, DETAILS));
      const result = await s.tool("chat_forward", { chatId: "task-1" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Send nothing about it");
      expect(stored(s)).toEqual([]);
    });

    it("refuses a conclusion over the cap and sends nothing", async () => {
      const s = await withAnswer(concluded("x".repeat(CONCLUSION_MAX_CHARS + 1), DETAILS));
      const result = await s.tool("chat_forward", { chatId: "task-1" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(`over the ${CONCLUSION_MAX_CHARS} limit`);
      expect(stored(s)).toEqual([]);
    });

    it("refuses the full text in a turn the guardian did not start, so a report turn never pastes a report", async () => {
      const s = await withAnswer(concluded("Done.", DETAILS));
      const result = await s.tool("chat_forward", { chatId: "task-1", full: true });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("only in a turn they started");
      expect(stored(s)).toEqual([]);
    });

    it("sends the whole answer, without markers, when the guardian asked for it this turn", async () => {
      const s = await withAnswer(concluded("Done.", DETAILS));
      guardianAsked(s);
      const result = text(await s.tool("chat_forward", { chatId: "task-1", full: true }));
      expect(result.forwarded).toBe("full");
      const body = stored(s).at(-1)[0].content as string;
      expect(body).toContain(DETAILS);
      expect(body).toContain("Done.");
      expect(body).not.toContain("rome:conclusion");
    });

    it("sends the whole answer byte for byte but for the markers, code block blank lines included", async () => {
      const code = "```py\nx = 1\n\n\n\ny = 2\n```";
      const answer = `Intro.\n\n\n\n${code}\n\n${CONCLUSION_OPEN}\nDone.\n${CONCLUSION_CLOSE}\n`;
      const s = await withAnswer(answer);
      guardianAsked(s);
      await s.tool("chat_forward", { chatId: "task-1", full: true });
      expect(stored(s).at(-1)[0].content).toBe(`Intro.\n\n\n\n${code}\n\nDone.\n`);
    });

    it("sends the whole answer even when it has no conclusion, in a guardian's turn", async () => {
      const s = await withAnswer(DETAILS);
      guardianAsked(s);
      const result = text(await s.tool("chat_forward", { chatId: "task-1", full: true }));
      expect(result).toMatchObject({ forwarded: "full", forwardedChars: DETAILS.length });
    });

    it("describes itself as conclusion-first, with an explicit full flag", async () => {
      const s = setup();
      const tools = await buildConciergeTools(s.service, s.context());
      const forward = tools.find((candidate) => candidate.name === "chat_forward")!;
      expect(forward.description).toContain("conclusion");
      expect(forward.description).toContain(`${CONCLUSION_MAX_CHARS} characters`);
      expect(forward.description).toContain("explicitly asks for the full text");
      expect(forward.description).not.toContain("long content the guardian asked for");
      expect(forward.inputSchema).toHaveProperty("properties.full");
      const start = tools.find((candidate) => candidate.name === "chat_start")!;
      expect(JSON.stringify(start.inputSchema)).toContain("written in the guardian's language");
    });
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

  it("chat_start without a taskId puts a row for its chat on the list and answers its id", async () => {
    const s = setup();
    const result = text(await s.tool("chat_start", { title: "Flights", brief: "Find flights" }));
    expect(await s.taskRepo.get(result.taskId)).toMatchObject({
      title: "Flights",
      sessionId: "task-1",
      linkedAt: expect.any(Date),
    });
    expect((await s.taskRepo.findBySession("task-1"))?.id).toBe(result.taskId);
  });

  it("chat_start with a taskId links the planned row", async () => {
    const s = setup();
    const [planned] = await s.taskRepo.upsertMany([{ title: "Book flights" }]);
    const result = text(
      await s.tool("chat_start", { title: "Flights", brief: "Find flights", taskId: planned.id }),
    );
    expect(result).toEqual({ chatId: "task-1", taskId: planned.id });
    expect(await s.taskRepo.get(planned.id)).toMatchObject({
      title: "Book flights",
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
      sourceMessageId: null,
    });
    // A second send does not add a second row.
    await s.tool("chat_send", { chatId: "legacy", text: "Again" });
    expect(await s.taskRepo.listForAgent(true)).toHaveLength(1);
  });

  it.each([
    "concierge",
    "guardian",
  ] as const)("chat_send takes up a task stopped by the %s again: it is active once more", async (by) => {
    const s = setup();
    const { taskId } = text(await s.tool("chat_start", { title: "Flights", brief: "Find" }));
    await s.service.stopTask(taskId, by);
    expect((await s.taskRepo.get(taskId))?.stopReason).toBe(by);
    await s.tool("chat_send", { chatId: "task-1", text: "Look again" });
    expect(await s.taskRepo.get(taskId)).toMatchObject({ stoppedAt: null, stopReason: null });
    const [row] = await s.tasks.listForPanel();
    expect(row).toMatchObject({ id: taskId, status: "active" });
  });

  it("task_upsert creates and updates rows in one batch, and answers each row's id and status", async () => {
    const s = setup();
    const created = text(
      await s.tool("task_upsert", {
        tasks: [
          { title: "Renew passport", note: "Form at gov.example/renew" },
          { title: "Pay rent" },
        ],
      }),
    );
    expect(created.tasks.map((task: { title: string }) => task.title)).toEqual([
      "Renew passport",
      "Pay rent",
    ]);
    const [passport] = created.tasks;
    const updated = text(
      await s.tool("task_upsert", {
        tasks: [{ id: passport.id, summary: "Sent", note: null }],
      }),
    );
    // A row with no task chat yet is later until the Concierge starts or stops it.
    expect(updated.tasks).toEqual([expect.objectContaining({ id: passport.id, status: "later" })]);
    expect(await s.taskRepo.get(passport.id)).toMatchObject({ summary: "Sent", note: null });
  });

  it("task_upsert refuses the fields Rome now keeps, and writes nothing on a bad batch", async () => {
    const s = setup();
    const bad = async (entry: Record<string, unknown>, message: string) => {
      const result = await s.tool("task_upsert", { tasks: [{ title: "Fine" }, entry] });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(message);
    };
    for (const field of ["state", "waitingOn", "dueAt", "rank", "chatId"]) {
      await bad({ title: "x", [field]: "anything" }, `${field} is no longer written`);
    }
    await bad({ summary: "x" }, "title is required to create a row");
    await bad({ id: "nope", summary: "x" }, "No task nope");
    await bad({ title: "x", stop: true }, "stop needs the id");
    expect((await s.tool("task_upsert", { tasks: [] })).isError).toBe(true);
    expect(await s.taskRepo.listForAgent(true)).toEqual([]);
  });

  it("task_upsert stops a task and its chat's running work", async () => {
    const s = setup();
    const { taskId } = text(await s.tool("chat_start", { title: "Flights", brief: "Find" }));
    s.chats.activeTurns = () => ["t1"];
    const result = text(await s.tool("task_upsert", { tasks: [{ id: taskId, stop: true }] }));
    expect(result.tasks).toEqual([expect.objectContaining({ id: taskId, status: "ended" })]);
    expect(s.chats.interruptTurn).toHaveBeenCalledWith("t1");
    expect((await s.taskRepo.get(taskId))?.stopReason).toBe("concierge");
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

  it("task_list lists a task whose check waits on an event with no deadline, with no time", async () => {
    const s = setup({ startEvents: false });
    const [row] = await s.taskRepo.upsertMany([{ title: "CI run", chatId: CONCIERGE_CHAT }]);
    s.tasks.attachFacts({
      now: () => Date.now(),
      running: () => false,
      openWaits: async () => new Map(),
      reportPending: () => [],
      laterOf: async () => new Map([[row!.id, Number.POSITIVE_INFINITY]]),
    });
    const listed = text(await s.tool("task_list", {})).tasks;
    expect(listed).toEqual([expect.objectContaining({ id: row!.id, status: "later" })]);
    expect(listed[0]).not.toHaveProperty("laterAt");
    const [dto] = await s.tasks.toDtos([(await s.taskRepo.getWithChat(row!.id))!]);
    expect(dto?.laterAt).toBeNull();
  });

  it("task_list answers compact rows with their status, and the ended ones on request", async () => {
    const s = setup();
    const { taskId } = text(await s.tool("chat_start", { title: "Flights", brief: "Find" }));
    await s.tool("task_upsert", { tasks: [{ id: taskId, note: "Fly Friday" }] });
    const finished = text(await s.tool("task_upsert", { tasks: [{ title: "Finished" }] })).tasks[0];
    await s.taskRepo.setLastOutcome(finished.id, "succeeded", new Date(), { reported: false });
    s.chats.activeTurns = () => ["t1"];
    const open = text(await s.tool("task_list", {}));
    expect(open.tasks).toEqual([
      { id: taskId, title: "Flights", status: "active", chatId: "task-1" },
    ]);
    const detailed = text(await s.tool("task_list", { details: true })).tasks;
    expect(detailed).toEqual([
      {
        id: taskId,
        title: "Flights",
        status: "active",
        chatId: "task-1",
        note: "Fly Friday",
        updatedAt: expect.any(String),
      },
    ]);
    const all = text(await s.tool("task_list", { includeDone: true })).tasks;
    expect(all).toHaveLength(2);
    expect(all.find((task: { title: string }) => task.title === "Finished")).toMatchObject({
      status: "ended",
      endReason: "done",
    });
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
    const said = text(await s.tool("say", { text: "Looking for flights" }));
    expect(said).toEqual({ sent: expect.any(String), messageId: "said-1" });
    await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    s.messages.get("task-1")?.push({
      role: "assistant",
      content: JSON.stringify([{ type: "text", content: concluded("3 options") }]),
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
  ] as const)("anchors a task created in %s to its result forwarded in %s before completion", async (createdIn, forwardedIn) => {
    const s = setup({ said: false });
    await s.storedChats.createSession(CONCIERGE_CHAT, "Concierge");
    await s.storedChats.createSession(TOPIC_CHAT, "Calendar");
    s.turnIn(createdIn);
    // The owner's message started it, so the task has a starter in that chat.
    s.messages.set(createdIn, [
      { id: "g0", role: "user", content: "[]", turnId: "concierge-turn-1" },
    ]);
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
      content: JSON.stringify([{ type: "text", content: concluded("3 options") }]),
    });

    s.turnIn(forwardedIn);
    const result = await s.tool("chat_forward", { chatId });
    expect(result.isError).toBeFalsy();
    const forwarded = text(result);
    expect(s.messages.get(forwardedIn)?.at(-1)?.id).toBe(forwarded.messageId);
    expect(await anchorOf(s, taskId)).toBe(forwarded.messageId);
    expect(forwarded).toEqual({
      forwarded: "conclusion",
      forwardedChars: 9,
      messageId: "said-2",
      taskAnchored: taskId,
    });
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

    const completed = text(
      await s.tool("task_upsert", { tasks: [{ id: taskId, summary: "3 options" }] }),
    );
    expect(completed.tasks[0]).toMatchObject({ anchor: forwarded.messageId, anchorKept: true });
    expect(await anchorOf(s, taskId)).toBe(forwarded.messageId);
    expect((await s.tasks.listForPanel())[0]).toMatchObject({
      summary: "3 options",
      conciergeChat: expect.objectContaining({ id: forwardedIn }),
      sourceMessageId: forwarded.messageId,
      notSynced: false,
    });
  });

  describe("a task chat another Concierge chat started", () => {
    // The main chat starts "Flights" on the guardian's message g0.
    const startInMain = async () => {
      const s = setup({ said: false });
      await s.storedChats.createSession(TOPIC_CHAT, "Calendar");
      s.messages.set(CONCIERGE_CHAT, [
        { id: "g0", role: "user", content: "[]", turnId: "concierge-turn-1" },
      ]);
      await s.tool("say", { text: "On it" });
      const started = text(await s.tool("chat_start", { title: "Flights", brief: "Find flights" }));
      s.messages.set(started.chatId, [
        { role: "assistant", content: JSON.stringify([{ type: "text", content: "3 options" }]) },
      ]);
      const row = await s.taskRepo.get(started.taskId);
      s.messages.set(TOPIC_CHAT, [{ id: "t0", role: "user", content: "[]", turnId: "ask" }]);
      s.turnIn(TOPIC_CHAT);
      s.inTurn("ask");
      return { s, ...(started as { chatId: string; taskId: string }), row };
    };

    it("refuses chat_send from a topic chat, and nothing reaches the task", async () => {
      const { s, chatId, taskId, row } = await startInMain();
      const sent = s.posted.length;
      const messagesHere = s.messages.get(TOPIC_CHAT)?.length;

      const result = await s.tool("chat_send", { chatId, text: "Make it Saturday" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("belongs to another Concierge chat");
      expect(result.content[0].text).toContain("chat_start");
      expect(s.posted).toHaveLength(sent);
      expect(s.messages.get(TOPIC_CHAT)).toHaveLength(messagesHere ?? 0);
      expect(await s.taskRepo.get(taskId)).toEqual(row);
    });

    it("refuses chat_forward from a topic chat, and nothing is posted or moved", async () => {
      const { s, chatId, taskId, row } = await startInMain();
      const messagesHere = s.messages.get(TOPIC_CHAT)?.length;

      const result = await s.tool("chat_forward", { chatId });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("belongs to another Concierge chat");
      expect(s.messages.get(TOPIC_CHAT)).toHaveLength(messagesHere ?? 0);
      expect(await s.taskRepo.get(taskId)).toEqual(row);
    });

    it("shows a card for it from a topic chat without moving the row", async () => {
      const { s, chatId, taskId, row } = await startInMain();
      const cardsBefore = s.messages.get(TOPIC_CHAT)?.length ?? 0;

      const result = await s.tool("chat_card", { chatId });

      expect(result.isError).toBeFalsy();
      expect(text(result)).toEqual({
        sent: "Shown; the guardian sees the card.",
        messageId: expect.any(String),
      });
      expect(s.messages.get(TOPIC_CHAT)).toHaveLength(cardsBefore + 1);
      expect(await s.taskRepo.get(taskId)).toEqual(row);

      // The main chat still owns it.
      s.turnIn(CONCIERGE_CHAT);
      s.inTurn("concierge-turn-1");
      const sent = s.posted.length;
      expect((await s.tool("chat_send", { chatId, text: "Make it Saturday" })).isError).toBeFalsy();
      expect(s.posted).toHaveLength(sent + 1);
    });

    it("refuses task_upsert with a messageId on its row from a topic chat, and writes nothing", async () => {
      const { s, taskId, row } = await startInMain();
      const messageId = text(await s.tool("say", { text: "Checking" })).messageId;

      const result = await s.tool("task_upsert", {
        tasks: [
          { title: "Other errand", messageId },
          { id: taskId, summary: "Checking", messageId },
        ],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("belongs to another Concierge chat");
      expect(await s.taskRepo.get(taskId)).toEqual(row);
      expect(await s.taskRepo.listForAgent(true)).toHaveLength(1);
    });

    it("still lets a topic chat update the state or summary of its row without a messageId", async () => {
      const { s, taskId, row } = await startInMain();

      const result = await s.tool("task_upsert", {
        tasks: [{ id: taskId, summary: "Found 3 options" }],
      });

      expect(result.isError).toBeFalsy();
      expect(await s.taskRepo.get(taskId)).toEqual({
        ...row,
        summary: "Found 3 options",
        updatedAt: expect.anything(),
        // Kept as its status reads after the write.
        endedAt: expect.toBeOneOf([null, expect.any(Date)]),
      });
    });

    it.each([
      ["with", true],
      ["without", false],
    ] as const)("refuses chat_start from a topic chat for a planned row of the main chat %s a messageId", async (_label, withMessage) => {
      const { s } = await startInMain();
      const [planned] = await s.taskRepo.upsertMany([
        { title: "Plan trip", state: "next", chatId: CONCIERGE_CHAT },
      ]);
      const before = await s.taskRepo.get(planned!.id);
      const messageId = text(await s.tool("say", { text: "Starting" })).messageId;

      const result = await s.tool("chat_start", {
        title: "Plan trip",
        brief: "Plan it",
        taskId: planned!.id,
        ...(withMessage ? { messageId } : {}),
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("belongs to another Concierge chat");
      // Only the main chat's own task started a chat.
      expect(s.chats.startChat).toHaveBeenCalledTimes(1);
      expect({ ...(await s.taskRepo.get(planned!.id)), endedAt: null }).toEqual({
        ...before,
        endedAt: null,
      });
    });

    it("still lets the topic chat read it", async () => {
      const { s, chatId } = await startInMain();
      expect((await s.tool("chat_read", { chatId })).isError).toBeFalsy();
    });

    it("lets the main chat send to a task its retired topic chat started", async () => {
      const s = setup({ said: false });
      await s.storedChats.createSession(TOPIC_CHAT, "Calendar");
      s.turnIn(TOPIC_CHAT);
      s.messages.set(TOPIC_CHAT, [{ id: "t0", role: "user", content: "[]", turnId: "ask" }]);
      s.inTurn("ask");
      await s.tool("say", { text: "On it" });
      const { chatId, taskId } = text(
        await s.tool("chat_start", { title: "Agenda", brief: "Read the calendar" }),
      );
      await s.storedChats.archiveSession(TOPIC_CHAT);
      await s.service.retireChat(TOPIC_CHAT, "archived");
      const sent = s.posted.length;

      s.turnIn(CONCIERGE_CHAT);
      const result = await s.tool("chat_send", { chatId, text: "Add Friday" });

      expect(result.isError).toBeFalsy();
      expect(s.posted).toHaveLength(sent + 1);
      expect((await s.tasks.listForPanel()).find((row) => row.id === taskId)).toMatchObject({
        conciergeChat: { id: CONCIERGE_CHAT },
      });
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
      content: JSON.stringify([{ type: "text", content: concluded("3 options") }]),
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
        content: JSON.stringify([{ type: "text", content: concluded("3 options") }]),
      },
    ]);
    const result = await s.tool("chat_forward", { chatId });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toEqual({
      forwarded: "conclusion",
      forwardedChars: 9,
      messageId: "said-1",
    });
    expect(await s.taskRepo.findBySession(chatId)).toBeNull();
    expect(await s.taskRepo.listForAgent(true)).toEqual([]);
  });

  it("repeated chat_card re-anchors a row without another task_upsert", async () => {
    const s = setup();
    const { chatId, taskId } = text(
      await s.tool("chat_start", { title: "Flights", brief: "Find flights" }),
    );
    const first = text(await s.tool("chat_card", { chatId })).messageId;
    expect(
      (
        await s.tool("task_upsert", {
          tasks: [{ id: taskId, messageId: first, summary: "Pick a flight" }],
        })
      ).isError,
    ).toBeFalsy();
    expect(await anchorOf(s, taskId)).toBe(first);
    const second = text(await s.tool("chat_card", { chatId })).messageId;
    expect(second).not.toBe(first);
    expect(await anchorOf(s, taskId)).toBe(second);
    expect(await s.taskRepo.get(taskId)).toMatchObject({ summary: "Pick a flight" });
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

  it("anchors a row to chat_card rather than an introductory say", async () => {
    const s = setup();
    await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    await s.tool("say", { text: "The task needs your input." });
    const { messageId } = text(await s.tool("chat_card", { chatId: "task-1" }));
    const task = (await s.taskRepo.findBySession("task-1"))!;
    const result = await s.tool("task_upsert", { tasks: [{ id: task.id, messageId }] });
    expect(result.isError).toBeFalsy();
    expect(await anchorOf(s, task.id)).toBe(messageId);
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
    const id = await created(s, {});
    const asked = text(await s.tool("say", { text: "Which account?" })).messageId;

    await s.tool("task_upsert", { tasks: [{ id, summary: "Waiting" }] });
    expect(await anchorOf(s, id)).toBe(first);

    await s.tool("task_upsert", { tasks: [{ id, messageId: asked }] });
    expect(await anchorOf(s, id)).toBe(asked);

    const bad = await s.tool("task_upsert", { tasks: [{ id, messageId: "no-such-message" }] });
    expect(bad.isError).toBe(true);
    expect(await anchorOf(s, id)).toBe(asked);
  });

  it("takes a valid messageId, which replaces the anchor", async () => {
    const s = setup({ said: false });
    await s.tool("say", { text: "Planning" });
    const id = await created(s, {});
    const asked = text(await s.tool("say", { text: "Which one?" })).messageId;
    const result = text(await s.tool("task_upsert", { tasks: [{ id, messageId: asked }] }));
    expect(await anchorOf(s, id)).toBe(asked);
    expect(result.tasks[0]).toMatchObject({ anchor: asked });
    expect(result.tasks[0]).not.toHaveProperty("anchorKept");

    // A new row takes the id too, whatever the turn said last.
    await s.tool("say", { text: "Something else" });
    const made = await created(s, { title: "Choose", messageId: asked });
    expect(await anchorOf(s, made)).toBe(asked);
  });

  it("refuses a messageId that is not a message of the Concierge chat, and writes nothing", async () => {
    const s = setup({ said: false });
    await s.tool("say", { text: "Planning" });
    const id = await created(s, {});
    const before = await s.taskRepo.get(id);
    s.messages.set("task-1", [
      { id: "foreign-1", role: "assistant", content: "[]", turnId: "concierge-turn-1" },
    ]);
    for (const messageId of ["foreign-1", "no-such-message"]) {
      const result = await s.tool("task_upsert", {
        tasks: [{ id, summary: "Asked", messageId }],
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(`No message ${messageId} in this chat`);
    }
    expect(await s.taskRepo.get(id)).toEqual(before);
  });

  it("leaves an update without a messageId alone: the anchor stays and the result says so", async () => {
    const s = setup({ said: false });
    const first = text(await s.tool("say", { text: "Planning" })).messageId;
    const id = await created(s, {});
    await s.tool("say", { text: "Later" });
    const result = text(await s.tool("task_upsert", { tasks: [{ id, summary: "Waiting" }] }));
    expect(await anchorOf(s, id)).toBe(first);
    expect(result.tasks[0]).toMatchObject({ anchor: first, anchorKept: true });
  });

  it("answers a created row's anchor without the kept flag, and leaves out an anchor a legacy row never had", async () => {
    const s = setup({ said: false });
    await s.tool("say", { text: "Planning" });
    const made = text(await s.tool("task_upsert", { tasks: [{ title: "New" }] }));
    expect(made.tasks[0]).toEqual({
      id: expect.any(String),
      title: "New",
      status: "later",
      anchor: "said-1",
    });
    const [legacy] = await s.taskRepo.upsertMany([{ title: "Old", state: "next" }]);
    const kept = text(await s.tool("task_upsert", { tasks: [{ id: legacy.id, summary: "x" }] }));
    expect(kept.tasks[0]).toEqual({
      id: legacy.id,
      title: "Old",
      status: "later",
      anchorKept: true,
    });
  });

  it("chat_start linking a taskId needs no messageId", async () => {
    const s = setup({ said: false });
    const first = text(await s.tool("say", { text: "Planning" })).messageId;
    const planned = await created(s, {});
    const result = await s.tool("chat_start", { title: "Go", brief: "Do it", taskId: planned });
    expect(result.isError).toBeFalsy();
    expect(await anchorOf(s, planned)).toBe(first);
    expect((await s.taskRepo.get(planned))?.sessionId).toBe("task-1");
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
    const planned = await created(s, {});
    await s.tool("say", { text: "Starting now" });
    await s.tool("chat_start", { title: "Flights", brief: "Find flights", taskId: planned });
    expect(await anchorOf(s, planned)).toBe(first);

    const other = await created(s, { title: "Other" });
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

  it("keeps a finished task's line current: the result's first sentence, until the Concierge writes another", async () => {
    const s = setup();
    const { chatId, taskId } = await startTask(s);
    s.fakeTimers();
    await s.taskRepo.upsertMany([{ id: taskId, summary: "Waiting for the airline" }]);
    await s.finish({
      turnId: "task-turn-1",
      agentName: "core:main",
      chatId,
      text: concluded(
        "Saved [flights.md](/projects/default/flights.md) with three options. Prices change daily.",
      ),
    });
    expect((await s.taskRepo.get(taskId))?.summary).toBe("Saved flights.md with three options.");
    // A summary the Concierge writes after the result wins.
    await s.tool("task_upsert", { tasks: [{ id: taskId, summary: "Booked the 9am" }] });
    expect((await s.taskRepo.get(taskId))?.summary).toBe("Booked the 9am");
  });

  it("takes a result's first sentence in Chinese too, no longer than a summary the Concierge writes", () => {
    expect(resultSummary("我订好了明天的机票。航班号是CA123，早上八点起飞。")).toBe(
      "我订好了明天的机票。",
    );
    expect(resultSummary("Done. Next step.")).toBe("Done.");
    expect(resultSummary(concluded(NOTHING_TO_REPORT, "Wrote notes.md. It has two lines."))).toBe(
      "Wrote notes.md.",
    );
    // A reply with no stop of its own never runs into the no-news line.
    expect(resultSummary(concluded(NOTHING_TO_REPORT, "Saved Tea"))).toBe("Saved Tea");
    const long = resultSummary(`${"word ".repeat(60)}end.`);
    expect(long?.length).toBe(CONCIERGE_TASK_SUMMARY_MAX_LENGTH);
    expect(long?.endsWith("…")).toBe(true);
  });

  it("keeps a failed task's line as it was", async () => {
    const s = setup();
    const { chatId, taskId } = await startTask(s);
    s.fakeTimers();
    await s.taskRepo.upsertMany([{ id: taskId, summary: "Searching flights" }]);
    await s.finish({
      turnId: "task-turn-1",
      agentName: "core:main",
      chatId,
      status: "error",
      text: "Something broke.",
    });
    expect((await s.taskRepo.get(taskId))?.summary).toBe("Searching flights");
  });

  it("holds a result its chat's other work outlives, until the task ends, unless the Concierge writes first", async () => {
    const s = setup();
    const { chatId, taskId } = await startTask(s);
    s.fakeTimers();
    await s.taskRepo.upsertMany([{ id: taskId, summary: "Waiting for approval" }]);
    // An approved action's turn ends inside the stream it runs in, which runs on.
    const stillRunning = (id: string) => (id === chatId ? ["backend:approval"] : []);
    s.chats.activeTurns = stillRunning;
    s.chats.isRunning = (id: string) => stillRunning(id).length > 0;
    await s.finish({
      turnId: "task-turn-2",
      agentName: "core:main",
      chatId,
      text: concluded("Sent the booking email. It went to Eric."),
    });
    expect((await s.taskRepo.get(taskId))?.summary).toBe("Waiting for approval");

    s.chats.activeTurns = () => [];
    s.chats.isRunning = () => false;
    const row = await s.taskRepo.get(taskId);
    await s.tasks.statusOf(row ? [row] : []);
    await s.settle();
    expect((await s.taskRepo.get(taskId))?.summary).toBe("Sent the booking email.");

    // A result held when the Concierge writes the task is dropped.
    s.chats.activeTurns = stillRunning;
    s.chats.isRunning = (id: string) => stillRunning(id).length > 0;
    await s.finish({
      turnId: "task-turn-3",
      agentName: "core:main",
      chatId,
      text: concluded("Sent the follow-up."),
    });
    await s.tool("task_upsert", { tasks: [{ id: taskId, summary: "Eric replied" }] });
    s.chats.activeTurns = () => [];
    s.chats.isRunning = () => false;
    const again = await s.taskRepo.get(taskId);
    await s.tasks.statusOf(again ? [again] : []);
    await s.settle();
    expect((await s.taskRepo.get(taskId))?.summary).toBe("Eric replied");
  });

  /** The guardian answered task chat `chatId`'s card in turn `turnId`. */
  const answeredCard = (s: ReturnType<typeof setup>, chatId: string, turnId: string) =>
    s.messages.get(chatId)?.push({
      id: `answer-${turnId}`,
      role: "user",
      content: JSON.stringify([
        { type: "interaction_result", toolUseId: "ask-1", output: { answers: ["Tea"] } },
      ]),
      turnId,
    });

  it("tells the Concierge nothing of a turn that only carries out the guardian's card answer", async () => {
    const s = setup();
    const { chatId, taskId } = await startTask(s);
    s.fakeTimers();
    answeredCard(s, chatId, "task-turn-2");
    await s.finish({
      turnId: "task-turn-2",
      agentName: "core:main",
      chatId,
      text: concluded(NOTHING_TO_REPORT, "Saved Tea as your afternoon drink."),
    });
    await rs.advanceTimersByTimeAsync(120_000);
    expect(s.backendTurns).toEqual([]);
    // The row's line comes from the reply, not the no-news line.
    expect((await s.taskRepo.get(taskId))?.summary).toBe("Saved Tea as your afternoon drink.");
  });

  it("still reports a turn the Concierge's own brief started, even with nothing to report", async () => {
    const s = setup();
    const { chatId } = await startTask(s);
    s.fakeTimers();
    s.messages.get(chatId)?.push({
      role: "assistant",
      content: JSON.stringify([{ type: "text", content: concluded(NOTHING_TO_REPORT) }]),
    });
    await s.finish({
      turnId: "task-turn-1",
      agentName: "core:main",
      chatId,
      text: concluded(NOTHING_TO_REPORT),
    });
    await rs.advanceTimersByTimeAsync(2_100);
    expect(s.backendTurns).toHaveLength(1);
    expect(s.backendTurns[0].prompt).toContain(`conclusion: ${NOTHING_TO_REPORT}`);
  });

  it("tells the Concierge of a wish for the work to recur, even with nothing else to report", async () => {
    const s = setup();
    const { chatId } = await startTask(s);
    s.fakeTimers();
    const answer = concluded(
      NOTHING_TO_REPORT,
      `Today's quote is above.\n${RECURRING_PREFIX} every day at 10:00`,
    );
    s.messages
      .get(chatId)
      ?.push({ role: "assistant", content: JSON.stringify([{ type: "text", content: answer }]) });
    await s.finish({ turnId: "task-turn-1", agentName: "core:main", chatId, text: answer });
    await rs.advanceTimersByTimeAsync(2_100);
    expect(s.backendTurns).toHaveLength(1);
    expect(s.backendTurns[0].prompt).toContain("recurring: every day at 10:00");
    expect(s.backendTurns[0].prompt).toContain(`conclusion: ${NOTHING_TO_REPORT}`);
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
      `${MAIN_LINE}<task_events>\n<task id="${taskId}" chat_id="task-1" title="Flights" status="ended" end_reason="done" changes="turn_end:completed by=concierge">\nreply: 3 options\n</task>\n</task_events>`,
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

  /** The prompt of the one task event a finished task's answer `text` brings. */
  const eventFor = async (text: string) => {
    const s = setup();
    const { chatId } = await startTask(s, text);
    s.fakeTimers();
    await finishTask(s, chatId);
    await rs.advanceTimersByTimeAsync(2_000);
    rs.useRealTimers();
    return s.backendTurns[0].prompt;
  };

  it("gives the Concierge a task's conclusion whole, and the rest of its answer as the usual excerpt", async () => {
    const question = "Which one should I book?";
    const prompt = await eventFor(concluded(question, "y".repeat(2_000)));
    expect(prompt).toContain(`\nconclusion: ${question}\n`);
    expect(prompt).toContain(`\nreply: ${"y".repeat(400)}${leftOut(1_300)}${"y".repeat(300)}\n`);
    expect(prompt).not.toContain("rome:conclusion");
  });

  it("gives only the conclusion when it is all the answer holds", async () => {
    const prompt = await eventFor(
      `${CONCLUSION_OPEN}\nAll done, nothing to decide.\n${CONCLUSION_CLOSE}`,
    );
    expect(prompt).toContain("\nconclusion: All done, nothing to decide.\n</task>");
    expect(prompt).not.toContain("reply:");
  });

  it("falls back to the excerpt, without markers, for a conclusion over the cap", async () => {
    const prompt = await eventFor(concluded("z".repeat(CONCLUSION_MAX_CHARS + 1), "Details."));
    expect(prompt).not.toContain("conclusion:");
    expect(prompt).not.toContain("rome:conclusion");
    // The excerpt keeps its usual cut, so an over-cap conclusion shows its head.
    expect(prompt).toContain(`reply: Details.\n\n${"z".repeat(300)}`);
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
      `<task id="${taskId}" chat_id="${chatId}" title="Flights" status="ended" end_reason="done" changes="turn_end:completed by=concierge">`,
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

  it("shows a result the guardian's Stop cut off before it was said as never told", async () => {
    const s = setup();
    const { chatId, taskId } = await startTask(s);
    s.fakeTimers();
    s.onBackendTurn(() => "stopped");
    await finishTask(s, chatId);
    await rs.advanceTimersByTimeAsync(2_000);
    await s.settle();
    expect((await s.taskRepo.get(taskId))?.reportGivenUp).toBe(true);
    expect((await s.tasks.listForPanel()).find((row) => row.id === taskId)?.notSynced).toBe(true);
  });

  it("counts a result the report turn said before the guardian's Stop as said, not as never told", async () => {
    const s = setup();
    const { chatId, taskId } = await startTask(s);
    s.fakeTimers();
    s.onBackendTurn(async () => {
      s.inTurn("report");
      await s.tool("say", { text: "Three options found", task: taskId });
      return "stopped" as const;
    });
    await finishTask(s, chatId);
    await rs.advanceTimersByTimeAsync(2_000);
    await s.settle();
    const row = await s.taskRepo.get(taskId);
    expect(row?.reportGivenUp).toBe(false);
    expect(row?.outcomeUnsaid).toBe(false);
    expect(
      (await s.tasks.listForPanel()).find((each) => each.id === taskId)?.notSynced,
    ).toBeFalsy();
  });

  it("still reports a result whose report failed after the Concierge edits the row meanwhile", async () => {
    const s = setup();
    const { chatId, taskId } = await startTask(s);
    s.fakeTimers();
    s.onBackendTurn(() => "failed");
    await finishTask(s, chatId);
    await rs.advanceTimersByTimeAsync(2_000);
    expect(s.backendTurns).toHaveLength(1);
    // In a turn of its own, the Concierge renames the row: it never got the result.
    await s.tool("task_upsert", { tasks: [{ id: taskId, title: "Flights to Rome" }] });
    s.onBackendTurn(() => "completed");
    await rs.advanceTimersByTimeAsync(RETRY_MS + 1_000);
    expect(s.backendTurns).toHaveLength(2);
    expect(s.backendTurns[1].prompt).toContain(`id="${taskId}"`);
  });

  describe("a finished task leaves Active, whatever its report turn does", () => {
    const outcomes = ["completed", "failed", "interrupted"] as const;
    for (const outcome of outcomes) {
      for (const edits of [false, true]) {
        for (const says of [false, true]) {
          it(`report ends ${outcome}${edits ? ", row edited mid-turn" : ""}${says ? ", result said mid-turn" : ""}`, async () => {
            const s = setup();
            const { chatId, taskId } = await startTask(s);
            s.fakeTimers();
            s.onBackendTurn(async () => {
              if (edits) await s.taskRepo.upsertMany([{ id: taskId, note: "Edited" }]);
              if (says) {
                s.inTurn("report");
                await s.tool("say", { text: "Three options found", task: taskId });
              }
              return outcome;
            });
            await finishTask(s, chatId);
            await rs.advanceTimersByTimeAsync(2_000);
            expect(s.backendTurns).toHaveLength(1);
            // Every later report runs to its end.
            s.onBackendTurn(() => "completed");
            await rs.advanceTimersByTimeAsync(2 * RETRY_MS);
            const reports = s.backendTurns.filter((turn) => turn.prompt.includes(`id="${taskId}"`));
            expect(reports.length).toBeGreaterThan(0);
            // A report that ran to its end carried it; none is left owed.
            if (outcome !== "completed") expect(reports.length).toBeGreaterThan(1);
            await s.settle();
            const row = await s.taskRepo.get(taskId);
            expect(row?.outcomeUnsaid).toBe(false);
            expect((await s.tasks.statusOf([row!])).get(taskId)?.status).toBe("ended");
          });
        }
      }
    }
  });

  it("still reports a result whose report turn wrote the row and then failed", async () => {
    const s = setup();
    const { chatId, taskId } = await startTask(s);
    s.fakeTimers();
    // The report turn renames the row, then fails before it says the result.
    s.onBackendTurn(async () => {
      await s.taskRepo.upsertMany([{ id: taskId, title: "Flights to Rome" }]);
      return "failed" as const;
    });
    await finishTask(s, chatId);
    await rs.advanceTimersByTimeAsync(2_000);
    expect(s.backendTurns).toHaveLength(1);
    s.onBackendTurn(() => "completed");
    await rs.advanceTimersByTimeAsync(RETRY_MS + 1_000);
    expect(s.backendTurns).toHaveLength(2);
    expect(s.backendTurns[1].prompt).toContain(`id="${taskId}"`);
    // Once a report ran to its end, the result is said.
    await s.settle();
    expect((await s.taskRepo.get(taskId))?.outcomeUnsaid).toBe(false);
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
    // The guardian's turn that took the report over ends without saying it:
    // the next flush does, not RETRY_MS later.
    s.service.turnSettled(CONCIERGE_CHAT);
    await rs.advanceTimersByTimeAsync(MIN_FLUSH_SPACING_MS);
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

  it("wakes no urgent turn for an approved action that has nothing to report, and tells the decision quietly", async () => {
    const s = setup();
    const { chatId } = await startTask(s);
    s.fakeTimers();
    s.chats.activeTurns = () => [];
    s.resolveApproval({ status: "approved", payload: { channelContext: { threadId: chatId } } });
    s.messages.get(chatId)?.push({
      id: "result",
      role: "user",
      content: JSON.stringify([{ type: "text", content: "Wrote eval-approve.txt." }]),
      turnId: "task-turn-2",
    });
    await s.finish({
      turnId: "task-turn-2",
      agentName: "core:main",
      chatId,
      text: concluded(NOTHING_TO_REPORT, "Wrote eval-approve.txt."),
      startedAt: new Date(Date.now() + 1_000).toISOString(),
    });
    await rs.advanceTimersByTimeAsync(2_000);
    expect(s.backendTurns).toEqual([]);
    await rs.advanceTimersByTimeAsync(60_000);
    expect(s.backendTurns).toHaveLength(1);
    expect(s.backendTurns[0].prompt).toContain('changes="approval_decided"');
    expect(s.quietFlags).toEqual([true]);
  });

  it("reports at once the task turn that carries on from the guardian's answer to its approval", async () => {
    const s = setup();
    const { chatId } = await startTask(s);
    s.fakeTimers();
    // The task's turn ended awaiting the decision.
    s.chats.activeTurns = () => [];
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
    // The decision rides along with the turn that carries on from it.
    expect(s.backendTurns[0].prompt).toContain(
      'changes="approval_decided, turn_end:completed by=concierge"',
    );
    expect(s.backendTurns[0].prompt).toContain("approved by the guardian");

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

  it.each([
    ["rejected", "guardian", "rejected by the guardian"],
    ["approved", "guardian", "approved by the guardian"],
  ])("tells the Concierge an approval was %s after its task's turn ended (%s)", async (status, resolvedBy, said) => {
    const s = setup();
    const { chatId } = await startTask(s);
    s.fakeTimers();
    // The task's turn ended awaiting the decision, and that was reported.
    await finishTask(s, chatId);
    await rs.advanceTimersByTimeAsync(2_000);
    expect(s.backendTurns).toHaveLength(1);
    // The guardian decides on its card; no turn of the task follows.
    s.resolveApproval({
      status,
      resolvedBy,
      description: "Send the invoice",
      payload: { channelContext: { threadId: chatId } },
    });
    await rs.advanceTimersByTimeAsync(60_000);
    expect(s.backendTurns).toHaveLength(2);
    expect(s.backendTurns[1].prompt).toContain(`approval: Send the invoice — ${said}`);
  });

  it.each([
    ["Rome turned it down on the task's Stop", "rome:task-stopped", false],
    ["Rome turned it down when its wait expired", "rome:task-ended", false],
    ["the guardian decided while a task turn ran", "guardian", true],
  ])("tells the Concierge no separate decision when %s", async (_case, resolvedBy, running) => {
    const s = setup();
    const { chatId } = await startTask(s);
    s.fakeTimers();
    await finishTask(s, chatId);
    await rs.advanceTimersByTimeAsync(2_000);
    expect(s.backendTurns).toHaveLength(1);
    if (running) s.chats.activeTurns = (id: string) => (id === chatId ? ["task-turn-2"] : []);
    s.resolveApproval({
      status: "rejected",
      resolvedBy,
      description: "Send the invoice",
      payload: { channelContext: { threadId: chatId } },
    });
    await rs.advanceTimersByTimeAsync(60_000);
    expect(s.backendTurns).toHaveLength(1);
  });

  it("tells the chat showing a task's approval card how it was decided, as it reads now", async () => {
    const s = setup();
    const { chatId } = await startTask(s);
    const asked = {
      id: "approval-1",
      status: "rejected",
      resolvedBy: "guardian",
      description: "Send the invoice",
      payload: { channelContext: { threadId: chatId } },
      since: Date.now(),
    };
    (s.deps.webchatRepo as { taskCardsOf: unknown }).taskCardsOf = async () =>
      new Map([[chatId, { questions: [], approvals: [asked] }]]);
    const events: unknown[] = [];
    s.service.onCardSettled((event) => events.push(event));
    s.resolveApproval({ ...asked });
    await s.settle();
    expect(events).toEqual([
      {
        sessionId: CONCIERGE_CHAT,
        card: expect.objectContaining({
          kind: "approval",
          id: "approval-1",
          outcome: { kind: "rejected" },
        }),
      },
    ]);
  });

  it("closes the cards a task left open once it ends, and tells the chat showing them", async () => {
    const s = setup();
    const { chatId } = await startTask(s);
    const question = { id: "ask-1", messageId: "m1", render: null, since: Date.now() };
    (s.deps.webchatRepo as { taskCardsOf: unknown }).taskCardsOf = async () =>
      new Map([[chatId, { questions: [question], approvals: [] }]]);
    const events: { card: { id: string; closed?: boolean } }[] = [];
    s.service.onCardSettled((event) => events.push(event as never));
    s.fakeTimers();
    await finishTask(s, chatId);
    await rs.advanceTimersByTimeAsync(2_000);
    await s.settle();
    expect(events.map((event) => [event.card.id, event.card.closed])).toContainEqual([
      "ask-1",
      true,
    ]);
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
        `<task id="${taskId}" chat_id="${chatId}" title="Flights" status="ended" end_reason="failed" changes="turn_end:error by=concierge">`,
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
    // The turn never started, so the chat runs none.
    cold.chats.activeTurns = () => [];
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

  it("wakes no turn for a scheduled run that finished with nothing to ask, and lists it in the next digest", async () => {
    const s = setup();
    const { chatId, taskId } = await startTask(s);
    s.fakeTimers();
    // A routine woke the task chat; nobody typed in it, and it asked nothing.
    await s.finish({
      turnId: "scheduled-turn",
      agentName: "core:main",
      chatId,
      status: "completed",
    });
    await rs.advanceTimersByTimeAsync(10 * 60_000);
    expect(s.backendTurns).toEqual([]);
    // Its result waits for no report: the task ended, and nothing stays working.
    expect(await s.taskRepo.get(taskId)).toMatchObject({
      lastOutcome: "succeeded",
      outcomeUnsaid: false,
    });
    const notes = await s.service.digestTaskNotes(CONCIERGE_CHAT, "guardian");
    expect(notes.text).toContain(`<ran_on_schedule task="${taskId}" title="Flights"/>`);
    // Listed once, after a digest that listed it ran to its end.
    await s.service.markTaskNotesListed(notes);
    expect((await s.service.digestTaskNotes(CONCIERGE_CHAT, "guardian")).text).not.toContain(
      "ran_on_schedule",
    );
  });

  it("keeps a digest's no-response and scheduled-run notes until a digest that lists them runs to its end", async () => {
    const s = setup();
    const { chatId, taskId } = await startTask(s);
    s.fakeTimers();
    await s.finish({
      turnId: "scheduled-turn",
      agentName: "core:main",
      chatId,
      status: "completed",
    });
    await rs.advanceTimersByTimeAsync(10 * 60_000);
    const [unanswered] = await s.taskRepo.upsertMany([{ title: "Pick a seat" }]);
    await s.taskRepo.markWaitExpired(unanswered!.id, new Date(Date.now() - 2 * 86_400_000));
    // A digest turn that failed marked nothing: the next digest reads the same notes.
    const first = await s.service.digestTaskNotes(CONCIERGE_CHAT, "guardian");
    const again = await s.service.digestTaskNotes(CONCIERGE_CHAT, "guardian");
    expect(again).toEqual(first);
    expect(first.text).toContain(`<ran_on_schedule task="${taskId}"`);
    expect(first.text).toContain(`<ended_no_response task="${unanswered!.id}"`);
    await s.service.markTaskNotesListed(again);
    expect((await s.service.digestTaskNotes(CONCIERGE_CHAT, "guardian")).text).toBe("");
  });

  it("tells the Concierge quietly that a task chat was deleted, and its row stays stopped and archived", async () => {
    const s = setup();
    const { chatId, taskId } = await startTask(s);
    s.fakeTimers();
    const linked = await s.service.endTaskChat(chatId, "deleted");
    expect(linked).toBe(taskId);
    expect(await s.storedChats.getSession(chatId)).toBeNull();
    s.service.chatDeleted(taskId);
    await rs.advanceTimersByTimeAsync(59_000);
    expect(s.backendTurns).toEqual([]);
    await rs.advanceTimersByTimeAsync(1_000);
    expect(s.backendTurns[0].prompt).toBe(
      `${MAIN_LINE}<task_events>\n<task id="${taskId}" title="Flights" status="ended" end_reason="stopped" changes="chat_deleted" quiet="true">\nThe task chat was deleted.\n</task>\n</task_events>`,
    );
    expect(await s.taskRepo.get(taskId)).toMatchObject({
      sessionId: null,
      title: "Flights",
      archivedAt: expect.any(Date),
      stoppedAt: expect.any(Date),
      stopReason: "deleted",
    });
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

  it("settles a task's news once the Concierge's turn that reports it completes, with no row write", async () => {
    const s = setup();
    const task = await startTask(s);
    s.fakeTimers();
    await finishTask(s, task.chatId);
    await rs.advanceTimersByTimeAsync(2_000);
    expect(s.backendTurns).toHaveLength(1);
    await rs.advanceTimersByTimeAsync(120_000);
    // No retry, and the row stays synced: the Concierge had the news.
    expect(s.backendTurns).toHaveLength(1);
    expect((await s.tasks.listForPanel())[0].notSynced).toBe(false);
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
      content: JSON.stringify([{ type: "text", content: concluded(answer) }]),
    });
    return started.chatId;
  };
  const SECRET_ANSWER = "Your one-time login code is 7291.";

  it("pushes the task's title and its forwarded text for a forward with no intro", async () => {
    const s = setup();
    const chatId = await finishedTask(s, SECRET_ANSWER);
    const title = (await s.tasks.repo.findBySession(chatId))?.title ?? "";
    s.pushLevel("active");
    await s.tool("chat_forward", { chatId });
    await s.settle();
    expect(s.pushes).toHaveLength(1);
    expect(s.pushes[0]?.body).toContain("7291");
    if (title) expect(s.pushes[0]?.body?.startsWith(title)).toBe(true);
  });

  it("pushes only the intro of a forward that has one", async () => {
    const s = setup();
    const chatId = await finishedTask(s, SECRET_ANSWER);
    s.pushLevel("active");
    await s.tool("chat_forward", { chatId, intro: "The bank sent a sign-in code." });
    await s.settle();
    expect(s.pushes.map((push) => push.body)).toEqual(["The bank sent a sign-in code."]);
  });

  it("pushes what a card shows: its task's title when it asks nothing", async () => {
    const s = setup();
    const chatId = await finishedTask(s, SECRET_ANSWER);
    const title = (await s.tasks.repo.findBySession(chatId))?.title;
    s.pushLevel("active");
    await s.tool("chat_card", { chatId });
    await s.settle();
    expect(s.pushes.map((push) => push.body)).toEqual([title]);
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
      "Main chat",
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
      "Main chat",
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
  it.each([
    [false, true],
    [true, false],
  ] as const)("answers the failed turn's messages when its recovery ends, unless a newer input took the recovery over (handed on: %s)", async (handedOn, answered) => {
    const { s } = await prepared({ delay: async () => {} });
    await s.taskRepo.takeMessage("failed", { chatId: CONCIERGE_CHAT, messageKey: "g1" });
    s.onBackendTurn(() => {
      void s.finish({
        turnId: "recovery",
        agentName: CONCIERGE_AGENT_ID,
        chatId: CONCIERGE_CHAT,
        status: handedOn ? "interrupted" : "completed",
        handedOn,
        text: "done",
      });
    });
    await finish(s, failure("Repeated 529 Overloaded errors"));
    await s.settle();
    expect(s.backendTurns).toHaveLength(1);
    expect(s.answered("g1")).toBe(answered);
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
    // Bound to its chat: it wakes the chat's current session, not the one that set it.
    expect(await s.service.resolveTurn(wakeUp)).toMatchObject({
      threadId: TOPIC_CHAT,
      sessionId: "runtime-1",
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

  it("retiring a topic chat hands its open tasks to the main chat and says so there; the main chat cannot be retired", async () => {
    const s = setup({ startEvents: false });
    await s.storedChats.createSession(TOPIC_CHAT, "Calendar");
    s.turnIn(TOPIC_CHAT);
    // "Book dentist" runs in its task chat; "Old" has ended.
    await s.tool("say", { text: "On it" });
    await s.tool("chat_start", { title: "Book dentist", brief: "Book it" });
    const made = (await s.tool("task_upsert", { tasks: [{ title: "Old" }] })) as {
      content: { text: string }[];
    };
    const oldId = JSON.parse(made.content[0]!.text).tasks[0].id as string;
    await s.taskRepo.setLastOutcome(oldId, "succeeded", new Date(), { reported: false });
    s.tasks.attachFacts({
      now: () => Date.now(),
      running: (chatId) => chatId === "task-1",
      openWaits: async () => new Map(),
      reportPending: () => [],
    });
    await s.storedChats.archiveSession(TOPIC_CHAT);
    await s.service.retireChat(TOPIC_CHAT, "archived");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const rows = await s.tasks.listForPanel();
    // Every row reads as the main chat's, and none is moved.
    expect(rows.find((row) => row.title === "Book dentist")?.conciergeChat.main).toBe(true);
    const old = rows.find((row) => row.title === "Old");
    expect(old?.conciergeChat.main).toBe(true);
    expect((await s.taskRepo.get(old!.id))?.chatId).toBe(TOPIC_CHAT);
    expect(s.backendTurns.at(-1)).toMatchObject({ threadId: CONCIERGE_CHAT });
    expect(s.backendTurns.at(-1)?.prompt).toContain(
      '<concierge_chat_retired name="Calendar" how="archived" follows="0" tasks="1"/>',
    );
    await expect(s.service.retireChat(CONCIERGE_CHAT, "deleted")).rejects.toThrow("main");
  });

  describe("ending a topic chat's follows and tasks before it is deleted", () => {
    /** "Calendar" has a running task with a task chat, a finished one, and one with no task chat. */
    const withWork = async () => {
      const s = setup({ startEvents: false });
      await s.storedChats.createSession(TOPIC_CHAT, "Calendar");
      s.turnIn(TOPIC_CHAT);
      await s.tool("say", { text: "On it" });
      const running = JSON.parse(
        (await s.tool("chat_start", { title: "Book dentist", brief: "Book it" })).content[0].text,
      ) as { chatId: string; taskId: string };
      const made = (await s.tool("task_upsert", {
        tasks: [{ title: "Old" }, { title: "Loose" }],
      })) as { content: { text: string }[] };
      const [oldId, looseId] = (JSON.parse(made.content[0]!.text).tasks as { id: string }[]).map(
        (task) => task.id,
      ) as [string, string];
      await s.taskRepo.setLastOutcome(oldId, "succeeded", new Date(), { reported: false });
      s.tasks.attachFacts({
        now: () => Date.now(),
        running: (chatId) => chatId === running.chatId,
        openWaits: async () => new Map(),
        reportPending: () => [],
      });
      s.chats.activeTurns = (chatId: string) => (chatId === running.chatId ? ["t1"] : []);
      const cancelled: string[] = [];
      s.deps.checks = {
        cancelFor: async (id: string) => (cancelled.push(id), 0),
        laterOf: async () => new Map(),
      } as never;
      const unfollowed: [string, string, string][] = [];
      s.service.attachFollowing({
        followsOfChat: async () => [{ source: "github", label: "GitHub", target: "acme/widgets" }],
        unfollow: async (source: string, target: string, owner: string) => {
          unfollowed.push([source, target, owner]);
          return { removed: true };
        },
        moveToMainChat: async () => 0,
      } as unknown as ConciergeFollowing);
      return { s, running, oldId, looseId, cancelled, unfollowed };
    };

    it("lists the follows and the open tasks the delete would move, and not a finished task", async () => {
      const { s, running, looseId } = await withWork();
      const work = await s.service.followsAndTasksOf(TOPIC_CHAT, "guardian");
      expect(work.follows).toEqual([{ source: "github", label: "GitHub", target: "acme/widgets" }]);
      expect(work.openTasks.map((task) => task.id).sort()).toEqual(
        [running.taskId, looseId].sort(),
      );
      expect(work.openTasks.map((task) => task.title).sort()).toEqual(["Book dentist", "Loose"]);
    });

    it("ends the follows, interrupts a running turn, cancels the checks and archives the task chat's row", async () => {
      const { s, running, looseId, oldId, cancelled, unfollowed } = await withWork();
      await s.service.endChatWork(TOPIC_CHAT);
      expect(unfollowed).toEqual([["github", "acme/widgets", "guardian"]]);
      expect(s.chats.interruptTurn).toHaveBeenCalledWith("t1");
      expect(cancelled).toContain(running.taskId);
      expect(cancelled).toContain(looseId);
      expect(await s.taskRepo.get(running.taskId)).toMatchObject({
        stopReason: "archived",
        archivedAt: expect.any(Date),
      });
      expect(await s.taskRepo.get(looseId)).toMatchObject({
        stopReason: "guardian",
        archivedAt: expect.any(Date),
      });
      // Ended·stopped, not open, and the finished one is as it was.
      const status = await s.tasks.statusOf(
        [(await s.taskRepo.get(running.taskId))!, (await s.taskRepo.get(looseId))!],
        { asReported: true },
      );
      expect([...status.values()].map((one) => one.status)).toEqual(["ended", "ended"]);
      expect(await s.taskRepo.get(oldId)).toMatchObject({ stopReason: null });
      // The row with a task chat is archived with it, so the main chat's panel does not list it.
      await s.service.retireChat(TOPIC_CHAT, "deleted");
      const panel = (await s.tasks.listForPanel()).map((row) => row.id);
      expect(panel).not.toContain(running.taskId);
      expect(await s.service.followsAndTasksOf(TOPIC_CHAT, "guardian")).toMatchObject({
        openTasks: [],
      });
    });

    it("leaves neither kind of stopped task on the main chat's task panel", async () => {
      const { s, running, looseId, oldId } = await withWork();
      await s.service.endChatWork(TOPIC_CHAT);
      await s.storedChats.deleteSession(TOPIC_CHAT);
      await s.service.retireChat(TOPIC_CHAT, "deleted");
      const panel = await s.tasks.listForPanel();
      const ids = panel.map((row) => row.id);
      // The task with a task chat and the one with none are both gone from it.
      expect(ids).not.toContain(running.taskId);
      expect(ids).not.toContain(looseId);
      // A task that had already finished is untouched, and reads as the main chat's.
      expect(panel.find((row) => row.id === oldId)?.conciergeChat.main).toBe(true);
    });

    it("sends the main chat no news of the tasks it ended, and keeps a task it could not end heard", async () => {
      const { s, running } = await withWork();
      const events = new TaskEventCoalescer({
        now: () => Date.now(),
        render: async () => [],
        deliver: async () => "completed",
        giveUp: () => {},
      });
      s.service.attachTaskEvents(events);
      // News the running task held before the delete is dropped too.
      events.mark({ taskId: running.taskId, kind: "turn_end:completed by=system", urgent: false });
      await s.service.endChatWork(TOPIC_CHAT);
      // The interrupted turn ends after the delete; its news is dropped.
      events.mark({
        taskId: running.taskId,
        kind: "turn_end:interrupted by=system",
        urgent: false,
      });
      // The task with no task chat is stopped without a stopped_by_owner report.
      expect(events.pending).toEqual([]);

      const failing = await withWork();
      const heard = new TaskEventCoalescer({
        now: () => Date.now(),
        render: async () => [],
        deliver: async () => "completed",
        giveUp: () => {},
      });
      failing.s.service.attachTaskEvents(heard);
      failing.s.chats.interruptTurn = async () => {
        throw new Error("turn_not_interruptible");
      };
      await failing.s.service.endChatWork(TOPIC_CHAT);
      // Work that kept running moves to the main chat, and its news still reaches it.
      heard.mark({
        taskId: failing.running.taskId,
        kind: "turn_end:completed by=system",
        urgent: false,
      });
      expect(heard.pending).toEqual([failing.running.taskId]);
      events.stop();
      heard.stop();
    });

    it('leaves the main chat no "chat retired" notice once everything ended', async () => {
      const { s } = await withWork();
      await s.service.endChatWork(TOPIC_CHAT);
      const before = s.backendTurns.length;
      await s.service.retireChat(TOPIC_CHAT, "deleted");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(
        s.backendTurns.slice(before).some((turn) => turn.prompt.includes("concierge_chat_retired")),
      ).toBe(false);
    });

    it("keeps moving what fails to end, and ends nothing for the main chat or a chat that is gone", async () => {
      const { s, running, looseId, unfollowed } = await withWork();
      s.chats.interruptTurn = async () => {
        throw new Error("turn_not_interruptible");
      };
      s.service.attachFollowing({
        followsOfChat: async () => [{ source: "github", label: "GitHub", target: "acme/widgets" }],
        unfollow: async () => {
          throw new Error("connector down");
        },
        moveToMainChat: async () => 1,
      } as unknown as ConciergeFollowing);
      await s.service.endChatWork(TOPIC_CHAT);
      // A task whose turn could not be interrupted stays open, neither stopped nor archived.
      expect(await s.taskRepo.get(running.taskId)).toMatchObject({
        stoppedAt: null,
        archivedAt: null,
      });
      // The failed follow and that task are still there for retireChat to move and announce.
      await s.service.retireChat(TOPIC_CHAT, "deleted");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(s.backendTurns.at(-1)?.prompt).toContain(
        '<concierge_chat_retired name="Calendar" how="deleted" follows="1" tasks="1"/>',
      );
      expect(unfollowed).toEqual([]);
      await s.storedChats.deleteSession(TOPIC_CHAT);
      const panel = await s.tasks.listForPanel();
      expect(panel.find((row) => row.id === running.taskId)?.conciergeChat.main).toBe(true);
      // The task with no task chat had nothing to interrupt, and ended.
      expect(panel.map((row) => row.id)).not.toContain(looseId);
      await s.service.endChatWork(CONCIERGE_CHAT);
      await s.service.endChatWork("gone");
    });

    it("moves the follows and open tasks as before when nothing ended them", async () => {
      const { s, unfollowed } = await withWork();
      await s.service.retireChat(TOPIC_CHAT, "deleted");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unfollowed).toEqual([]);
      expect(s.backendTurns.at(-1)?.prompt).toContain(
        '<concierge_chat_retired name="Calendar" how="deleted" follows="0" tasks="2"/>',
      );
    });
  });

  it("asks once in the digest about a row left a day with no task chat and nothing scheduled", async () => {
    const s = setup({ startEvents: false });
    const day = s.tasks.waitExpiry;
    const aged = new Date(Date.now() - day - 1_000);
    const [old, checked] = await s.taskRepo.upsertMany(
      [
        { title: "Follow up hiring", chatId: CONCIERGE_CHAT },
        { title: "Checked", chatId: CONCIERGE_CHAT },
      ],
      aged,
    );
    // Written just now: not a day old yet.
    await s.taskRepo.upsertMany([{ title: "Fresh", chatId: CONCIERGE_CHAT }]);
    s.tasks.attachFacts({
      now: () => Date.now(),
      running: () => false,
      openWaits: async () => new Map(),
      reportPending: () => [],
      laterOf: async () => new Map([[checked!.id, Date.now() + 60_000]]),
    });
    const notes = await s.service.digestTaskNotes(CONCIERGE_CHAT, "guardian");
    expect(notes.text).toBe(
      `<task_review>\n<not_started task="${old!.id}" title="Follow up hiring"/>\n</task_review>`,
    );
    expect(notes.unstarted).toEqual([old!.id]);
    // Listed once: after a digest that ran to its end, it is not listed again.
    await s.service.markTaskNotesListed(notes);
    expect((await s.service.digestTaskNotes(CONCIERGE_CHAT, "guardian")).text).toBe("");
  });

  it("flags in the digest a task still waiting on a check it scheduled three times", async () => {
    const s = setup({ startEvents: false });
    const [often, once] = await s.taskRepo.upsertMany([{ title: "CI run" }, { title: "Reply" }]);
    s.tasks.attachFacts({
      now: () => Date.now(),
      running: () => false,
      openWaits: async () => new Map(),
      reportPending: () => [],
      laterOf: async (ids) => new Map(ids.map((id) => [id, Date.now() + 60_000])),
    });
    s.deps.checks = {
      timesScheduled: async () =>
        new Map([
          [often.id, POSTPONED_CHECKS],
          [once.id, 1],
        ]),
    } as never;
    expect((await s.service.digestTaskNotes(CONCIERGE_CHAT, "guardian")).text).toBe(
      `<task_review>\n<check_postponed task="${often.id}" title="CI run" checks="3"/>\n</task_review>`,
    );
    s.deps.checks = { timesScheduled: async () => new Map() } as never;
    expect((await s.service.digestTaskNotes(CONCIERGE_CHAT, "guardian")).text).toBe("");
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

describe("Concierge tasks started for a guardian message", () => {
  /** A guardian message of the tools' turn. */
  const guardianSays = (s: ReturnType<typeof setup>, id: string, turnId = "concierge-turn-1") => {
    const list = s.messages.get(CONCIERGE_CHAT) ?? [];
    list.push({ id, role: "user", content: "[]", turnId });
    s.messages.set(CONCIERGE_CHAT, list);
  };
  const started = async (s: ReturnType<typeof setup>, args: Record<string, unknown> = {}) =>
    JSON.parse(
      (await s.tool("chat_start", { title: "Weather", brief: "Check the weather", ...args }))
        .content[0].text,
    ) as { chatId: string; taskId: string };
  /** The Concierge's turn that reports task chat `chatId`'s news ends `outcome`. */
  const reportEnds = async (
    s: ReturnType<typeof setup>,
    chatId: string,
    outcome: "completed" | "failed" | "interrupted" | "stopped" = "completed",
  ) => {
    const task = await s.taskRepo.findBySession(chatId);
    s.onBackendTurn(() => outcome);
    await s.service.systemTurnOutcome(
      CONCIERGE_CHAT,
      `<task_events>\n<task id="${task!.id}" title="Weather">\n</task>\n</task_events>`,
      { taskIds: [task!.id] },
    );
    s.onBackendTurn(() => "completed");
    // As the flush that carried the news settles it: only a report that ran
    // to its end does, and its result is then said.
    const events = (
      s.service as unknown as {
        taskEvents: { dirty: Map<string, unknown>; changed(): void } | null;
      }
    ).taskEvents;
    if (outcome === "completed") {
      events?.dirty.delete(task!.id);
      events?.changed();
      await s.taskRepo.markReported([task!.id]);
    } else if (outcome === "stopped") {
      events?.dirty.delete(task!.id);
      await s.taskRepo.markGivenUp(task!.id);
      events?.changed();
    }
  };
  /** The task chat's turn ends `status`, and, unless it was stopped, the Concierge reports it. */
  const finishTask = async (
    s: ReturnType<typeof setup>,
    chatId: string,
    status?: AgentTurnFinishedEvent["status"],
    { reported = true }: { reported?: boolean } = {},
  ) => {
    // The turn the Concierge's brief started, so it reports to the Concierge.
    await s.finish({
      turnId: "task-turn-1",
      agentName: "core:main",
      chatId,
      status,
      text: "x",
    });
    if (reported && status !== "interrupted") await reportEnds(s, chatId);
  };
  /**
   * The guardian typed in task chat `chatId` themself, so its turn is theirs:
   * its end is quiet news, not one that needs no word.
   */
  const guardianTyped = (s: ReturnType<typeof setup>, chatId: string) =>
    s.messages.get(chatId)?.push({
      id: `typed-${chatId}`,
      role: "user",
      content: JSON.stringify([{ type: "text", content: "Also check Friday" }]),
      senderId: "guardian-1",
      turnId: "task-turn-1",
    });
  /** Task chat `chatId` wrote a reply, so its turn's end has news to report. */
  const replies = (s: ReturnType<typeof setup>, chatId: string) =>
    s.messages.get(chatId)?.push({
      role: "assistant",
      content: JSON.stringify([{ type: "text", content: concluded("Sunny") }]),
    });

  describe("a task's conclusion forwarded, or refused", () => {
    /** The task finished with `answer`; its news waits for the Concierge's report turn. */
    const finishedWith = async (answer: string) => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      const { chatId, taskId } = await started(s);
      s.messages.get(chatId)?.push({
        role: "assistant",
        content: JSON.stringify([{ type: "text", content: answer }]),
      });
      await finishTask(s, chatId, "completed", { reported: false });
      s.inTurn("report-turn");
      return { s, chatId, taskId };
    };
    const replyOfId = (s: ReturnType<typeof setup>, id: string) =>
      s.messages.get(CONCIERGE_CHAT)?.find((row) => row.id === id)?.replyTo;

    it("forwards the conclusion as a reply to the task's start message and anchors the row to it", async () => {
      const { s, chatId, taskId } = await finishedWith(concluded("Found 3 flights. Which one?"));
      const start = (await s.taskRepo.getWithChat(taskId))?.sourceMessageId;
      const forwarded = JSON.parse((await s.tool("chat_forward", { chatId })).content[0].text);
      expect(replyOfId(s, forwarded.messageId)).toBe(start);
      expect((await s.taskRepo.getWithChat(taskId))?.sourceMessageId).toBe(forwarded.messageId);
    });

    it("refuses the forward of a task with no conclusion, and the report said for the task replies to its start message", async () => {
      const { s, chatId, taskId } = await finishedWith("Details, but no conclusion section.");
      const start = (await s.taskRepo.getWithChat(taskId))?.sourceMessageId;
      const refused = await s.tool("chat_forward", { chatId });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain("with task set to this task's id");
      const said = JSON.parse(
        (
          await s.tool("say", {
            text: "Found 3 flights, cheapest ¥4,380. Which one?",
            task: taskId,
          })
        ).content[0].text,
      );
      expect(replyOfId(s, said.messageId)).toBe(start);
    });

    it("refuses the forward of a conclusion that is too long", async () => {
      const { s, chatId } = await finishedWith("x".repeat(CONCLUSION_MAX_CHARS + 1));
      expect((await s.tool("chat_forward", { chatId })).isError).toBe(true);
    });

    /** An input of the report turn that an automation or an agent wrote, stored as a user message. */
    const automatedSays = (s: ReturnType<typeof setup>, id: string, senderId: string) => {
      const list = s.messages.get(CONCIERGE_CHAT) ?? [];
      list.push({ id, role: "user", content: "[]", turnId: "report-turn", senderId });
      s.messages.set(CONCIERGE_CHAT, list);
    };

    it.each([
      ["a tagged routine", "automated::0::routine:Morning briefing"],
      ["a tagged app on the guardian's behalf", "automated::1::app:daily-report"],
      ["a tagged agent", "automated::0::agent:coding:coding"],
      ["an agent's own account", "core:concierge"],
    ])("refuses the full text in a turn only %s started, such as a continuation after a quota reset", async (_who, senderId) => {
      const { s, chatId } = await finishedWith(concluded("Done."));
      automatedSays(s, "auto", senderId);
      const refused = await s.tool("chat_forward", { chatId, full: true });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain("only in a turn they started");
    });

    it("allows the full text when the guardian's own message is in the turn beside an automated input", async () => {
      const { s, chatId } = await finishedWith(concluded("Done."));
      automatedSays(s, "auto", "automated::0::routine:Morning briefing");
      guardianSays(s, "g2", "report-turn");
      const allowed = await s.tool("chat_forward", { chatId, full: true });
      expect(allowed.isError).toBeFalsy();
    });

    it("still takes an automated input as a message the turn answers, whatever the full-text gate says", async () => {
      const { s } = await finishedWith(concluded("Done."));
      automatedSays(s, "auto", "automated::0::routine:Morning briefing");
      // `answers` may name it, as it may name any message of the turn.
      const said = await s.tool("say", { text: "Noted.", answers: "auto" });
      expect(said.isError).toBeFalsy();
    });

    it("does not count a message an earlier, cut-short turn handed on as the guardian starting this turn", async () => {
      const { s, chatId } = await finishedWith(concluded("Done."));
      s.service.handOnPrompts(CONCIERGE_CHAT, ["g1"]);
      const refused = await s.tool("chat_forward", { chatId, full: true });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain("only in a turn they started");
      // Its own message in the turn does.
      guardianSays(s, "g2", "report-turn");
      const allowed = await s.tool("chat_forward", { chatId, full: true });
      expect(allowed.isError).toBeFalsy();
    });
  });

  it("points the row of a task started for a guardian message at that message", async () => {
    const s = setup({ said: false });
    guardianSays(s, "g1");
    const { taskId } = await started(s);
    // With nothing said, the row points at the guardian's message.
    expect((await s.taskRepo.getWithChat(taskId))?.sourceMessageId).toBe("g1");
  });

  it("stops a task its owner stops, cancels its checks, and tells the Concierge quietly", async () => {
    const s = setup({ said: false });
    guardianSays(s, "g1");
    const { taskId } = await started(s);
    const cancelled: string[] = [];
    s.deps.checks = {
      cancelFor: async (id: string) => (cancelled.push(id), 0),
      laterOf: async () => new Map(),
    } as never;
    s.chats.activeTurns = () => ["task-turn-1"];
    expect(await s.service.stopTask(taskId, "guardian")).toBe(1);
    expect(s.chats.interruptTurn).toHaveBeenCalledWith("task-turn-1");
    expect(cancelled).toEqual([taskId]);
    expect(await s.taskRepo.get(taskId)).toMatchObject({ stopReason: "guardian" });
    const coalescer = (s.service as unknown as { taskEvents: { pending: string[] } }).taskEvents;
    expect(coalescer.pending).toContain(taskId);
  });

  it("stops a task whose owner pressed Stop in its task chat as any Stop does", async () => {
    const s = setup({ said: false });
    guardianSays(s, "g1");
    const { chatId, taskId } = await started(s);
    const cancelled: string[] = [];
    s.deps.checks = {
      cancelFor: async (id: string) => (cancelled.push(id), 0),
      laterOf: async () => new Map(),
    } as never;
    const turnedDown: string[] = [];
    s.service.attachApprovalExpiry(async (chat) => (turnedDown.push(chat), 1));
    // The Stop in the task chat interrupts its turn, not through the task.
    await finishTask(s, chatId, "interrupted");
    expect(await s.taskRepo.get(taskId)).toMatchObject({ stopReason: "guardian" });
    expect(cancelled).toEqual([taskId]);
    expect(turnedDown).toEqual([chatId]);
  });

  describe("from the turn that takes the message", () => {
    // The send route marks a message once a Concierge turn takes it.
    const taken = (s: ReturnType<typeof setup>, key: string, turnId = "concierge-turn-1") =>
      s.taskRepo.takeMessage(turnId, { chatId: CONCIERGE_CHAT, messageKey: key });
    const conciergeEnds = (
      s: ReturnType<typeof setup>,
      status?: AgentTurnFinishedEvent["status"],
      turnId = "concierge-turn-1",
      handedOn = false,
    ) =>
      s.finish({
        turnId,
        agentName: "core:concierge",
        chatId: CONCIERGE_CHAT,
        status,
        text: "ok",
        handedOn,
      });

    it("says when the turn that took the owner's messages in ended, unless a newer one carries them on", async () => {
      const s = setup({ said: false });
      const settled: unknown[] = [];
      s.service.onInputsSettled((event) => settled.push(event));
      guardianSays(s, "press", "turn-a");
      await conciergeEnds(s, "interrupted", "turn-a", true);
      await s.settle();
      expect(settled).toEqual([]);
      guardianSays(s, "next", "turn-b");
      // A press queued behind the turn waits for a turn of its own.
      const list = s.messages.get(CONCIERGE_CHAT)!;
      list.push({
        id: "queued",
        role: "user",
        content: "[]",
        turnId: "turn-b",
        inputState: "queued",
      });
      await conciergeEnds(s, "completed", "turn-b");
      await s.settle();
      // The press the cut-short turn handed on is done with as well.
      expect(settled).toEqual([{ sessionId: CONCIERGE_CHAT, inputIds: ["next", "press"] }]);
    });

    it("starts no task on a guess when the turn carries several guardian messages and names none", async () => {
      const s = setup({ said: false });
      guardianSays(s, "a");
      guardianSays(s, "b");
      await taken(s, "a");
      await taken(s, "b");
      await s.tool("say", { text: "On it" });
      const refused = await s.tool("chat_start", { title: "Weather", brief: "Check the weather" });
      expect(refused).toMatchObject({ isError: true });
    });

    it("tells the next turn once of a message its owner stopped before an answer, and not of one handed on", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      await taken(s, "g1");
      await conciergeEnds(s, "interrupted");
      expect(await s.service.stoppedRequestLines(CONCIERGE_CHAT)).toBe(
        '<stopped_request message_id="g1"/>',
      );
      expect(await s.service.stoppedRequestLines(CONCIERGE_CHAT)).toBe("");
      // A turn a newer input took over was not stopped: its work goes on.
      guardianSays(s, "g2", "turn-b");
      await taken(s, "g2", "turn-b");
      await conciergeEnds(s, "interrupted", "turn-b", true);
      expect(await s.service.stoppedRequestLines(CONCIERGE_CHAT)).toBe("");
    });

    it("does not tell the next turn of a message the Concierge answered before its owner stopped the turn", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      await taken(s, "g1");
      await s.tool("say", { text: "Sunny, 24°" });
      await conciergeEnds(s, "interrupted");
      expect(await s.service.stoppedRequestLines(CONCIERGE_CHAT)).toBe("");
    });

    it("still tells the next turn of a message the Concierge only reacted to, since a reaction answers nothing", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      await taken(s, "g1");
      await s.tool("react", { emoji: "👍" });
      expect(s.answered("g1")).toBe(false);
      await conciergeEnds(s, "interrupted");
      expect(await s.service.stoppedRequestLines(CONCIERGE_CHAT)).toBe(
        '<stopped_request message_id="g1"/>',
      );
    });

    it("hands none further when a turn that took over never started", async () => {
      const s = setup({ said: false });
      guardianSays(s, "a", "turn-a");
      await taken(s, "a", "turn-a");
      await conciergeEnds(s, "interrupted", "turn-a", true);
      await s.settle();
      expect(s.service.promptsHandedOn(CONCIERGE_CHAT)).toEqual(["a"]);
      await s.failBeforeStart({
        turnId: "turn-b",
        chatId: CONCIERGE_CHAT,
        error: "no session",
        agentName: "core:concierge",
      });
      expect(s.answered("a")).toBe(true);
      expect(s.service.promptsHandedOn(CONCIERGE_CHAT)).toEqual([]);
    });

    describe("once the Concierge answers it", () => {
      it("answers the message at a say naming it, while the turn goes on to start a task for another", async () => {
        const s = setup({ said: false });
        guardianSays(s, "chat");
        guardianSays(s, "kiwi");
        await taken(s, "chat");
        await taken(s, "kiwi");
        await s.tool("say", { text: "Quiet one, thanks.", answers: "chat" });
        expect([s.answered("chat"), s.answered("kiwi")]).toEqual([true, false]);
        await started(s, { answers: "kiwi" });
        await conciergeEnds(s);
        expect([s.answered("chat"), s.answered("kiwi")]).toEqual([true, true]);
      });

      it("answers the turn's only message at a say naming none, though the turn runs on", async () => {
        const s = setup({ said: false });
        guardianSays(s, "g1");
        await taken(s, "g1");
        await s.tool("say", { text: "Sunny, 24°" });
        expect(s.answered("g1")).toBe(true);
      });

      it("waits for the turn's end when the turn carries several messages and the answer names none", async () => {
        const s = setup({ said: false });
        guardianSays(s, "a");
        guardianSays(s, "b");
        await taken(s, "a");
        await taken(s, "b");
        await s.tool("say", { text: "Both fine" });
        expect([s.answered("a"), s.answered("b")]).toEqual([false, false]);
        await conciergeEnds(s);
        expect([s.answered("a"), s.answered("b")]).toEqual([true, true]);
      });

      it("answers at a say naming a task started in the thread the message is in", async () => {
        const s = setup({ said: false });
        s.inTurn("t0");
        guardianSays(s, "g0", "t0");
        const { taskId } = await started(s);
        s.inTurn("concierge-turn-1");
        const list = s.messages.get(CONCIERGE_CHAT) ?? [];
        list.push({
          id: "g1",
          role: "user",
          content: "[]",
          turnId: "concierge-turn-1",
          chatThread: "g0",
        });
        await taken(s, "g1");
        await s.tool("say", { text: "It's still checking.", task: taskId });
        expect(s.answered("g1")).toBe(true);
      });

      it("waits for the turn's end when the message reports on a task", async () => {
        const s = setup({ said: false });
        s.inTurn("t0");
        guardianSays(s, "g0", "t0");
        const { taskId } = await started(s);
        s.inTurn("concierge-turn-1");
        guardianSays(s, "g1");
        await taken(s, "g1");
        await s.tool("say", { text: "The weather task is done.", task: taskId });
        expect(s.answered("g1")).toBe(false);
      });
    });
  });

  describe("until the Concierge says the result", () => {
    it("marks the row not synced once Rome gives up on the report", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      const { chatId, taskId } = await started(s);
      await finishTask(s, chatId, "completed", { reported: false });
      const coalescer = (
        s.service as unknown as {
          taskEvents: { dirty: Map<string, unknown>; deps: { giveUp: (id: string) => void } };
        }
      ).taskEvents;
      // As the coalescer does when a Stop ended the turn that carried it.
      coalescer.dirty.delete(taskId);
      coalescer.deps.giveUp(taskId);
      await s.settle();
      expect((await s.tasks.listForPanel()).find((row) => row.id === taskId)?.notSynced).toBe(true);
    });

    it("reports again a result a turn that took the report over said, so none is lost", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      const { chatId, taskId } = await started(s);
      s.fakeTimers();
      s.onBackendTurn(() => "interrupted");
      replies(s, chatId);
      guardianTyped(s, chatId);
      await finishTask(s, chatId, "completed", { reported: false });
      // Nobody asked for this result, so it waits for the next batch.
      await rs.advanceTimersByTimeAsync(60_000);
      expect(s.backendTurns).toHaveLength(1);
      s.onBackendTurn(() => "completed");
      s.inTurn("takeover");
      guardianSays(s, "g2", "takeover");
      await s.tool("say", { text: "Sunny all week", task: taskId });
      await s.finish({
        turnId: "takeover",
        agentName: "core:concierge",
        chatId: CONCIERGE_CHAT,
        text: "",
      });
      // Saying it settled nothing: the cut-short report runs again, to its end.
      await rs.advanceTimersByTimeAsync(RETRY_MS + 10_000);
      expect(s.backendTurns).toHaveLength(2);
      expect(s.backendTurns[1]?.prompt).toContain(taskId);
    });

    it("keeps a task's news that came after the turn said its result, with the result it brought", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      const { chatId, taskId } = await started(s);
      s.fakeTimers();
      s.onBackendTurn(() => "interrupted");
      replies(s, chatId);
      guardianTyped(s, chatId);
      await finishTask(s, chatId, "completed", { reported: false });
      await rs.advanceTimersByTimeAsync(60_000);
      s.onBackendTurn(() => "completed");
      s.inTurn("takeover");
      guardianSays(s, "g2", "takeover");
      await s.tool("say", { text: "Sunny all week", task: taskId });
      // The task chat gives a new result before the Concierge's turn ends.
      await s.taskRepo.setLastOutcome(taskId, "succeeded");
      const coalescer = (
        s.service as unknown as {
          taskEvents: { mark: (change: unknown) => void; pending: string[] };
        }
      ).taskEvents;
      coalescer.mark({ taskId, kind: "turn_end:completed by=system", urgent: true });
      await s.finish({
        turnId: "takeover",
        agentName: "core:concierge",
        chatId: CONCIERGE_CHAT,
        text: "",
      });
      await s.settle();
      expect(coalescer.pending).toContain(taskId);
      expect((await s.taskRepo.get(taskId))?.outcomeUnsaid).toBe(true);
    });

    it("keeps a report the Concierge never got, though a turn names its task, and reports it again", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      const { chatId, taskId } = await started(s);
      s.fakeTimers();
      // The report turn fails before the Concierge sees it.
      s.onBackendTurn(() => "failed");
      replies(s, chatId);
      guardianTyped(s, chatId);
      await finishTask(s, chatId, "completed", { reported: false });
      await rs.advanceTimersByTimeAsync(60_000);
      expect(s.backendTurns).toHaveLength(1);
      s.onBackendTurn(() => "completed");
      // Another turn says something naming the task, from what it read itself.
      s.inTurn("other");
      guardianSays(s, "g2", "other");
      await s.tool("say", { text: "Weather is still running?", task: taskId });
      await s.finish({
        turnId: "other",
        agentName: "core:concierge",
        chatId: CONCIERGE_CHAT,
        text: "",
      });
      await rs.advanceTimersByTimeAsync(RETRY_MS + 10_000);
      // Reported again; a report the row was not written for is asked once more.
      expect(s.backendTurns.length).toBeGreaterThanOrEqual(2);
    });

    it("tells the Concierge again, after a restart, of a result the stopped process held unsaid", async () => {
      const s = setup({ said: false, startEvents: false });
      guardianSays(s, "g1");
      const { chatId, taskId } = await started(s);
      replies(s, chatId);
      // The stopped process held the result; its pending report died with it.
      await s.taskRepo.setLastOutcome(taskId, "succeeded");
      s.chats.activeTurns = () => [];
      s.fakeTimers();
      s.startEvents();
      await rs.advanceTimersByTimeAsync(60_000);
      expect(s.backendTurns).toHaveLength(1);
      expect(s.backendTurns[0]?.prompt).toContain(taskId);
    });

    it("keeps a result that could not be shown to be reported again", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      const { chatId } = await started(s);
      replies(s, chatId);
      guardianTyped(s, chatId);
      s.fakeTimers();
      s.onBackendTurn(() => "interrupted");
      await finishTask(s, chatId, "completed", { reported: false });
      await rs.advanceTimersByTimeAsync(60_000);
      expect(s.backendTurns).toHaveLength(1);
      s.onBackendTurn(() => "completed");
      // The turn that took the report over fails to store the forward.
      s.inTurn("takeover");
      guardianSays(s, "g2", "takeover");
      s.deps.webchatRepo.addBackendMessage = async () => {
        throw new Error("disk full");
      };
      expect(await s.tool("chat_forward", { chatId })).toMatchObject({ isError: true });
      await s.finish({
        turnId: "takeover",
        agentName: "core:concierge",
        chatId: CONCIERGE_CHAT,
        text: "",
      });
      await rs.advanceTimersByTimeAsync(RETRY_MS + 10_000);
      expect(s.backendTurns.length).toBeGreaterThanOrEqual(2);
    });

    it("reports again two tasks a takeover turn said, after their batch was cut short", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      const weather = await started(s, { title: "Weather" });
      const traffic = await started(s, { title: "Traffic" });
      replies(s, weather.chatId);
      replies(s, traffic.chatId);
      guardianTyped(s, weather.chatId);
      guardianTyped(s, traffic.chatId);
      s.fakeTimers();
      s.onBackendTurn(() => "interrupted");
      await finishTask(s, weather.chatId, "completed", { reported: false });
      await finishTask(s, traffic.chatId, "completed", { reported: false });
      await rs.advanceTimersByTimeAsync(60_000);
      // One batch named both tasks, and a newer message cut it short.
      expect(s.backendTurns).toHaveLength(1);
      expect(s.backendTurns[0]?.prompt).toContain(weather.taskId);
      expect(s.backendTurns[0]?.prompt).toContain(traffic.taskId);
      s.onBackendTurn(() => "completed");
      s.inTurn("takeover");
      guardianSays(s, "g2", "takeover");
      await s.tool("say", { text: "Sunny all week", task: weather.taskId });
      await s.tool("say", { text: "Roads are clear", task: traffic.taskId });
      await s.finish({
        turnId: "takeover",
        agentName: "core:concierge",
        chatId: CONCIERGE_CHAT,
        text: "",
      });
      await rs.advanceTimersByTimeAsync(RETRY_MS + 10_000);
      expect(s.backendTurns).toHaveLength(2);
      expect(s.backendTurns[1]?.prompt).toContain(weather.taskId);
      expect(s.backendTurns[1]?.prompt).toContain(traffic.taskId);
    });
  });

  describe("its status (docs/domains/chats.md#status)", () => {
    const statusOf = async (s: ReturnType<typeof setup>, key: string) =>
      (await s.tasks.messageStatusesOf(CONCIERGE_CHAT, [key])).get(key) ?? null;
    /** The send route records the message a Concierge turn took, and starts its timer. */
    const taken = async (s: ReturnType<typeof setup>, key: string, turnId = "concierge-turn-1") => {
      await s.taskRepo.takeMessage(turnId, { chatId: CONCIERGE_CHAT, messageKey: key });
      s.service.messageStatus.taken(CONCIERGE_CHAT, key);
    };
    const conciergeEnds = (
      s: ReturnType<typeof setup>,
      status?: AgentTurnFinishedEvent["status"],
      turnId = "concierge-turn-1",
    ) =>
      s.finish({ turnId, agentName: "core:concierge", chatId: CONCIERGE_CHAT, status, text: "ok" });
    /** Every status change a watching client is told of, in order. */
    const watch = (s: ReturnType<typeof setup>) => {
      const seen: [string, string | null][] = [];
      s.tasks.onMessageStatus((target, status) => seen.push([target.messageKey, status]));
      return seen;
    };
    afterEach(() => {
      rs.useRealTimers();
    });

    it("works from the turn's first working tool call, and clears when the turn ends with no task", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      await taken(s, "g1");
      const seen = watch(s);
      // Sending a message or a reaction is no work.
      await s.service.messageStatus.toolCalled(CONCIERGE_CHAT, "mcp__rome__say");
      await s.service.messageStatus.toolCalled(CONCIERGE_CHAT, "react");
      expect(await statusOf(s, "g1")).toBeNull();
      await s.service.messageStatus.toolCalled(CONCIERGE_CHAT, "mcp__rome__execute_action");
      expect(await statusOf(s, "g1")).toBe("working");
      await conciergeEnds(s);
      await s.settle();
      expect(await statusOf(s, "g1")).toBeNull();
      expect(seen).toEqual([
        ["g1", "working"],
        ["g1", null],
      ]);
    });

    it.each([
      ["a reaction", async (s: ReturnType<typeof setup>) => s.tool("react", { emoji: "❤️" })],
      [
        "a short message",
        async (s: ReturnType<typeof setup>) => s.tool("say", { text: "Anytime." }),
      ],
    ])("never works on a thanks answered with %s and no working tool", async (_, answer) => {
      const s = setup({ said: false });
      s.fakeTimers();
      guardianSays(s, "g1");
      const seen = watch(s);
      await taken(s, "g1");
      await rs.advanceTimersByTimeAsync(1_000);
      expect((await answer(s)).isError).toBeFalsy();
      await rs.advanceTimersByTimeAsync(10_000);
      expect(await statusOf(s, "g1")).toBeNull();
      await conciergeEnds(s);
      await rs.advanceTimersByTimeAsync(100);
      expect(seen.filter(([, status]) => status !== null)).toEqual([]);
    });

    it("works once the turn runs 5 seconds without answering", async () => {
      const s = setup({ said: false });
      s.fakeTimers();
      guardianSays(s, "g1");
      await taken(s, "g1");
      await rs.advanceTimersByTimeAsync(4_900);
      expect(await statusOf(s, "g1")).toBeNull();
      await rs.advanceTimersByTimeAsync(200);
      expect(await statusOf(s, "g1")).toBe("working");
      // The answer clears it.
      await s.tool("say", { text: "Sunny, 24°" });
      expect(await statusOf(s, "g1")).toBeNull();
    });

    it.each([
      ["error", "failed"],
      ["interrupted", null],
      ["completed", null],
    ] as const)("a turn that ends %s before answering leaves the message %s", async (status, expected) => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      await taken(s, "g1");
      await s.service.messageStatus.toolCalled(CONCIERGE_CHAT, "chat_read");
      await conciergeEnds(s, status);
      await s.settle();
      expect(await statusOf(s, "g1")).toBe(expected);
    });

    it("keeps a failed message failed after the turn", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      await taken(s, "g1");
      await conciergeEnds(s, "error");
      await s.settle();
      expect(await statusOf(s, "g1")).toBe("failed");
      // A later turn of the chat leaves it as it is.
      s.inTurn("concierge-turn-2");
      guardianSays(s, "g2", "concierge-turn-2");
      await taken(s, "g2", "concierge-turn-2");
      await conciergeEnds(s, "completed", "concierge-turn-2");
      await s.settle();
      expect(await statusOf(s, "g1")).toBe("failed");
    });

    it("keeps a task's message working until the task ends and is reported, and clears it while the task waits on the guardian", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      await taken(s, "g1");
      const { chatId } = await started(s);
      await conciergeEnds(s);
      await s.settle();
      expect(await statusOf(s, "g1")).toBe("working");
      // The task asks the guardian: its card shows Needs you, so the message shows none.
      const repo = s.deps.webchatRepo as unknown as {
        openWaitsOf: (ids: readonly string[]) => Promise<Map<string, unknown>>;
      };
      repo.openWaitsOf = async (ids) =>
        approvalWaits(new Map(ids.filter((id) => id === chatId).map((id) => [id, Date.now()])));
      expect(await statusOf(s, "g1")).toBeNull();
      // Answered, it works again, through its end until its result is reported.
      repo.openWaitsOf = async () => new Map();
      expect(await statusOf(s, "g1")).toBe("working");
      await finishTask(s, chatId, "completed", { reported: false });
      expect(await statusOf(s, "g1")).toBe("working");
      await reportEnds(s, chatId);
      expect(await statusOf(s, "g1")).toBeNull();
    });

    it("works while a task made for it runs, and fails when the task ends failed", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      const { chatId } = await started(s);
      expect(await statusOf(s, "g1")).toBe("working");
      await finishTask(s, chatId, "error");
      expect(await statusOf(s, "g1")).toBe("failed");
    });

    it("gives a thanks sent beside handed-on work no working mark of its own", async () => {
      const s = setup({ said: false });
      s.fakeTimers();
      guardianSays(s, "ask", "turn-a");
      await taken(s, "ask", "turn-a");
      s.inTurn("turn-a");
      await s.service.messageStatus.toolCalled(CONCIERGE_CHAT, "chat_read");
      expect(await statusOf(s, "ask")).toBe("working");
      // The thanks cut the turn short, which hands its work on to the next one.
      s.chats.activeTurns = () => ["turn-b"];
      await conciergeEnds(s, "interrupted", "turn-a");
      s.inTurn("turn-b");
      guardianSays(s, "thanks", "turn-b");
      await taken(s, "ask", "turn-b");
      await taken(s, "thanks", "turn-b");
      await s.service.messageStatus.toolCalled(CONCIERGE_CHAT, "chat_read");
      await rs.advanceTimersByTimeAsync(6_000);
      expect([await statusOf(s, "ask"), await statusOf(s, "thanks")]).toEqual(["working", null]);
    });

    it("takes the working mark off a message the turn reacts to; a task made for it still shows", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      await taken(s, "g1");
      await s.service.messageStatus.toolCalled(CONCIERGE_CHAT, "chat_read");
      expect(await statusOf(s, "g1")).toBe("working");
      await s.tool("react", { emoji: "👍" });
      expect(await statusOf(s, "g1")).toBeNull();
      await started(s);
      expect(await statusOf(s, "g1")).toBe("working");
    });

    it("hands each message out with its status and its reaction side by side", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      await taken(s, "g1");
      await s.tool("react", { emoji: "👍" });
      await started(s);
      expect(await statusOf(s, "g1")).toBe("working");
      expect(s.reactions.get(`${CONCIERGE_CHAT}:g1`)).toBe("👍");
    });

    it("keeps a newer turn's triggers when an older turn's end arrives after it started", async () => {
      const s = setup({ said: false });
      s.fakeTimers();
      guardianSays(s, "g1", "turn-a");
      await taken(s, "g1", "turn-a");
      guardianSays(s, "g2", "turn-b");
      await taken(s, "g2", "turn-b");
      // Turn a's end lands while turn b already runs.
      s.chats.activeTurns = () => ["turn-b"];
      await conciergeEnds(s, "completed", "turn-a");
      await rs.advanceTimersByTimeAsync(100);
      await s.service.messageStatus.toolCalled(CONCIERGE_CHAT, "chat_read");
      expect(await statusOf(s, "g2")).toBe("working");
    });

    it("works out each change once, however many chats listen", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      await taken(s, "g1");
      const reads = rs.spyOn(s.tasks, "messageStatusesOf");
      const seen: unknown[] = [];
      const stops = [1, 2, 3].map(() => s.service.onMessageStatus((event) => seen.push(event)));
      await s.service.messageStatus.toolCalled(CONCIERGE_CHAT, "chat_read");
      await s.settle();
      expect(reads).toHaveBeenCalledTimes(1);
      expect(seen).toEqual(
        Array(3).fill({ sessionId: CONCIERGE_CHAT, messageId: "g1", status: "working" }),
      );
      for (const stop of stops) stop();
    });

    it("shows no ⚠️ for a turn that failed after starting a task that got done", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      await taken(s, "g1");
      const { chatId } = await started(s);
      await conciergeEnds(s, "error");
      await s.settle();
      expect(await statusOf(s, "g1")).toBe("working");
      await finishTask(s, chatId);
      expect(await statusOf(s, "g1")).toBeNull();
    });

    it("lets only the newest message given to a task follow it", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      const { chatId } = await started(s);
      await finishTask(s, chatId);
      s.inTurn("follow-up");
      guardianSays(s, "g2", "follow-up");
      await s.tool("chat_send", { chatId, text: "And tomorrow?" });
      expect([await statusOf(s, "g1"), await statusOf(s, "g2")]).toEqual([null, "working"]);
      await finishTask(s, chatId, "error");
      expect([await statusOf(s, "g1"), await statusOf(s, "g2")]).toEqual([null, "failed"]);
    });

    it("works again when a stopped turn is continued", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      await taken(s, "g1");
      await conciergeEnds(s, "error");
      await s.settle();
      expect(await statusOf(s, "g1")).toBe("failed");
      await s.taskRepo.reopenTurn(CONCIERGE_CHAT, "concierge-turn-1");
      expect(await statusOf(s, "g1")).toBe("working");
    });

    it("keeps a task whose start failed on its message, which then shows failed", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      await taken(s, "g1");
      s.refuseSends({ ok: false, invalid: "busy" });
      expect((await s.tool("chat_start", { title: "Weather", brief: "Check" })).isError).toBe(true);
      await conciergeEnds(s);
      await s.settle();
      expect(await statusOf(s, "g1")).toBe("failed");
    });

    it("keeps a message the turn reacted to free of 👀 when it is handed on with newer work", async () => {
      const s = setup({ said: false });
      guardianSays(s, "thanks", "turn-a");
      await taken(s, "thanks", "turn-a");
      s.inTurn("turn-a");
      await s.tool("react", { emoji: "❤️" });
      // "Also do X" cuts the turn short; both go on to the next one.
      s.chats.activeTurns = () => ["turn-b"];
      await conciergeEnds(s, "interrupted", "turn-a");
      guardianSays(s, "x", "turn-b");
      await taken(s, "thanks", "turn-b");
      await taken(s, "x", "turn-b");
      await s.service.messageStatus.toolCalled(CONCIERGE_CHAT, "chat_read");
      expect([await statusOf(s, "thanks"), await statusOf(s, "x")]).toEqual([null, "working"]);
    });

    it("shows no ⚠️ on a message the turn reacted to before it failed", async () => {
      const s = setup({ said: false });
      guardianSays(s, "a");
      guardianSays(s, "b");
      await taken(s, "a");
      await taken(s, "b");
      await s.tool("react", { emoji: "👍", message_id: "a" });
      await conciergeEnds(s, "error");
      await s.settle();
      expect([await statusOf(s, "a"), await statusOf(s, "b")]).toEqual([null, "failed"]);
    });

    it("continues a turn as working only for the messages its failure left", async () => {
      const s = setup({ said: false });
      guardianSays(s, "a");
      guardianSays(s, "b");
      await taken(s, "a");
      await taken(s, "b");
      await s.service.messageStatus.toolCalled(CONCIERGE_CHAT, "chat_read");
      await s.tool("say", { text: "Sunny", answers: "a" });
      await conciergeEnds(s, "error");
      await s.settle();
      expect([await statusOf(s, "a"), await statusOf(s, "b")]).toEqual([null, "failed"]);
      await s.taskRepo.reopenTurn(CONCIERGE_CHAT, "concierge-turn-1");
      expect([await statusOf(s, "a"), await statusOf(s, "b")]).toEqual([null, "working"]);
      // The continuation fails too: the answered message stays settled.
      await conciergeEnds(s, "error");
      await s.settle();
      expect([await statusOf(s, "a"), await statusOf(s, "b")]).toEqual([null, "failed"]);
    });

    it("makes a message the turn's work again once its reaction is taken back", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      await taken(s, "g1");
      await s.tool("react", { emoji: "👍" });
      await s.tool("react", { emoji: null });
      await s.service.messageStatus.toolCalled(CONCIERGE_CHAT, "chat_read");
      expect(await statusOf(s, "g1")).toBe("working");
      await conciergeEnds(s, "error");
      await s.settle();
      expect(await statusOf(s, "g1")).toBe("failed");
    });

    it("keeps a message on its task when a later send of its words is refused", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      const { chatId } = await started(s);
      expect(await statusOf(s, "g1")).toBe("working");
      s.refuseSends({ ok: false, invalid: "busy" });
      expect((await s.tool("chat_send", { chatId, text: "Faster" })).isError).toBe(true);
      expect(await statusOf(s, "g1")).toBe("working");
    });

    it("keeps no ⚠️ on a message whose task got done once the task follows a newer message", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      await taken(s, "g1");
      const { chatId } = await started(s);
      await conciergeEnds(s, "error");
      await s.settle();
      await finishTask(s, chatId);
      s.inTurn("follow-up");
      guardianSays(s, "g2", "follow-up");
      await s.tool("chat_send", { chatId, text: "And tomorrow?" });
      expect([await statusOf(s, "g1"), await statusOf(s, "g2")]).toEqual([null, "working"]);
    });

    it("moves a task back to an older message made for it again", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g0");
      const { taskId } = await started(s);
      const task = { id: taskId };
      const link = (key: string) =>
        s.taskRepo.linkMessage(taskId, { chatId: CONCIERGE_CHAT, messageKey: key });
      await link("g1");
      await link("g2");
      await link("g1");
      const marks = await s.taskRepo.messageMarks(CONCIERGE_CHAT, ["g1", "g2"]);
      expect([marks.get("g1")?.taskIds, marks.get("g2")?.taskIds]).toEqual([[task.id], []]);
    });

    it("leaves a message alone once its task ended with its result told, through the task's later runs", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      const { chatId } = await started(s);
      await finishTask(s, chatId);
      await s.settle();
      expect(await statusOf(s, "g1")).toBeNull();
      // The task runs again, as a recurring run or its owner typing in its chat does.
      s.chats.activeTurns = (id: string) => (id === chatId ? ["task-turn-2"] : []);
      await s.tasks.chatChanged(chatId);
      expect(await statusOf(s, "g1")).toBeNull();
      s.chats.activeTurns = () => [];
      await finishTask(s, chatId, "error");
      await s.settle();
      expect(await statusOf(s, "g1")).toBeNull();
    });

    /** Task `taskId` waits for a check a day off: its repeating schedule's next run, or a one-off defer. */
    const waitsFor = (s: ReturnType<typeof setup>, taskId: string, kind: "schedule" | "defer") => {
      s.deps.checks = {
        cancelFor: async () => 0,
        laterOf: async (ids: readonly string[]) =>
          new Map(ids.filter((id) => id === taskId).map((id) => [id, Date.now() + 86_400_000])),
        recurringOf: async (ids: readonly string[]) =>
          new Set(kind === "schedule" ? ids.filter((id) => id === taskId) : []),
      } as never;
    };

    it("leaves a message alone once its task, made scheduled before its result was told, waits for its next run", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      const { chatId, taskId } = await started(s);
      expect(await statusOf(s, "g1")).toBe("working");
      // The Concierge makes it a recurring task while its first run still works.
      waitsFor(s, taskId, "schedule");
      await finishTask(s, chatId);
      await s.settle();
      expect(await statusOf(s, "g1")).toBeNull();
      // Its next scheduled run, and that run failing, leave the message alone.
      s.chats.activeTurns = (id: string) => (id === chatId ? ["task-turn-2"] : []);
      await s.tasks.chatChanged(chatId);
      expect(await statusOf(s, "g1")).toBeNull();
      s.chats.activeTurns = () => [];
      await finishTask(s, chatId, "error");
      await s.settle();
      expect(await statusOf(s, "g1")).toBeNull();
    });

    it("keeps a message on its task while the task waits on a one-off check, until it ends", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      const { chatId, taskId } = await started(s);
      // Its first run tells an interim result and defers a check to tomorrow.
      waitsFor(s, taskId, "defer");
      await finishTask(s, chatId);
      await s.settle();
      expect(await statusOf(s, "g1")).toBeNull();
      // The check wakes it: the message works again, and fails with it.
      s.deps.checks = { cancelFor: async () => 0, laterOf: async () => new Map() } as never;
      s.chats.activeTurns = (id: string) => (id === chatId ? ["task-turn-2"] : []);
      await s.tasks.chatChanged(chatId);
      expect(await statusOf(s, "g1")).toBe("working");
      s.chats.activeTurns = () => [];
      await finishTask(s, chatId, "error");
      await s.settle();
      expect(await statusOf(s, "g1")).toBe("failed");
    });

    it("keeps how a task ended for its message once the result is told", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      const { chatId } = await started(s);
      await finishTask(s, chatId, "error");
      await s.settle();
      expect(await statusOf(s, "g1")).toBe("failed");
      // A later good run of the task leaves the failure where it was.
      await finishTask(s, chatId);
      await s.settle();
      expect(await statusOf(s, "g1")).toBe("failed");
    });

    it("settles a message in the task's thread that a forwarded report answers", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g0", "t0");
      s.inTurn("t0");
      const { chatId } = await started(s);
      s.messages.get(chatId)?.push({
        role: "assistant",
        content: JSON.stringify([{ type: "text", content: concluded("Sunny") }]),
      });
      // The guardian asks for the result, and the forward answers them.
      s.inTurn("ask-turn");
      guardianSays(s, "ask", "ask-turn");
      s.messages.get(CONCIERGE_CHAT)!.find((row) => row.id === "ask")!.chatThread = "g0";
      await taken(s, "ask", "ask-turn");
      expect((await s.tool("chat_forward", { chatId })).isError).toBeFalsy();
      await s.service.messageStatus.toolCalled(CONCIERGE_CHAT, "chat_read");
      expect(await statusOf(s, "ask")).toBeNull();
      await conciergeEnds(s, "error", "ask-turn");
      await s.settle();
      expect(await statusOf(s, "ask")).toBeNull();
    });

    it("gives each message its own 5-second timer, gone once the message is answered", async () => {
      const s = setup({ said: false });
      s.fakeTimers();
      guardianSays(s, "a");
      guardianSays(s, "thanks");
      await taken(s, "a");
      await rs.advanceTimersByTimeAsync(1_000);
      await s.tool("say", { text: "Sunny", answers: "a" });
      await rs.advanceTimersByTimeAsync(3_900);
      await taken(s, "thanks");
      // a's timer is gone with its answer: nothing reaches the "thanks".
      await rs.advanceTimersByTimeAsync(300);
      expect([await statusOf(s, "a"), await statusOf(s, "thanks")]).toEqual([null, null]);
      // Its own timer, 5 s after it was taken, does.
      await rs.advanceTimersByTimeAsync(5_000);
      expect(await statusOf(s, "thanks")).toBe("working");
    });

    it("keeps an older message settled when a newer one's task work fails", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      const { chatId } = await started(s);
      s.inTurn("follow-up");
      guardianSays(s, "g2", "follow-up");
      await s.tool("chat_send", { chatId, text: "And tomorrow?" });
      expect([await statusOf(s, "g1"), await statusOf(s, "g2")]).toEqual([null, "working"]);
      await finishTask(s, chatId, "error");
      await s.settle();
      expect([await statusOf(s, "g1"), await statusOf(s, "g2")]).toEqual([null, "failed"]);
    });

    it("never ends a link made after an ending check read the task", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      const { taskId } = await started(s);
      // The task reads as ended with its result told, and g1 still follows it.
      s.chats.activeTurns = () => [];
      const row = { ...(await s.taskRepo.get(taskId))!, lastOutcome: "succeeded" as const };
      // A new message goes to the task while that check still runs.
      const check = s.tasks.endLinksIfEnded(row);
      await s.taskRepo.linkMessage(taskId, { chatId: CONCIERGE_CHAT, messageKey: "g2" });
      await check;
      const marks = await s.taskRepo.messageMarks(CONCIERGE_CHAT, ["g1", "g2"]);
      expect(marks.get("g2")?.taskIds).toEqual([taskId]);
      expect(marks.get("g1")).toMatchObject({ taskIds: [], earlierTaskIds: [taskId], endedAs: [] });
    });

    it("never pushes a status to the phone", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      await taken(s, "g1");
      await s.service.messageStatus.toolCalled(CONCIERGE_CHAT, "chat_read");
      await conciergeEnds(s, "error");
      await s.settle();
      expect(s.pushes).toEqual([]);
    });
  });
});

describe("Concierge react", () => {
  /** A guardian message of the tools' turn, in Concierge chat `chatId`. */
  const guardianSays = (
    s: ReturnType<typeof setup>,
    id: string,
    turnId = "concierge-turn-1",
    chatId = CONCIERGE_CHAT,
  ) => {
    const list = s.messages.get(chatId) ?? [];
    list.push({ id, role: "user", content: "[]", turnId });
    s.messages.set(chatId, list);
  };
  const react = (s: ReturnType<typeof setup>, input: Record<string, unknown>) =>
    s.tool("react", input);

  it("offers the fixed set of emoji, or null to clear", async () => {
    const s = setup({ said: false });
    const tool = (await buildConciergeTools(s.service, s.context())).find(
      (t) => t.name === "react",
    );
    const emoji = (tool?.inputSchema as { properties: { emoji: { enum: unknown[] } } }).properties
      .emoji;
    expect(emoji.enum).toEqual([...CONCIERGE_REACTIONS, null]);
    expect(CONCIERGE_REACTIONS).toEqual(["👍", "✅", "❤️", "🙏", "😂", "🎉", "🤔"]);
    expect((tool?.inputSchema as { required: string[] }).required).toEqual(["emoji"]);
  });

  it("reacts to the turn's only guardian message when none is named", async () => {
    const s = setup({ said: false });
    guardianSays(s, "g1");
    const result = await react(s, { emoji: "👍" });
    expect(result.isError).toBeFalsy();
    expect([...s.reactions]).toEqual([[`${CONCIERGE_CHAT}:g1`, "👍"]]);
  });

  it("reacts in a topic chat too", async () => {
    const s = setup({ said: false });
    s.turnIn(TOPIC_CHAT);
    guardianSays(s, "t1", "concierge-turn-1", TOPIC_CHAT);
    expect((await react(s, { emoji: "🙏" })).isError).toBeFalsy();
    expect([...s.reactions]).toEqual([[`${TOPIC_CHAT}:t1`, "🙏"]]);
  });

  it("refuses to guess when the turn carries several guardian messages and none is named", async () => {
    const s = setup({ said: false });
    guardianSays(s, "a");
    guardianSays(s, "b");
    const refused = await react(s, { emoji: "👍" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("message_id");
    expect(s.reactions.size).toBe(0);
    // Named, it reacts to that one.
    expect((await react(s, { emoji: "👍", message_id: "b" })).isError).toBeFalsy();
    expect([...s.reactions]).toEqual([[`${CONCIERGE_CHAT}:b`, "👍"]]);
  });

  it("reacts to a guardian message of an earlier turn when it is named, as when the work is done", async () => {
    const s = setup({ said: false });
    s.inTurn("t0");
    guardianSays(s, "g0", "t0");
    await react(s, { emoji: "🤔" });
    s.inTurn("report-turn");
    expect((await react(s, { emoji: "✅", message_id: "g0" })).isError).toBeFalsy();
    expect([...s.reactions]).toEqual([[`${CONCIERGE_CHAT}:g0`, "✅"]]);
    // With none named, a turn without a guardian message of its own has no message to guess.
    const none = await react(s, { emoji: "✅" });
    expect(none.isError).toBe(true);
  });

  it("replaces a reaction with a new one, and clears it with null", async () => {
    const s = setup({ said: false });
    guardianSays(s, "g1");
    await react(s, { emoji: "👍" });
    await react(s, { emoji: "✅" });
    expect([...s.reactions]).toEqual([[`${CONCIERGE_CHAT}:g1`, "✅"]]);
    expect((await react(s, { emoji: null })).isError).toBeFalsy();
    expect(s.reactions.size).toBe(0);
    expect(s.deps.webchatRepo.setMessageReaction).toHaveBeenLastCalledWith(
      CONCIERGE_CHAT,
      "g1",
      null,
    );
  });

  it("refuses a message the Concierge said, one that is not in the chat, and one of another chat", async () => {
    const s = setup({ said: false });
    guardianSays(s, "g1");
    const said = JSON.parse((await s.tool("say", { text: "Sunny" })).content[0].text);
    guardianSays(s, "elsewhere", "concierge-turn-1", TOPIC_CHAT);
    for (const message_id of [said.messageId, "nope", "elsewhere"]) {
      const refused = await react(s, { emoji: "👍", message_id });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain("No guardian message");
    }
    expect(s.reactions.size).toBe(0);
  });

  it("refuses an emoji outside the set, and a call with no emoji", async () => {
    const s = setup({ said: false });
    guardianSays(s, "g1");
    // 👀 is Rome's working status, never a reaction.
    for (const input of [{ emoji: "👀" }, { emoji: "🦄" }, { emoji: "" }, {}, { emoji: 7 }]) {
      expect((await react(s, input)).isError).toBe(true);
    }
    expect(s.reactions.size).toBe(0);
  });

  it("refuses in a task chat", async () => {
    const s = setup({ said: false });
    guardianSays(s, "g1");
    const { chatId } = JSON.parse(
      (await s.tool("chat_start", { title: "Weather", brief: "Check the weather" })).content[0]
        .text,
    );
    s.turnIn(chatId);
    guardianSays(s, "t1", "concierge-turn-1", chatId);
    const refused = await react(s, { emoji: "👍" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("No Concierge chat");
    expect(s.reactions.size).toBe(0);
  });

  it("never answers the message or rings the phone", async () => {
    const s = setup({ said: false });
    guardianSays(s, "g1");
    await s.taskRepo.takeMessage("concierge-turn-1", { chatId: CONCIERGE_CHAT, messageKey: "g1" });
    const answer = rs.spyOn(s.taskRepo, "answerMessage");
    await react(s, { emoji: "👍" });
    expect(answer).not.toHaveBeenCalled();
    expect(s.answered("g1")).toBe(false);
    expect(s.pushes).toEqual([]);
    // Only a say answers it.
    await s.tool("say", { text: "Done" });
    expect(answer).toHaveBeenCalledWith(CONCIERGE_CHAT, "g1");
  });
});

describe("scheduled tasks", () => {
  const view = (report: "every_run" | "when_it_matters") => ({
    at: "12:25",
    report,
    brief: "Sum up my last day",
    nextRunAt: Date.UTC(2026, 10, 13, 4, 25),
  });
  const withSchedules = (s: ReturnType<typeof setup>, report: "every_run" | "when_it_matters") => {
    const schedules = {
      set: rs.fn(async () => {}),
      remove: rs.fn(async () => true),
      of: rs.fn(async () => view(report)),
      takeSkip: rs.fn(async () => false),
    };
    (s.deps as { schedules?: unknown }).schedules = schedules;
    return schedules;
  };
  const startScheduled = async (s: ReturnType<typeof setup>, report = "every_run") =>
    JSON.parse(
      (
        await s.tool("chat_start", {
          title: "Daily summary",
          brief: "Sum up my last day",
          schedule: { at: "12:25", report },
        })
      ).content[0].text,
    ) as { chatId: string; taskId: string; scheduled: string };

  it("starts a scheduled task's chat without running it, and schedules its brief", async () => {
    const s = setup();
    const schedules = withSchedules(s, "every_run");
    const started = await startScheduled(s);

    expect(s.posted).toEqual([]);
    expect(schedules.set).toHaveBeenCalledWith(
      { id: started.taskId, title: "Daily summary", owner: "guardian" },
      { at: "12:25", report: "every_run", brief: "Sum up my last day" },
    );
    expect(started.scheduled).toContain("2026-11-13T04:25:00.000Z");
  });

  it("runs a scheduled brief with no asking device, so a device saved by a handoff cannot pin it", async () => {
    const s = setup();
    withSchedules(s, "every_run");
    const { chatId, taskId } = await startScheduled(s);
    // A follow-up from the phone saved its device id on the task chat.
    s.askFrom("dev-signed-out");
    await s.tool("chat_send", { chatId, text: "Add my sleep too" });
    expect(s.deps.webchatRepo.setAskingDevice).toHaveBeenLastCalledWith(chatId, "dev-signed-out");
    s.fakeTimers();
    const order: string[] = [];
    rs.mocked(s.deps.webchatRepo.setAskingDevice).mockImplementation(async (_id, deviceId) => {
      order.push(`device:${deviceId}`);
    });
    const realSend = s.send.getMockImplementation()!;
    s.send.mockImplementationOnce(async (...args) => {
      order.push("send");
      return realSend(...args);
    });

    expect(await s.service.runScheduledTask(taskId, Date.now())).toBe("sent");
    // Cleared before the brief goes in, so the run's turn takes a working device.
    expect(order).toEqual(["device:null", "send"]);
  });

  it("sends each run's brief into the task's own chat as the Concierge's words, reported as its own", async () => {
    const s = setup();
    withSchedules(s, "every_run");
    const { chatId, taskId } = await startScheduled(s);
    s.fakeTimers();

    expect(await s.service.runScheduledTask(taskId, Date.now())).toBe("sent");
    expect(s.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ chat: expect.objectContaining({ id: chatId }) }),
      { text: "Sum up my last day" },
      CONCIERGE_ACCOUNT,
    );
    // Its result comes back as any task's does.
    await s.finish({ turnId: "task-turn-1", agentName: "core:main", chatId, text: "x" });
    await rs.advanceTimersByTimeAsync(3_000);
    expect(s.backendTurns).toHaveLength(1);
    expect(s.backendTurns[0]?.prompt).toContain(taskId);
  });

  it("ends only the run when its owner presses Stop in a scheduled task's chat, keeping its schedule", async () => {
    const s = setup();
    const schedules = withSchedules(s, "every_run");
    const { chatId, taskId } = await startScheduled(s);
    const cancelled: string[] = [];
    s.deps.checks = {
      cancelFor: async (id: string) => (cancelled.push(id), 0),
      laterOf: async () => new Map(),
    } as never;
    const turnedDown: string[] = [];
    s.service.attachApprovalExpiry(async (chat) => (turnedDown.push(chat), 1));
    s.fakeTimers();
    expect(await s.service.runScheduledTask(taskId, Date.now())).toBe("sent");

    // The Stop in the task chat interrupts the run's turn.
    await s.finish({
      turnId: "task-turn-1",
      agentName: "core:main",
      chatId,
      status: "interrupted",
      text: "x",
    });

    // What the run asked for is turned down; the task, its schedule and its checks stay.
    expect(turnedDown).toEqual([chatId]);
    expect(schedules.remove).not.toHaveBeenCalled();
    expect(cancelled).toEqual([]);
    expect((await s.taskRepo.get(taskId))?.stoppedAt).toBeFalsy();
    expect(await s.service.runScheduledTask(taskId, Date.now() + 86_400_000)).toBe("sent");
  });

  it("retries a stopped run's turn-down, keeping its schedule, and keeps it for the start sweep", async () => {
    const s = setup();
    const schedules = withSchedules(s, "every_run");
    const { chatId, taskId } = await startScheduled(s);
    const stored = new Map<string, unknown>();
    s.deps.settingsRepo = {
      get: async (key: string) => stored.get(key) ?? null,
      set: async (key: string, value: unknown) => void stored.set(key, value),
    } as never;
    const cutoffs: number[] = [];
    let calls = 0;
    s.service.attachApprovalExpiry(async (_chat, turnDown) => {
      calls += 1;
      if (calls === 1) throw new Error("database is locked");
      cutoffs.push(turnDown.until);
      return 1;
    });
    s.fakeTimers();
    expect(await s.service.runScheduledTask(taskId, Date.now())).toBe("sent");
    const stoppedAt = Date.now();
    await s.finish({
      turnId: "task-turn-1",
      agentName: "core:main",
      chatId,
      status: "interrupted",
      text: "x",
    });
    // The first turn-down failed: the run is kept for a start in between.
    expect(calls).toBe(1);
    expect(stored.get("conciergeStoppedRuns")).toEqual({ runs: [{ chatId, stoppedAt }] });

    // The retry turns down what the stopped run asked for, though its task was never stopped.
    await rs.advanceTimersByTimeAsync(60_000);
    expect(cutoffs).toEqual([stoppedAt]);
    expect(stored.get("conciergeStoppedRuns")).toEqual({ runs: [] });
    expect(schedules.remove).not.toHaveBeenCalled();
    expect((await s.taskRepo.get(taskId))?.stoppedAt).toBeFalsy();
  });

  it("keeps both of two stopped runs whose turn-downs fail at once, in the real settings", async () => {
    const s = setup();
    const db = createTestDb();
    opened.push(db);
    const settings = new SettingsRepository(db.db);
    s.deps.settingsRepo = settings as never;
    s.service.attachApprovalExpiry(async () => {
      throw new Error("database is locked");
    });
    const turnDown = (
      s.service as unknown as {
        turnDownForStop(chatId: string, at: number, failures: number, scope: "run"): Promise<void>;
      }
    ).turnDownForStop.bind(s.service);
    s.fakeTimers();
    await Promise.all([
      turnDown("chat-a", 1, 0, "run"),
      turnDown("chat-b", 2, 0, "run"),
      turnDown("chat-c", 3, 0, "run"),
    ]);
    expect(await settings.get("conciergeStoppedRuns")).toEqual({
      runs: [
        { chatId: "chat-a", stoppedAt: 1 },
        { chatId: "chat-b", stoppedAt: 2 },
        { chatId: "chat-c", stoppedAt: 3 },
      ],
    });
  });

  it("turns down at start what a stopped run asked for by its stop, and no later", async () => {
    const s = setup();
    const stored = new Map<string, unknown>([
      ["conciergeStoppedRuns", { runs: [{ chatId: "task-chat-9", stoppedAt: 1_000 }] }],
    ]);
    s.deps.settingsRepo = {
      get: async (key: string) => stored.get(key) ?? null,
      set: async (key: string, value: unknown) => void stored.set(key, value),
    } as never;
    const turnedDown: [string, number][] = [];
    s.service.attachApprovalExpiry(async (chat, turnDown) => {
      turnedDown.push([chat, turnDown.until]);
      return 1;
    });
    await s.settle();
    expect(turnedDown).toEqual([["task-chat-9", 1_000]]);
    expect(stored.get("conciergeStoppedRuns")).toEqual({ runs: [] });
  });

  it("keeps a scheduled task's skill and sends it with every run's brief", async () => {
    const s = setup();
    const schedules = withSchedules(s, "every_run");
    const { taskId } = JSON.parse(
      (
        await s.tool("chat_start", {
          title: "Daily summary",
          brief: "Sum up my last day",
          skill: "coding:app_creation",
          schedule: { at: "12:25" },
        })
      ).content[0].text,
    );
    expect(schedules.set).toHaveBeenCalledWith(expect.objectContaining({ id: taskId }), {
      at: "12:25",
      report: "every_run",
      brief: "Sum up my last day",
      skill: "coding:app_creation",
    });
    schedules.of.mockImplementation(async () => ({
      ...view("every_run"),
      skill: "coding:app_creation",
    }));

    expect(await s.service.runScheduledTask(taskId, Date.now())).toBe("sent");
    expect(s.send).toHaveBeenLastCalledWith(
      expect.anything(),
      { text: "Sum up my last day", skillName: "coding:app_creation" },
      CONCIERGE_ACCOUNT,
    );
  });

  it("lets a quiet run with nothing to ask go to the digest, not a report", async () => {
    const s = setup();
    withSchedules(s, "when_it_matters");
    const { chatId, taskId } = await startScheduled(s, "when_it_matters");
    s.fakeTimers();

    await s.service.runScheduledTask(taskId, Date.now());
    await s.finish({ turnId: "task-turn-1", agentName: "core:main", chatId, text: "x" });
    await rs.advanceTimersByTimeAsync(10 * 60_000);
    expect(s.backendTurns).toEqual([]);
    expect((await s.service.digestTaskNotes(CONCIERGE_CHAT, "guardian")).text).toContain(
      `<ran_on_schedule task="${taskId}"`,
    );
  });

  it("sends nothing for a stopped task, and removes its schedule", async () => {
    const s = setup();
    const schedules = withSchedules(s, "every_run");
    const { taskId } = await startScheduled(s);
    await s.service.stopTask(taskId, "guardian");
    expect(schedules.remove).toHaveBeenCalledWith(taskId);

    expect(await s.service.runScheduledTask(taskId, Date.now())).toBe("stopped");
    expect(s.posted).toEqual([]);
  });

  it("keeps a task's schedule when its owner cancels its checks from its row", async () => {
    const s = setup();
    const schedules = withSchedules(s, "every_run");
    const { taskId } = await startScheduled(s);
    const cancelFor = rs.fn(async () => 1);
    s.deps.checks = { cancelFor, laterOf: async () => new Map() } as never;

    await s.service.cancelChecksByOwner(taskId);
    // The row's cancel skips the next run only; a stop removes the schedule.
    expect(cancelFor).toHaveBeenCalledWith(taskId, "guardian", { keepSchedule: true });
    expect(schedules.remove).not.toHaveBeenCalled();
  });

  it("changes or removes a task's schedule from task_upsert, keeping its brief", async () => {
    const s = setup();
    const schedules = withSchedules(s, "every_run");
    const { taskId } = await startScheduled(s);

    await s.tool("task_upsert", {
      tasks: [{ id: taskId, schedule: { at: "08:00", days: ["mon"] } }],
    });
    expect(schedules.set).toHaveBeenLastCalledWith(
      { id: taskId, title: "Daily summary", owner: "guardian" },
      { at: "08:00", days: ["mon"], report: "every_run", brief: "Sum up my last day" },
    );
    await s.tool("task_upsert", { tasks: [{ id: taskId, schedule: null }] });
    expect(schedules.remove).toHaveBeenCalledWith(taskId);
    const listed = JSON.parse((await s.tool("task_list", { includeDone: true })).content[0].text);
    expect(listed.tasks[0]).toMatchObject({
      schedule: { at: "12:25", report: "every_run", nextRunAt: "2026-11-13T04:25:00.000Z" },
    });
  });
});
