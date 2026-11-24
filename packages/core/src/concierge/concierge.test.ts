import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { AgentPlan } from "@rome/api-types/trace-segments";
import { and, eq } from "drizzle-orm";
import { threadIdOf } from "../apps/repositories/approvals.js";
import { approvalWaits } from "../test/open-waits.js";
import { assertWidgetAlone } from "../webchat/widget-message.js";
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
import { agentCardIn } from "../chats/agent-card.js";
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
import type {
  AgentTurnFailedBeforeStart,
  TurnLifecycleListener,
  RomeToolResult,
} from "../agent/index.js";
import { CONCIERGE_REACTIONS } from "@rome/api-types/concierge";
import { startConciergeEvents } from "./events.js";
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
import { WORKING_GRACE_MS } from "./message-status.js";
import { buildConciergeTools } from "./tools.js";
import { CONNECTION_TOOLS } from "./on-connection.js";
import { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";
import {
  reportOf,
  bothAvailable,
  fakeAccounts,
  RESTRICTED_PLAN,
} from "../test/kit/model-accounts.js";
import type { ModelAccountReports, WidgetDrawing } from "../agent/index.js";
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

/** The stored content of a message that says `text`. */
const textContent = (text: string) => JSON.stringify([{ type: "text", content: text }]);

/** The key of the message task `taskId` starts at, which a say about its result replies to. */
const startKeyOf = async (
  s: { tasks: { repo: { getWithChat(id: string): Promise<unknown> } } },
  taskId: string,
) =>
  ((await s.tasks.repo.getWithChat(taskId)) as { sourceMessageId?: string | null } | null)
    ?.sourceMessageId ?? undefined;

/** What a reply to the acknowledgement, which a started task points to, quotes. */
const ACK_QUOTE = { type: "reply_to", messageId: "ack-1", author: "agent", text: "On it" };

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
  const messages: SaidMessage[] = rows.slice(start, end).map((row, index) => {
    // As Chats reads it: a card's plain-text line is its message's text.
    const card = agentCardIn(JSON.parse(row.content) as unknown[]);
    return {
      id: row.id ?? `row-${start + index}`,
      direction: row.role === "assistant" ? "fromRome" : "toRome",
      place,
      body: { text: card ? card.text : textOf(row.content) },
      at: new Date(Date.UTC(2026, 9, 29, 0, 0, start + index)),
      ...(card ? { card } : {}),
      ...(row.turnId ? { turnId: row.turnId } : {}),
    };
  });
  return {
    messages,
    older: start > 0 ? { at: messages[0].at, id: String(start) } : null,
  };
}

/** The guardian's local time every harness turn names. */
const LOCAL_NOW = "Fri 20/11/2026 09:30 (Europe/Berlin)";

/** The lines that open every Concierge turn's input in the main chat. */
const MAIN_LINE = `<concierge_chat id="concierge" name="Concierge" main="true"/>\n<concierge_owner role="guardian"/>\n<now>${LOCAL_NOW}</now>\n\n`;

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
    /** Where a failure the Concierge's own recovery could not get past goes. */
    unrecovered?: Parameters<typeof startConciergeEvents>[2] extends infer O
      ? O extends { unrecovered?: infer U }
        ? U
        : never
      : never;
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
  /** The approvals made, as the repository would find them by id. */
  const approvalRows = new Map<string, Record<string, unknown> & { threadId: string | null }>();
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
    widgets: "card" as WidgetDrawing,
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
    turnPlan: rs.fn((): AgentPlan | null => null),
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
    localNow: async () => LOCAL_NOW,
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
      updateSessionLargeModelSelection: rs.fn(
        async (id: string, largeModelSelection: string, largeModelSelectionBy: string) => {
          sessions.set(id, { ...sessions.get(id), largeModelSelection, largeModelSelectionBy });
        },
      ),
      updateSessionName: rs.fn(async (id: string, name: string) => {
        order.push("rename");
        sessions.set(id, { ...sessions.get(id), name });
        // The task is its chat, so its name is the stored chat's.
        await storedChats.updateSessionName(id, name);
      }),
      unarchiveSession: rs.fn(async (id: string) => {
        await storedChats.unarchiveSession(id);
        if (sessions.has(id)) sessions.set(id, { ...sessions.get(id), archivedAt: null });
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
          // The stores refuse a widget beside other parts.
          assertWidgetAlone(parts);
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
      widgetMessage: async (id: string) => {
        for (const [chatId, rows] of messages) {
          const row = rows.find((each) => each.id === id);
          if (row) return { chatId, content: row.content };
        }
        return null;
      },
      taskCardsOf: async () => new Map(),
      ownerSpokeAt: async () => null,
      taskChatPartMessages: async (chatId: string) =>
        (messages.get(chatId) ?? [])
          .filter((row) => row.content.includes('"task_chat"'))
          .map((row) => ({ id: String(row.id), content: row.content, createdAt: new Date() })),
    },
    tasks,
    approvals: {
      findById: async (id: string) => approvalRows.get(id) ?? null,
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
      cardIn: async (id: string) => {
        for (const [chatId, rows] of messages) {
          const row = rows.find((each) => each.id === id && each.role === "assistant");
          const card = row && agentCardIn(JSON.parse(row.content) as unknown[]);
          if (card) return { chatId, card };
        }
        return null;
      },
    },
    sessionRepository: { current: async () => ({ id: "runtime-1" }) },
    agentSessionManager: {
      find: rs.fn(() => ({ selectModel: rs.fn(), selectModelForOneTurn: rs.fn() })),
    },
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
    widgets: here.widgets,
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
      { delay: options.delay, unrecovered: options.unrecovered },
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
    /** Where the turn ran, when not the dashboard chat `chatId`. */
    threadContext?: { channel: string; threadId: string; senderBondLevel?: string };
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
          threadContext: event.threadContext ?? { channel: "webchat", threadId: event.chatId },
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
    const result = await found.handler(input);
    // A task is its task chat, so `chat_start` answers its chat's id alone. These
    // tests name the task by it too: `taskId` is the same string as `chatId`.
    if (name === "chat_start" && !result.isError) {
      const started = JSON.parse(result.content[0]!.text) as { chatId: string };
      return {
        ...result,
        content: [
          { ...result.content[0]!, text: JSON.stringify({ ...started, taskId: started.chatId }) },
        ],
      };
    }
    return result;
  };
  /**
   * Makes a task: the task chat, as a started one is, and its row. `id` names
   * the chat and the task; the title is the chat's name.
   */
  const makeTaskRow = async (input: {
    title: string;
    id?: string;
    chatId?: string | null;
    sourceMessageId?: string | null;
    ownerKey?: string | null;
  }) => {
    const id = input.id ?? `task-${++startedChats}`;
    if (!sessions.has(id) || !(await storedChats.getSession(id))) {
      await storedChats.createSession(
        id,
        input.title,
        undefined,
        undefined,
        null,
        undefined,
        null,
        "webchat",
        null,
        {
          ownerKey: input.ownerKey ?? null,
        },
      );
    }
    sessions.set(id, { id, name: input.title, triggerKind: TASK_CHAT_TRIGGER_KIND });
    return taskRepo.create(id, {
      chatId: input.chatId ?? null,
      ...(input.sourceMessageId !== undefined ? { sourceMessageId: input.sourceMessageId } : {}),
    });
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
    makeTaskRow,
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
    /** The tools run where widgets draw this way from here on. */
    drawWidgets: (widgets: WidgetDrawing) => {
      here.widgets = widgets;
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
      const row = {
        id: `approval-${approvalRows.size + 1}`,
        type: "action_execution",
        ...approval,
        threadId: threadIdOf(approval.payload),
      };
      approvalRows.set(String(row.id), row);
      for (const listener of approvalListeners) listener(row);
      return row;
    },
    /** The approval `id` as the repository holds it now. */
    approvalRow: (id: string) => approvalRows.get(id),
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
      "chat_start",
      "chat_send",
      "chat_read",
      "chat_stop",
      "chat_update",
      "chat_list",
      "topic_start",
      "card_forward",
      "connect_card",
      "show_card",
    ]);
    expect(await buildConciergeTools(on.service, on.context("core:main"))).toEqual([]);
  });

  it("register say, react and the task tools for the Concierge in a chat on a connection", async () => {
    const on = setup();
    const telegram = {
      ...on.context(),
      getThreadContext: () => ({ channel: "telegram", threadId: "123", channelUserId: "456" }),
    };
    expect((await buildConciergeTools(on.service, telegram)).map((t) => t.name)).toEqual([
      ...CONNECTION_TOOLS,
    ]);
  });

  describe("in a chat on a connection", () => {
    /** A Discord channel where the Concierge answers, as Chats keeps it. */
    const connectionChat = async (s: ReturnType<typeof setup>) => {
      const { id } = await s.storedChats.ensureChannelChat({
        channel: "discord_app",
        threadId: "900",
        threadType: "group",
        agentName: CONCIERGE_AGENT_ID,
      });
      const stored = await s.storedChats.getSession(id);
      if (stored) s.sessions.set(id, stored);
      return id;
    };
    const there = (
      s: ReturnType<typeof setup>,
      chatId: string,
      senderBondLevel: string | undefined,
    ): SessionToolContext => ({
      ...s.context(),
      channelThreadKey: "discord_app:900",
      getThreadContext: () => ({
        channel: "discord_app",
        threadId: "900",
        romeSessionId: chatId,
        threadType: "group",
        ...(senderBondLevel ? { senderBondLevel } : {}),
      }),
    });
    const run = async (
      context: SessionToolContext,
      s: ReturnType<typeof setup>,
      name: string,
      input: Record<string, unknown>,
    ) => {
      const found = (await buildConciergeTools(s.service, context)).find((t) => t.name === name);
      if (!found) throw new Error(`no tool ${name}`);
      return found.handler(input);
    };

    it("starts a task that reports to that chat, and links it by the dashboard's public address", async () => {
      const s = setup();
      const chatId = await connectionChat(s);
      const before = process.env.PANTHEON_INSTANCE_ORIGIN;
      process.env.PANTHEON_INSTANCE_ORIGIN = "https://ray.romeos.test";
      let result: Awaited<ReturnType<typeof run>>;
      try {
        result = await run(there(s, chatId, "guardian"), s, "chat_start", {
          title: "Flights",
          brief: "Find flights to Tokyo",
        });
      } finally {
        if (before === undefined) delete process.env.PANTHEON_INSTANCE_ORIGIN;
        else process.env.PANTHEON_INSTANCE_ORIGIN = before;
      }
      expect(result.isError).toBeFalsy();
      const started = JSON.parse(result.content[0]!.text) as { chatId: string; link: string };
      expect(started.link).toBe(`[Flights](https://ray.romeos.test/chat/${started.chatId})`);
      const found = await s.taskRepo.getWithChat(started.chatId);
      expect(found?.conciergeChat).toMatchObject({ id: chatId, main: false, onConnection: true });
      // Its news goes to that chat while it is live, not to the main chat.
      expect(await s.service.deliveryChat(chatId, "guardian")).toBe(chatId);
    });

    it("names the task by its title alone where the dashboard has no public address", async () => {
      const s = setup();
      const chatId = await connectionChat(s);
      const saved = { ...process.env };
      for (const key of ["PANTHEON_INSTANCE_ORIGIN", "PANTHEON_DOMAIN", "ROME_INSTANCE_SLUG"]) {
        delete process.env[key];
      }
      try {
        const result = await run(there(s, chatId, "guardian"), s, "chat_start", {
          title: "Flights",
          brief: "Find flights to Tokyo",
        });
        expect((JSON.parse(result.content[0]!.text) as { link: string }).link).toBe("Flights");
      } finally {
        process.env = saved;
      }
    });

    it("reacts to the guardian's message of the turn through the chat's account", async () => {
      const s = setup();
      const chatId = await connectionChat(s);
      const reacted: unknown[] = [];
      s.deps.reactInChat = async (chat, messageId, emoji) => {
        reacted.push([chat.channel, chat.threadId, messageId, emoji]);
      };
      s.deps.webchatRepo.getTurnChatMessages = (async () => [
        { id: "800000000000000001", role: "user" },
      ]) as never;
      const result = await run(there(s, chatId, "guardian"), s, "react", { emoji: "👍" });
      expect(result.isError).toBeFalsy();
      expect(reacted).toEqual([["discord_app", "900", "800000000000000001", "👍"]]);
      // The model sees no message ids there: an id it guessed, such as the
      // channel's, reacts to the turn's message all the same.
      await run(there(s, chatId, "guardian"), s, "react", { emoji: "❤️", message_id: "900" });
      expect(reacted[1]).toEqual(["discord_app", "900", "800000000000000001", "❤️"]);
      reacted.splice(1);
      // Anyone else's turn gets no reaction, and one cannot be taken back here.
      expect((await run(there(s, chatId, "other"), s, "react", { emoji: "👍" })).isError).toBe(
        true,
      );
      expect((await run(there(s, chatId, "guardian"), s, "react", { emoji: null })).isError).toBe(
        true,
      );
      expect(reacted).toHaveLength(1);
    });

    it("says through the chat's account, past its send gate, never into a dashboard chat", async () => {
      const s = setup();
      const chatId = await connectionChat(s);
      const said: unknown[] = [];
      s.deps.sayInChat = async (chat, message) => {
        said.push({ chat, message });
        return { sent: "800000000000000009" };
      };
      s.deps.webchatRepo.getTurnChatMessages = (async () => [
        {
          id: "800000000000000001",
          role: "user",
          content: JSON.stringify([{ type: "text", content: "@Rome hi" }]),
        },
      ]) as never;
      const result = await run(there(s, chatId, "guardian"), s, "say", { text: "Hey!" });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({
        messageId: "800000000000000009",
      });
      expect(said).toEqual([
        {
          chat: { id: chatId, channel: "discord_app", threadId: "900" },
          message: {
            text: "Hey!",
            // The turn's first message quotes the one it answers, as the inbox did.
            replyTo: "800000000000000001",
            turnId: expect.any(String),
            place: "group",
            recipient: { bondLevel: "guardian", shownName: expect.any(String), said: "@Rome hi" },
          },
        },
      ]);
      // Nothing went into a dashboard chat.
      expect(s.deps.webchatRepo.addBackendMessage).not.toHaveBeenCalled();
      // A second message of the turn quotes nothing, and an id the model
      // guessed, such as the channel's, quotes nothing either.
      await run(there(s, chatId, "guardian"), s, "say", { text: "Anything else?" });
      expect((said[1] as { message: { replyTo?: string } }).message.replyTo).toBeUndefined();
      await run(there(s, chatId, "guardian"), s, "say", { text: "Sure", replyTo: "900" });
      expect((said[2] as { message: { replyTo?: string } }).message.replyTo).toBeUndefined();
    });

    it("lets anyone's turn say something, and tells the gate whom it answers", async () => {
      const s = setup();
      const chatId = await connectionChat(s);
      const recipients: unknown[] = [];
      s.deps.sayInChat = async (_chat, message) => {
        recipients.push(message.recipient.bondLevel);
        return { sent: "1" };
      };
      s.deps.webchatRepo.getTurnChatMessages = (async () => []) as never;
      expect(
        (await run(there(s, chatId, "acquaintance"), s, "say", { text: "Hi" })).isError,
      ).toBeFalsy();
      // A turn with no sender that Rome does not run is anyone's: Envoy checks it.
      expect(
        (await run(there(s, chatId, undefined), s, "say", { text: "Hm" })).isError,
      ).toBeFalsy();
      // A task's report, which Rome runs, answers the guardian who started the task.
      s.service.runsSystemTurnIn = (id: string) => id === chatId;
      expect(
        (await run(there(s, chatId, undefined), s, "say", { text: "Done" })).isError,
      ).toBeFalsy();
      expect(recipients).toEqual(["acquaintance", "other", "guardian"]);
    });

    it("refuses private there, and tells the model what the send gate held back", async () => {
      const s = setup();
      const chatId = await connectionChat(s);
      s.deps.sayInChat = async () => ({
        notSent: "This message waits for the guardian's approval.",
      });
      s.deps.webchatRepo.getTurnChatMessages = (async () => []) as never;
      const secret = await run(there(s, chatId, "guardian"), s, "say", {
        text: "1234",
        private: true,
      });
      expect(secret.isError).toBe(true);
      expect(secret.content[0]!.text).toContain("Nothing here is private");
      const held = await run(there(s, chatId, "other"), s, "say", { text: "Hi" });
      expect(held.isError).toBeFalsy();
      expect(JSON.parse(held.content[0]!.text)).toEqual({
        sent: false,
        note: "This message waits for the guardian's approval.",
      });
    });

    it("reminds a turn there that ended on text outside say, once, and not one that ended on done", async () => {
      const s = setup();
      const chatId = await connectionChat(s);
      // The turn's session stands in that chat.
      s.deps.webchatRepo.chatOfSession = (async () => ({ id: chatId })) as never;
      const where = { channel: "discord_app", threadId: "900" };
      await s.finish({
        turnId: "c-1",
        agentName: CONCIERGE_AGENT_ID,
        chatId,
        text: "不客气～",
        threadContext: where,
      });
      expect(s.backendTurns.map((turn) => [turn.channel, turn.threadId])).toEqual([
        ["discord_app", "900"],
      ]);
      expect(s.backendTurns[0]?.prompt).toContain(NUDGE_PROMPT);
      await s.finish({
        turnId: "c-2",
        agentName: CONCIERGE_AGENT_ID,
        chatId,
        text: "done",
        threadContext: where,
      });
      expect(s.backendTurns).toHaveLength(1);
      // A reminder runs with no sender, so only the guardian's turn, or a
      // report, gets one: never another person's.
      await s.finish({
        turnId: "c-3",
        agentName: CONCIERGE_AGENT_ID,
        chatId,
        text: "hi",
        threadContext: { ...where, senderBondLevel: "acquaintance" },
      });
      expect(s.backendTurns).toHaveLength(1);
    });

    it("shows the guardian's message working while the turn works, and settles it when the turn ends", async () => {
      const s = setup();
      const chatId = await connectionChat(s);
      s.deps.webchatRepo.chatOfSession = (async () => ({ id: chatId })) as never;
      const reacted: unknown[] = [];
      s.deps.reactInChat = async (_chat, messageId, emoji) => {
        reacted.push([messageId, emoji]);
      };
      const turn = {
        agentName: CONCIERGE_AGENT_ID,
        turnId: "c-work",
        channel: "discord_app",
        chatId,
        messageKey: "800000000000000001",
        senderBondLevel: "guardian",
      };
      // Anyone else's message, and a dashboard turn, are not watched here.
      expect(s.service.observeConnectionTurn({ ...turn, senderBondLevel: "other" })).toBeNull();
      expect(s.service.observeConnectionTurn({ ...turn, channel: "webchat" })).toBeNull();
      const watch = s.service.observeConnectionTurn(turn);
      expect(watch).not.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 20));
      // Two working tool calls show it working, as on the dashboard.
      watch?.event({ type: "tool_use", tool: "web_search", id: "t1" });
      watch?.event({ type: "tool_use", tool: "web_search", id: "t2" });
      await rs.waitFor(async () =>
        expect(
          (await s.service.deps.tasks.messageStatusesOf(chatId, ["800000000000000001"])).get(
            "800000000000000001",
          ),
        ).toBe("working"),
      );
      // The turn ends having said nothing: its message settles, and showed working, so no ✅.
      await s.finish({
        turnId: "c-work",
        agentName: CONCIERGE_AGENT_ID,
        chatId,
        text: "done",
        threadContext: { channel: "discord_app", threadId: "900", senderBondLevel: "guardian" },
      });
      expect(
        (await s.service.deps.tasks.messageStatusesOf(chatId, ["800000000000000001"])).get(
          "800000000000000001",
        ),
      ).toBeUndefined();
      expect(reacted).toEqual([]);
    });

    it("reacts ✅ on the platform to a message a turn there left without any sign", async () => {
      const s = setup();
      const chatId = await connectionChat(s);
      s.deps.webchatRepo.chatOfSession = (async () => ({ id: chatId })) as never;
      const reacted: unknown[] = [];
      s.deps.reactInChat = async (chat, messageId, emoji) => {
        reacted.push([chat.threadId, messageId, emoji]);
      };
      s.service.observeConnectionTurn({
        agentName: CONCIERGE_AGENT_ID,
        turnId: "c-quiet",
        channel: "discord_app",
        chatId,
        messageKey: "800000000000000002",
        senderBondLevel: "guardian",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await s.finish({
        turnId: "c-quiet",
        agentName: CONCIERGE_AGENT_ID,
        chatId,
        text: "done",
        threadContext: { channel: "discord_app", threadId: "900", senderBondLevel: "guardian" },
      });
      await rs.waitFor(() => expect(reacted).toEqual([["900", "800000000000000002", "✅"]]));
    });

    it("refuses the task tools to anyone but the guardian", async () => {
      const s = setup();
      const chatId = await connectionChat(s);
      const result = await run(there(s, chatId, "other"), s, "chat_start", {
        title: "Flights",
        brief: "Find flights",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("Only the guardian");
    });

    it("counts a turn it runs there, such as a report, as Rome's own only while it runs", async () => {
      const s = setup();
      const chatId = await connectionChat(s);
      let during = false;
      s.onBackendTurn(() => {
        during = s.service.runsSystemTurnIn(chatId);
        return "completed";
      });
      expect(await s.service.runSystemTurn(chatId, "report")).toBe(true);
      expect(during).toBe(true);
      expect(s.service.runsSystemTurnIn(chatId)).toBe(false);
    });

    it("lets a task's report, which Rome runs, read the chat's tasks, and no other turn without a sender", async () => {
      const s = setup();
      const chatId = await connectionChat(s);
      // A turn with no sender that Rome does not run is anyone's.
      const stray = await run(there(s, chatId, undefined), s, "chat_list", { here: true });
      expect(stray.isError).toBe(true);
      s.service.runsSystemTurnIn = (id: string) => id === chatId;
      const report = await run(there(s, chatId, undefined), s, "chat_list", { here: true });
      expect(report.isError).toBeFalsy();
    });

    it("never takes a dashboard chat, also a channel row, for a chat on a connection", async () => {
      const s = setup();
      await s.storedChats.createSession(
        "topic-x",
        "Trips",
        undefined,
        undefined,
        null,
        undefined,
        CONCIERGE_AGENT_ID,
      );
      const topic = await s.storedChats.getSession("topic-x");
      if (topic) s.sessions.set("topic-x", topic);
      expect(await s.service.connectionChat("topic-x")).toBeNull();
      expect(await s.service.connectionChat(await connectionChat(s))).not.toBeNull();
    });

    it("reports to a chat the recorder opened, which stores no agent, when the Concierge answers its account", async () => {
      const s = setup();
      // Recording opens an inbound chat as main's, which is stored as no agent.
      const { id } = await s.storedChats.ensureChannelChat({
        channel: "discord_app",
        threadId: "901",
        threadType: "group",
        agentName: "main",
      });
      const stored = await s.storedChats.getSession(id);
      if (stored) s.sessions.set(id, stored);
      expect(stored?.agentName ?? null).toBeNull();
      // The account's agent decides, as the inbox routes the chat's messages.
      let answering: string | null = CONCIERGE_AGENT_ID;
      s.deps.channelAgentOf = (channel) => (channel === "discord_app" ? answering : null);
      expect(await s.service.connectionChat(id)).toMatchObject({
        channel: "discord_app",
        threadId: "901",
      });
      expect(await s.service.deliveryChat(id, "guardian")).toBe(id);
      // An account main answers is no Concierge chat: its tasks report to the main chat.
      answering = "core:main";
      expect(await s.service.connectionChat(id)).toBeNull();
      expect(await s.service.deliveryChat(id, "guardian")).not.toBe(id);
    });

    it("sends a task's report to the main chat once that chat is gone", async () => {
      const s = setup();
      expect(await s.service.deliveryChat("gone-chat", "guardian")).not.toBe("gone-chat");
    });
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

  it("says the same words in reply to two messages as two messages, one for each", async () => {
    const s = setup({ said: false });
    const idOf = (result: unknown) =>
      JSON.parse((result as { content: { text: string }[] }).content[0]!.text).messageId as string;
    s.messages.set(CONCIERGE_CHAT, [
      { id: "g1", role: "user", content: textContent("Apple?"), turnId: "concierge-turn-1" },
      { id: "g2", role: "user", content: textContent("Pear?"), turnId: "concierge-turn-1" },
    ]);
    const first = idOf(await s.tool("say", { text: "Done ✅", replyTo: "g1" }));
    const second = idOf(await s.tool("say", { text: "Done ✅", replyTo: "g2" }));
    expect(second).not.toBe(first);
    expect(s.messages.get(CONCIERGE_CHAT)).toHaveLength(4);
    // The same words in reply to the same message are still one message.
    expect(idOf(await s.tool("say", { text: "Done ✅", replyTo: "g2" }))).toBe(second);
  });

  describe("reply targets", () => {
    const rowOf = (s: ReturnType<typeof setup>, id: string) =>
      s.messages.get(CONCIERGE_CHAT)?.find((row) => row.id === id);
    const replyOf = (s: ReturnType<typeof setup>, id: string) => rowOf(s, id)?.replyTo;
    const threadOf = (s: ReturnType<typeof setup>, id: string) => rowOf(s, id)?.chatThread;
    const partsOf = (s: ReturnType<typeof setup>, id: string) =>
      JSON.parse(rowOf(s, id)?.content ?? "[]") as unknown[];
    const guardianSays = (
      s: ReturnType<typeof setup>,
      row: Partial<Row> & { id: string },
      text = "A question",
    ) => {
      const list = s.messages.get(CONCIERGE_CHAT) ?? [];
      list.push({ role: "user", content: textContent(text), turnId: "concierge-turn-1", ...row });
      s.messages.set(CONCIERGE_CHAT, list);
    };
    const saidId = (result: unknown) =>
      JSON.parse((result as { content: { text: string }[] }).content[0]!.text).messageId as string;
    /** A task of the Concierge chat whose start message is `start`. */
    const taskStartedAt = async (s: ReturnType<typeof setup>, start: string, title = "Flights") =>
      s.makeTaskRow({ title, chatId: CONCIERGE_CHAT, sourceMessageId: start });

    it("replies to nothing unless the message names one, whatever the turn holds", async () => {
      const s = setup({ said: false });
      guardianSays(s, { id: "g1" });
      const said = saidId(await s.tool("say", { text: "Sunny, 24°" }));
      expect(replyOf(s, said)).toBeUndefined();
      expect(partsOf(s, said)).toEqual([{ type: "text", content: "Sunny, 24°" }]);
      expect(s.deps.webchatRepo.addBackendMessage).toHaveBeenCalledWith(
        CONCIERGE_CHAT,
        "concierge-turn-1",
        [{ type: "text", content: "Sunny, 24°" }],
        {},
      );
    });

    it("replies to nothing when it names none, even where the guardian wrote inside a thread", async () => {
      const s = setup({ said: false });
      guardianSays(s, { id: "g0", turnId: "older" }, "Plan Kyoto");
      guardianSays(s, { id: "g1", replyTo: "g0", chatThread: "g0" }, "Add Osaka");
      const said = saidId(await s.tool("say", { text: "Added" }));
      expect(replyOf(s, said)).toBeUndefined();
      // Naming a message still replies to it.
      const named = saidId(await s.tool("say", { text: "About Kyoto", replyTo: "g0" }));
      expect(replyOf(s, named)).toBe("g0");
      // So does a null, which is how the model says it answers nothing.
      const none = saidId(await s.tool("say", { text: "Anything else?", replyTo: null }));
      expect(replyOf(s, none)).toBeUndefined();
    });

    it("shows a card with no reply, and settles the turn's only guardian message", async () => {
      const s = setup({ said: false });
      const answer = rs.spyOn(s.taskRepo, "answerMessage");
      guardianSays(s, { id: "g0", turnId: "older" }, "Plan Kyoto");
      guardianSays(s, { id: "g1", replyTo: "g0", chatThread: "g0" }, "Lay out Saturday");
      const ui = {
        components: [
          { id: "root", component: "Column", children: ["title", "s1"] },
          { id: "title", component: "Text", text: "Saturday in Kyoto", variant: "h3" },
          { id: "s1", component: "Text", text: "9:00 Fushimi Inari" },
        ],
      };
      const result = await s.tool("show_card", { ui, text: "Saturday: 9:00 Fushimi Inari" });
      expect(result.isError).toBeFalsy();
      const card = saidId(result);
      expect(replyOf(s, card)).toBeUndefined();
      expect(partsOf(s, card)).toEqual([
        expect.objectContaining({ type: "widget", appId: "core", ui }),
      ]);
      expect(answer).toHaveBeenCalledWith(CONCIERGE_CHAT, "g1");
    });

    it("replies to the guardian message it names, and shows its quote", async () => {
      const s = setup({ said: false });
      guardianSays(s, { id: "g1" }, "Weather?");
      guardianSays(s, { id: "g2" }, "And Friday?");
      const said = saidId(await s.tool("say", { text: "About the first", replyTo: "g1" }));
      expect(replyOf(s, said)).toBe("g1");
      expect(threadOf(s, said)).toBe("g1");
      expect(partsOf(s, said)).toEqual([
        { type: "reply_to", messageId: "g1", author: "guardian", text: "Weather?" },
        { type: "text", content: "About the first" },
      ]);
      expect(s.deps.webchatRepo.addBackendMessage).toHaveBeenCalledWith(
        CONCIERGE_CHAT,
        "concierge-turn-1",
        expect.any(Array),
        { replyTo: "g1" },
      );
    });

    it("replies to a message of an earlier turn, its own, or a reply, and joins that thread", async () => {
      const s = setup({ said: false });
      guardianSays(s, { id: "g0", turnId: "older" }, "Plan Kyoto");
      guardianSays(s, { id: "g1", replyTo: "g0", chatThread: "g0" }, "Add Osaka");
      const first = saidId(await s.tool("say", { text: "Added", replyTo: "g1" }));
      expect([replyOf(s, first), threadOf(s, first)]).toEqual(["g1", "g0"]);
      // The agent's own message is a target too, and its quote reads as the agent's.
      const second = saidId(await s.tool("say", { text: "Anything else?", replyTo: first }));
      expect([replyOf(s, second), threadOf(s, second)]).toEqual([first, "g0"]);
      expect(partsOf(s, second)[0]).toEqual({
        type: "reply_to",
        messageId: first,
        author: "agent",
        text: "Added",
      });
    });

    it("refuses a message of no turn of this chat, and says nothing", async () => {
      const s = setup({ said: false });
      guardianSays(s, { id: "g1" });
      const result = await s.tool("say", { text: "x", replyTo: "elsewhere" });
      expect(result.isError).toBe(true);
      expect(s.deps.webchatRepo.addBackendMessage).not.toHaveBeenCalled();
    });

    describe("a card it shows", () => {
      const question = {
        type: "pending_interaction",
        toolUseId: "tu-ask",
        appId: "core",
        render: { kind: "inline", componentId: "question-card", builtin: true },
      } as const;

      it("replies to nothing when it names none, even where the guardian wrote inside a thread, with no quote", async () => {
        const s = setup({ said: false });
        guardianSays(s, { id: "g0", turnId: "older" }, "Plan Kyoto");
        guardianSays(s, { id: "g1", replyTo: "g0", chatThread: "g0" }, "Add Osaka");
        const card = await s.service.addCard(CONCIERGE_CHAT, "concierge-turn-1", question);
        expect(replyOf(s, card)).toBeUndefined();
        // A card is a message of its own: no quote beside it.
        expect(partsOf(s, card)).toEqual([question]);
      });

      it("replies to the message it names, a task's start message in a turn with no guardian message", async () => {
        const s = setup({ said: false });
        guardianSays(s, { id: "g0", turnId: "older" }, "Book flights");
        const task = await taskStartedAt(s, "g0");
        const named = await s.service.addCard(
          CONCIERGE_CHAT,
          "concierge-turn-1",
          question,
          await startKeyOf(s, task.id),
        );
        expect([replyOf(s, named), threadOf(s, named)]).toEqual(["g0", "g0"]);
        // A name that is no message of the chat is dropped: the card still shows, replying to nothing.
        const dropped = await s.service.addCard(
          CONCIERGE_CHAT,
          "concierge-turn-1",
          question,
          "elsewhere",
        );
        expect(replyOf(s, dropped)).toBeUndefined();
        expect(partsOf(s, dropped)).toEqual([question]);
      });
    });

    it("quotes an automation's message as the automation's", async () => {
      const s = setup({ said: false });
      guardianSays(s, { id: "a1", senderId: "automated::0::routine:daily" }, "Daily digest");
      const said = saidId(await s.tool("say", { text: "Noted", replyTo: "a1" }));
      expect(partsOf(s, said)[0]).toMatchObject({ messageId: "a1", author: "automated" });
    });

    it("replies without a quote to a message that has no text", async () => {
      const s = setup({ said: false });
      guardianSays(s, { id: "g1", content: "[]" });
      const said = saidId(await s.tool("say", { text: "Seen", replyTo: "g1" }));
      expect(replyOf(s, said)).toBe("g1");
      expect(partsOf(s, said)).toEqual([{ type: "text", content: "Seen" }]);
    });

    it("tells a task's result when it replies to the task's start message", async () => {
      const s = setup({ said: false });
      const noted = rs.spyOn(s.service, "noteSaid");
      const task = await taskStartedAt(s, "g0");
      guardianSays(s, { id: "g0", turnId: "older" }, "Find flights");
      guardianSays(s, { id: "g1" });
      const said = saidId(await s.tool("say", { text: "Found 3 flights", replyTo: "g0" }));
      expect([replyOf(s, said), threadOf(s, said)]).toEqual(["g0", "g0"]);
      expect(noted).toHaveBeenCalledWith(task.id);
    });

    it("tells no task's result when its start message is shared, unless the turn reports one", async () => {
      const s = setup({ said: false });
      const noted = rs.spyOn(s.service, "noteSaid");
      const flights = await taskStartedAt(s, "g0");
      await taskStartedAt(s, "g0", "Hotels");
      guardianSays(s, { id: "g0", turnId: "older" }, "Plan the trip");
      await s.tool("say", { text: "Update", replyTo: "g0" });
      expect(noted).not.toHaveBeenCalled();
      s.inTurn("report");
      s.reportedTask(flights.id);
      await s.tool("say", { text: "Found 3 flights", replyTo: "g0" });
      expect(noted).toHaveBeenCalledOnce();
      expect(noted).toHaveBeenCalledWith(flights.id);
    });

    /** The turn `turn` starts task "Flights" for the guardian message `g0`. */
    const startTask = async (s: ReturnType<typeof setup>, turn = "ask") => {
      s.inTurn(turn);
      guardianSays(s, { id: "g0", turnId: turn }, "Find flights");
      const ack = saidId(await s.tool("say", { text: "On it", replyTo: "g0" }));
      const started = JSON.parse(
        (await s.tool("chat_start", { title: "Flights", brief: "Find flights" })).content[0].text,
      ) as { chatId: string; taskId: string };
      return { ...started, ack };
    };

    it("starts a task at its acknowledgement, and the task's result replies to the start message", async () => {
      const s = setup({ said: false });
      const { taskId, ack } = await startTask(s);
      expect((await s.tasks.repo.getWithChat(taskId))?.sourceMessageId).toBe(ack);
      expect([replyOf(s, ack), threadOf(s, ack)]).toEqual(["g0", "g0"]);

      s.inTurn("result");
      s.reportedTask(taskId);
      const told = saidId(await s.tool("say", { text: "Found 3 flights", replyTo: ack }));
      expect([replyOf(s, told), threadOf(s, told)]).toEqual([ack, "g0"]);
      // It shows the quote of the message it replies to.
      expect(partsOf(s, told)[0]).toEqual({
        type: "reply_to",
        messageId: ack,
        author: "agent",
        text: "On it",
      });
    });

    it("tells no result for a task another Concierge chat owns", async () => {
      const s = setup({ said: false });
      await s.storedChats.createSession(CONCIERGE_CHAT, "Concierge");
      await s.storedChats.createSession(TOPIC_CHAT, "Calendar");
      const noted = rs.spyOn(s.service, "noteSaid");
      await taskStartedAt(s, "g0");
      s.turnIn(TOPIC_CHAT);
      s.messages.set(TOPIC_CHAT, [
        { id: "t1", role: "user", content: textContent("Hi"), turnId: "concierge-turn-1" },
      ]);
      await s.tool("say", { text: "Found 3 flights", replyTo: "t1" });
      expect(noted).not.toHaveBeenCalled();
    });

    it("starts a task for the guardian message, not for another task's report said in the same turn", async () => {
      const s = setup({ said: false });
      const flights = await startTask(s);
      // One turn holds the owner's new request and the flights task's news.
      s.inTurn("mixed");
      guardianSays(s, { id: "g1", turnId: "mixed" });
      await s.tool("say", { text: "Found 3 flights", replyTo: flights.ack });
      const hotels = JSON.parse(
        (await s.tool("chat_start", { title: "Hotels", brief: "Find hotels" })).content[0].text,
      ) as { taskId: string };
      expect((await s.tasks.repo.getWithChat(hotels.taskId))?.sourceMessageId).toBe("g1");
      // With an acknowledgement of the guardian's message said first, the task starts at it.
      const ack = saidId(await s.tool("say", { text: "On it", replyTo: "g1" }));
      const maps = JSON.parse(
        (await s.tool("chat_start", { title: "Maps", brief: "Find maps" })).content[0].text,
      ) as { taskId: string };
      expect((await s.tasks.repo.getWithChat(maps.taskId))?.sourceMessageId).toBe(ack);
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
      // chat_send takes the words for the task, and which guardian message it passes on: no thread.
      const send = (await buildConciergeTools(s.service, s.context())).find(
        (tool) => tool.name === "chat_send",
      )!;
      expect(Object.keys((send.inputSchema as { properties: object }).properties)).toEqual([
        "chatId",
        "text",
        "answers",
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
      const result = saidId(await s.tool("say", { text: "Two hotels", replyTo: "g0" }));
      expect(threadOf(s, result)).toBe("g0");
    });

    it("takes only the message to reply to, no task and no answers", async () => {
      const s = setup({ said: false });
      const say = (await buildConciergeTools(s.service, s.context())).find(
        (tool) => tool.name === "say",
      )!;
      expect(Object.keys((say.inputSchema as { properties: object }).properties)).toEqual([
        "text",
        "format",
        "private",
        "replyTo",
      ]);
    });

    it("lists a task's start message for the Concierge to reply to", async () => {
      const s = setup({ said: false });
      const { taskId, ack } = await startTask(s);
      const listed = JSON.parse((await s.tool("chat_list", {})).content[0].text) as {
        chatId: string;
        startMessageId?: string;
      }[];
      expect(listed.find((chat) => chat.chatId === taskId)?.startMessageId).toBe(ack);
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
      const row = await s.makeTaskRow({
        title: "Flights",
        chatId: CONCIERGE_CHAT,
        sourceMessageId: "ack-1",
      });
      const other = await s.makeTaskRow({
        title: "Hotels",
        chatId: CONCIERGE_CHAT,
        sourceMessageId: "ack-1",
      });
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
        `<task_events>\n<task chat_id="${row!.id}" title="Flights">\nguardian: see task:${other!.id}\n</task>\n</task_events>`,
        [row!.id],
      );
      expect(resolved.reportedTask).toBe(row!.id);
      // A defer wake-up names its task in Rome's header, not in its note.
      const woken = await turn(
        `⏰ Time's up\n<defer_note scheduled_at="2026-11-12T09:00:00.000Z" chat_id="${row!.id}">\nCompare with task:${other!.id} and chat_id="${other!.id}"\n</defer_note>`,
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

  it("chat_start makes the task chat before its first turn, names it, and names it again after", async () => {
    const s = setup();
    const result = await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    expect(JSON.parse(result.content[0].text)).toEqual({
      chatId: "task-1",
      taskId: "task-1",
      link: "[Flights](#rome-task=task-1)",
    });
    // The chat is marked and named before the first turn, and named again once
    // the brief is sent, which would rename it.
    expect(s.order).toEqual(["trigger", "rename", "post", "rename"]);
    expect(s.send).toHaveBeenCalledWith(
      { chat: { platform: "webchat", id: "task-1" } },
      { text: "Find flights" },
      CONCIERGE_ACCOUNT,
    );
    // Nothing is copied into the Concierge chat: the link is the Concierge's own to say.
    expect(s.messages.get(CONCIERGE_CHAT)).toBeUndefined();
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
    expect(s.order).toEqual(["trigger", "rename", "post", "rename"]);
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
    const result = await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual({
      chatId: "task-1",
      taskId: "task-1",
      link: "[Flights](#rome-task=task-1)",
    });
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

  it("chat_start runs a task on the strength and effort it names, on the default provider whoever picked the Concierge chat's model", async () => {
    const s = setup();
    s.service.deps.defaults = { current: () => "anthropic" };
    s.sessions.set(CONCIERGE_CHAT, {
      id: CONCIERGE_CHAT,
      largeModelSelection: "claude-opus-5-5",
      largeModelSelectionBy: "owner",
    });
    await s.tool("chat_start", {
      title: "Hours",
      brief: "Find the hours",
      model: "fast",
      effort: "low",
    });
    expect(s.chats.startChat).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: "claude-sonnet", reasoningEffort: "low" }),
      "guardian",
    );
    await s.tool("chat_start", { title: "Plan", brief: "Plan it", model: "strong" });
    expect(s.chats.startChat).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: "claude-opus-5-5" }),
      "guardian",
    );
    // Left out, a task runs as task chats always have: by its agent's tier.
    await s.tool("chat_start", { title: "Other", brief: "Other" });
    expect(s.chats.startChat).toHaveBeenLastCalledWith(
      { agentName: undefined, projectPath: undefined },
      "guardian",
    );
    const refused = await s.tool("chat_start", { title: "X", brief: "X", model: "huge" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("model must be one of fast, strong");
  });

  it("chat_start runs a task on the default provider when Rome chose the Concierge chat's model", async () => {
    const s = setup();
    s.service.deps.defaults = { current: () => "anthropic" };
    s.sessions.set(CONCIERGE_CHAT, {
      id: CONCIERGE_CHAT,
      largeModelSelection: "gpt-6-1-sol",
      largeModelSelectionBy: "auto",
    });
    await s.tool("chat_start", { title: "Hours", brief: "Find the hours", model: "fast" });
    expect(s.chats.startChat).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: "claude-sonnet" }),
      "guardian",
    );
    // With no default, a task runs by its agent's tier.
    s.service.deps.defaults = undefined;
    await s.tool("chat_start", { title: "Plan", brief: "Plan it", model: "strong" });
    expect(s.chats.startChat).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ model: expect.anything() }),
      "guardian",
    );
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

  it("chat_read shows a running task chat's plan, the step in progress in view and each step on one short line", async () => {
    const s = setup();
    await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    const steps: AgentPlan["steps"] = Array.from({ length: 12 }, (_, index) => ({
      text: `Step ${index + 1}`,
      status: index < 9 ? "completed" : index === 9 ? "in_progress" : "pending",
    }));
    steps[9] = { ...steps[9], text: `Compare\nthe fares ${"x".repeat(100)}` };
    s.chats.turnPlan = () => ({ steps });
    const read = async () =>
      JSON.parse((await s.tool("chat_read", { chatId: "task-1" })).content[0].text);

    // Idle, it has no plan to show, whatever the runtime holds.
    expect((await read()).plan).toBeUndefined();

    s.chats.isRunning = () => true;
    const { plan } = await read();
    expect(plan).toHaveLength(8);
    expect(plan[0]).toEqual({ step: "Step 5", status: "completed" });
    expect(plan[5]).toEqual({
      step: `Compare the fares ${"x".repeat(61)}…`,
      status: "in_progress",
    });
    expect(plan[5].step).toHaveLength(80);
    expect(plan[7]).toEqual({ step: "Step 12", status: "pending" });

    // A turn with no plan shows none.
    s.chats.turnPlan = () => null;
    expect((await read()).plan).toBeUndefined();
  });

  it("chat_read and chat_list call a task chat whose latest turn failed failed, unless it runs or waits", async () => {
    const s = setup();
    await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    const status = async () =>
      JSON.parse((await s.tool("chat_read", { chatId: "task-1" })).content[0].text).status;
    s.sessions.set("task-1", { ...s.sessions.get("task-1"), lastTurnFailed: true });
    expect(await status()).toBe("failed");
    // chat_list reads Rome's derived status: the failed turn ended the task failed.
    s.chats.activeTurns = () => [];
    s.chats.isRunning = () => false;
    await s.taskRepo.setLastOutcome("task-1", "failed", new Date(), { reported: false });
    const failed = await s.tool("chat_list", { status: "ended" });
    expect(JSON.parse(failed.content[0].text)).toMatchObject([
      { chatId: "task-1", status: "ended", endReason: "failed" },
    ]);

    s.sessions.set("task-1", { ...s.sessions.get("task-1"), awaitingGuardian: true });
    expect(await status()).toBe("waiting_input");
    s.chats.isRunning = () => true;
    expect(await status()).toBe("running");
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
    expect(await s.taskRepo.get(taskId)).toMatchObject({ stoppedAt: expect.any(Date) });
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
    // A chat still in use keeps its approvals: one archived after its task
    // ended, and one taken up again after its archive stopped the task.
    await s.taskRepo.setLastOutcome(open.taskId, "succeeded", new Date(), { reported: false });
    await s.storedChats.archiveSession(open.chatId);
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
    await s.storedChats.unarchiveSession(restored.chatId);
    await s.service.restoreTaskChat(restored.chatId);
    turnedDown.length = 0;
    // A chat whose task ended and was only archived afterwards keeps its approvals.
    ask(open.chatId);
    await s.settle();
    expect(turnedDown).toEqual([]);
    // An unarchived chat's task stays stopped until new words reach it.
    ask(restored.chatId);
    await s.settle();
    expect(turnedDown).toEqual([[restored.chatId, RESOLVED_BY_STOP]]);
    await s.service.resumeTaskChat(restored.chatId);
    turnedDown.length = 0;
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

  it("marks a task done for its owner: it ends done, its work stops, and the Concierge hears of it quietly", async () => {
    const s = setup();
    const { chatId, taskId } = JSON.parse(
      (await s.tool("chat_start", { title: "Flights", brief: "Find" })).content[0].text,
    );
    await s.settle();
    s.chats.activeTurns = (id: string) => (id === chatId ? ["t1"] : []);
    const interrupted: string[] = [];
    s.chats.interruptTurn = async (turnId: string) => {
      interrupted.push(turnId);
    };
    const turnedDown: string[] = [];
    s.service.attachApprovalExpiry(async (chat) => (turnedDown.push(chat), 1));
    const pending = () =>
      (s.service as unknown as { taskEvents: { pending: string[] } }).taskEvents.pending;

    expect(await s.service.markTaskDone(taskId)).toBe(true);
    expect(interrupted).toEqual(["t1"]);
    expect(turnedDown).toEqual([chatId]);
    expect(pending()).toContain(taskId);
    // The turn it stopped ends after it, as stopped, and leaves it done.
    await s.taskRepo.setLastOutcome(taskId, "stopped");
    const row = await s.taskRepo.get(taskId);
    expect(row).toMatchObject({ stoppedAt: expect.any(Date), lastOutcome: "done_by_owner" });
    // One already ended is not marked again.
    expect(await s.service.markTaskDone(taskId)).toBe(false);
  });

  it("tells the Concierge quietly when the owner cancels a task's check from the chat's checks", async () => {
    const s = setup();
    const row = await s.makeTaskRow({ title: "PR 42", chatId: CONCIERGE_CHAT });
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
    await s.tool("chat_update", { chatId: taskId, archived: true });
    expect(await s.taskRepo.get(taskId)).toMatchObject({
      stoppedAt: expect.any(Date),
      archivedAt: expect.any(Date),
    });
    s.chats.activeTurns = () => [];
    const done = await s.makeTaskRow({ title: "Done" });
    await s.taskRepo.setLastOutcome(done.id, "succeeded", new Date(), { reported: false });
    await s.tool("chat_update", { chatId: done.id, archived: true });
    expect((await s.taskRepo.get(done.id))?.stoppedAt).toBeNull();
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
    expect(await s.taskRepo.get(taskId)).toMatchObject({ stoppedAt: expect.any(Date) });
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
    expect(await s.taskRepo.get(open.taskId)).toMatchObject({ stoppedAt: expect.any(Date) });
    // A task whose chat is deleted goes with it.
    expect(await s.taskRepo.get(done.taskId)).toBeNull();
  });

  it("takes a stopped task up again when its owner types in its chat, or the Concierge sends to it", async () => {
    const s = setup();
    const { chatId, taskId } = JSON.parse(
      (await s.tool("chat_start", { title: "Flights", brief: "Find" })).content[0].text,
    );
    await s.service.stopTask(taskId, "concierge");
    await s.service.resumeTaskChat(chatId);
    expect((await s.taskRepo.get(taskId))?.stoppedAt).toBeNull();

    // New words from the Concierge take it up again too.
    await s.service.stopTask(taskId, "concierge");
    await s.tool("chat_send", { chatId, text: "Go on" });
    expect((await s.taskRepo.get(taskId))?.stoppedAt).toBeNull();
  });

  it("chat_start whose first turn cannot start leaves a task chat that ended failed, and no second task on retry", async () => {
    const s = setup();
    const error = "The chat cannot take a message";
    s.refuseSends({ ok: false, error, delivery: { state: "failed", error, at: new Date(0) } });
    const result = await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("did not start and ended failed");
    // The chat stays, named, for its owner to read what went wrong in.
    expect(await s.storedChats.getSession("task-1")).toMatchObject({ name: "Flights" });
    const [row] = await s.tasks.repo.listForAgent(true);
    expect(row.row).toMatchObject({ id: "task-1", title: "Flights", lastOutcome: "failed" });
    // Ended·failed, with nothing waiting to be reported.
    expect((await s.tasks.statusOf([row.row])).get("task-1")).toMatchObject({
      status: "ended",
      endReason: "failed",
    });
    expect(row.row.outcomeUnsaid).toBe(false);

    const retry = await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    expect(retry.isError).toBe(true);
    expect(retry.content[0].text).toContain("Task chat task-1 already failed to start");
    // A retry that renames the task is the same start.
    const renamed = await s.tool("chat_start", { title: "Flight search", brief: "Find flights" });
    expect(renamed.content[0].text).toContain("Task chat task-1 already failed to start");
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
    expect(JSON.parse(result.content[0].text)).toMatchObject([
      { chatId: TOPIC_CHAT, title: "Calendar", kind: "topic chat" },
      {
        chatId: "task-1",
        title: "Flights",
        kind: "task chat",
        link: "[Flights](#rome-task=task-1)",
        from: CONCIERGE_CHAT,
        status: "active",
      },
      {
        chatId: "task-2",
        title: "Agenda",
        kind: "task chat",
        link: "[Agenda](#rome-task=task-2)",
        from: TOPIC_CHAT,
        status: "active",
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
    const active = await s.tool("chat_list", { status: "active" });
    expect(JSON.parse(active.content[0].text).map((chat: { kind: string }) => chat.kind)).toEqual([
      "task chat",
      "task chat",
    ]);
  });

  it("chat_list with here lists only the task chats started from the chat the turn is in", async () => {
    const s = setup();
    await s.storedChats.createSession(TOPIC_CHAT, "Calendar");
    await s.tool("chat_start", { title: "Flights", brief: "Find flights" });
    s.turnIn(TOPIC_CHAT);
    await s.tool("chat_start", { title: "Agenda", brief: "Read the calendar" });
    const titles = async (input: Record<string, unknown>) =>
      JSON.parse((await s.tool("chat_list", input)).content[0].text).map(
        (chat: { title: string }) => chat.title,
      );
    // No other Concierge chat and no task from another chat.
    expect(await titles({ here: true })).toEqual(["Agenda"]);
    expect(await titles({ here: true, status: "active" })).toEqual(["Agenda"]);
    // Without it, everything as before.
    expect(await titles({})).toEqual(["Concierge", "Flights", "Agenda"]);
    s.turnIn(CONCIERGE_CHAT);
    expect(await titles({ here: true })).toEqual(["Flights"]);
  });

  it("chat_list with recentlyEnded adds the task chats that ended in the last day, with when", async () => {
    const s = setup();
    const { taskId } = JSON.parse(
      (await s.tool("chat_start", { title: "Flights", brief: "Find flights" })).content[0].text,
    );
    await s.tool("chat_start", { title: "Hotels", brief: "Find hotels" });
    await s.tool("chat_stop", { chatId: taskId });
    const tasks = async () =>
      JSON.parse((await s.tool("chat_list", { recentlyEnded: true })).content[0].text).filter(
        (chat: { kind: string }) => chat.kind === "task chat",
      );
    const listed = await tasks();
    expect(listed.map((chat: { title: string }) => chat.title)).toEqual(["Flights", "Hotels"]);
    expect(listed[0]).toMatchObject({ status: "ended", endedAt: expect.any(String) });
    expect(listed[1]).not.toHaveProperty("endedAt");
    // A day later it is no longer recent.
    const now = Date.now();
    const later = rs.spyOn(Date, "now").mockReturnValue(now + 25 * 60 * 60 * 1000);
    try {
      expect((await tasks()).map((chat: { title: string }) => chat.title)).toEqual(["Hotels"]);
    } finally {
      later.mockRestore();
    }
  });

  it("chat_list leaves out an ended task's chat unless asked", async () => {
    const s = setup();
    const { taskId } = JSON.parse(
      (await s.tool("chat_start", { title: "Flights", brief: "Find flights" })).content[0].text,
    );
    await s.tool("chat_start", { title: "Hotels", brief: "Find hotels" });
    await s.tool("chat_stop", { chatId: taskId });
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
    s.service.deps.defaults = { current: () => "anthropic" };
    const result = await s.tool("topic_start", { name: "Trips" });
    const started = JSON.parse(result.content[0].text) as { chatId: string; link: string };
    expect(started.link).toBe(`/chat/${started.chatId}`);
    expect(s.deps.webchatRepo.createSession).toHaveBeenCalledWith(
      started.chatId,
      "Trips",
      undefined,
      undefined,
      // The main chat has no stored model, so the default provider's strong model.
      "claude-opus-5-5",
      undefined,
      CONCIERGE_AGENT_ID,
      "webchat",
      null,
      { ownerKey: "guardian" },
      null,
      "auto",
    );
  });

  it("chat_start asks for a brief written in the guardian's language", async () => {
    const s = setup();
    const tools = await buildConciergeTools(s.service, s.context());
    const start = tools.find((candidate) => candidate.name === "chat_start")!;
    expect(JSON.stringify(start.inputSchema)).toContain("written in the guardian's language");
  });

  describe("card_forward sends a card of a task chat by its id", () => {
    const text = (result: RomeToolResult) => JSON.parse(result.content[0].text);
    const stored = (s: ReturnType<typeof setup>) =>
      (s.messages.get(CONCIERGE_CHAT) ?? []).map((row) => JSON.parse(row.content));
    const HEALTH = {
      components: [
        { id: "root", component: "Row", children: ["sleep", "hr"] },
        {
          id: "sleep",
          component: "Stat",
          label: "Sleep",
          value: 6.1,
          unit: "h",
          range: { low: 7, high: 9 },
        },
        {
          id: "hr",
          component: "Stat",
          label: "Resting HR",
          value: 58,
          unit: "bpm",
          range: { low: 50, high: 65 },
        },
      ],
    };
    const LINE = "Sleep 6.1 h (usual 7–9), resting HR 58 bpm (usual 50–65).";
    const cardRow = (id: string, line = LINE, ui: unknown = HEALTH, turnId = "task-turn-1") => ({
      id,
      role: "assistant",
      turnId,
      content: JSON.stringify([
        { type: "widget", toolUseId: "task-call-1", appId: "core", text: line, ui },
      ]),
    });
    const textRow = (content: string, turnId = "task-turn-1") => ({
      role: "assistant",
      turnId,
      content: JSON.stringify([{ type: "text", content }]),
    });
    /** A started task chat "Health" with `rows` as its messages. */
    const withRows = async (...rows: Row[]) => {
      const s = setup();
      await s.tool("chat_start", { title: "Health", brief: "Daily health summary" });
      s.messages.get("task-1")?.push(...rows);
      return s;
    };
    const widgets = (s: ReturnType<typeof setup>) =>
      stored(s).filter((parts) => parts[0]?.type === "widget");
    const QUESTIONS = [
      { id: "airport", question: "Which airport?", type: "single", options: ["LIS", "OPO"] },
    ];
    const questionRow = (id: string, render: Record<string, unknown> = {}) => ({
      id,
      role: "assistant",
      turnId: "task-turn-1",
      content: JSON.stringify([
        {
          type: "pending_interaction",
          toolUseId: "task-ask-1",
          appId: "core",
          render: {
            kind: "inline",
            builtin: true,
            componentId: "question-card",
            props: { questions: QUESTIONS },
            ...render,
          },
        },
      ]),
    });

    it("forwards a task's question card as the card itself, which answers the task's own card", async () => {
      const s = await withRows(questionRow("ask-1"));
      const result = text(await s.tool("card_forward", { cardId: "ask-1" }));
      expect(result).toMatchObject({ forwarded: "card" });
      const row = s.messages.get(CONCIERGE_CHAT)?.at(-1);
      expect(JSON.parse(row?.content ?? "[]")).toEqual([
        {
          type: "task_chat",
          chatId: "task-1",
          title: "Health",
          show: "ask",
          waitedOn: { kind: "question", id: "task-ask-1", messageId: "ask-1" },
        },
      ]);
      expect(row?.replyTo).toBe("ack-1");
      // Twice in one turn is one message.
      expect(text(await s.tool("card_forward", { cardId: "ask-1" })).messageId).toBe(
        result.messageId,
      );
    });

    it("sends a question card's questions as words where this chat cannot draw cards", async () => {
      const s = await withRows(questionRow("ask-1"));
      s.drawWidgets("plain_text");
      expect(text(await s.tool("card_forward", { cardId: "ask-1" }))).toMatchObject({
        forwarded: "card_text",
      });
      const parts = JSON.parse(s.messages.get(CONCIERGE_CHAT)?.at(-1)?.content ?? "[]");
      expect(parts.find((part: { type: string }) => part.type === "text")?.content).toBe(
        "[Health](#rome-task=task-1): Which airport? (options: LIS | OPO)",
      );
    });

    it("refuses an app's own card and a card of a chat that is not its task chat", async () => {
      const s = await withRows(questionRow("app-1", { builtin: false, componentId: "today" }));
      expect((await s.tool("card_forward", { cardId: "app-1" })).isError).toBe(true);
      s.messages.get(CONCIERGE_CHAT)?.push(questionRow("own-1"));
      expect((await s.tool("card_forward", { cardId: "own-1" })).isError).toBe(true);
      expect(stored(s).some((parts) => parts[0]?.type === "task_chat")).toBe(false);
    });

    /** A pending approval asked in the task chat `chatId`. */
    const askApproval = (
      s: ReturnType<typeof setup>,
      chatId: string,
      extra: Record<string, unknown> = {},
    ) =>
      s.createApproval({
        status: "pending",
        description: "Send the booking email",
        payload: { channelContext: { threadId: chatId } },
        ...extra,
      });

    it("forwards a task's pending approval as the card itself, and decides nothing", async () => {
      const s = await withRows();
      const asked = askApproval(s, "task-1");
      const result = text(await s.tool("card_forward", { cardId: String(asked.id) }));
      expect(result).toMatchObject({ forwarded: "card" });
      const row = s.messages.get(CONCIERGE_CHAT)?.at(-1);
      expect(JSON.parse(row?.content ?? "[]")).toEqual([
        {
          type: "task_chat",
          chatId: "task-1",
          title: "Health",
          show: "ask",
          waitedOn: { kind: "approval", id: asked.id },
        },
      ]);
      expect(row?.replyTo).toBe("ack-1");
      // Twice in one turn is one message.
      expect(text(await s.tool("card_forward", { cardId: String(asked.id) })).messageId).toBe(
        result.messageId,
      );
      expect(stored(s).filter((parts) => parts[0]?.type === "task_chat")).toHaveLength(1);
      // Only the guardian's tap decides it.
      expect(s.approvalRow(String(asked.id))?.status).toBe("pending");
    });

    it("refuses an approval where this chat cannot draw cards, and names the task chat", async () => {
      const s = await withRows();
      const asked = askApproval(s, "task-1");
      s.drawWidgets("plain_text");
      const before = stored(s).length;
      const result = await s.tool("card_forward", { cardId: String(asked.id) });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("decide it in the task chat");
      expect(stored(s)).toHaveLength(before);
      expect(s.approvalRow(String(asked.id))?.status).toBe("pending");
    });

    it("refuses an approval already decided, one outside a task chat, one of another Concierge chat's task, and an unknown id", async () => {
      const s = await withRows();
      await s.storedChats.createSession(TOPIC_CHAT, "Calendar");
      s.messages.set(TOPIC_CHAT, [{ id: "t0", role: "user", content: "[]", turnId: "ask" }]);
      const decided = askApproval(s, "task-1", { status: "approved" });
      const outside = askApproval(s, CONCIERGE_CHAT);
      const other = askApproval(s, "task-1");
      const before = stored(s).length;
      const refused = async (cardId: string) => {
        const result = await s.tool("card_forward", { cardId });
        expect(result.isError).toBe(true);
        return result.content[0].text as string;
      };

      expect(await refused(String(decided.id))).toContain("already decided");
      expect(await refused(String(outside.id))).toContain("No card");
      expect(await refused("no-such-approval")).toContain("No card");
      // Another Concierge chat's turn may not forward this chat's task's approval.
      s.turnIn(TOPIC_CHAT);
      s.inTurn("ask");
      expect(await refused(String(other.id))).toContain("belongs to another Concierge chat");
      expect(stored(s)).toHaveLength(before);
      expect(s.messages.get(TOPIC_CHAT)).toHaveLength(1);
    });

    it("forwards the card itself, issued again, alone in its message and replying to the task's start", async () => {
      const s = await withRows(cardRow("card-1"), textRow(concluded("Your daily health summary.")));
      const result = text(await s.tool("card_forward", { cardId: "card-1" }));
      expect(result).toMatchObject({ forwarded: "card" });
      const row = s.messages.get(CONCIERGE_CHAT)?.at(-1);
      const [part, ...rest] = JSON.parse(row?.content ?? "[]");
      expect(rest).toEqual([]);
      expect(part).toMatchObject({
        type: "widget",
        appId: "core",
        text: LINE,
        ui: HEALTH,
        forwardedFrom: { chatId: "task-1", title: "Health" },
      });
      expect(part.toolUseId).not.toBe("task-call-1");
      expect(row?.replyTo).toBe("ack-1");
    });

    it("leaves the task's start message where it is", async () => {
      const s = await withRows(cardRow("card-1"));
      const taskId = (await s.taskRepo.findBySession("task-1"))!.id;
      expect(await startKeyOf(s, taskId)).toBe("ack-1");
      await s.tool("card_forward", { cardId: "card-1" });
      expect(await startKeyOf(s, taskId)).toBe("ack-1");
      const listed = text(await s.tool("chat_list", {}));
      expect(
        listed.find((chat: { chatId: string }) => chat.chatId === "task-1")?.startMessageId,
      ).toBe("ack-1");
    });

    it("sends several cards one by one, each as a message of its own in the task's thread", async () => {
      const s = await withRows(cardRow("card-1"), cardRow("card-2", "Steps 8,000."));
      const first = text(await s.tool("card_forward", { cardId: "card-1" }));
      const second = text(await s.tool("card_forward", { cardId: "card-2" }));
      expect(first.messageId).not.toBe(second.messageId);
      expect(widgets(s).map((parts) => [parts.length, parts[0].text])).toEqual([
        [1, LINE],
        [1, "Steps 8,000."],
      ]);
      // Both reply to the task's start message, not to each other.
      const replies = [first, second].map(
        (sent) => s.messages.get(CONCIERGE_CHAT)?.find((row) => row.id === sent.messageId)?.replyTo,
      );
      expect(replies).toEqual(["ack-1", "ack-1"]);
    });

    it("sends a card once when it is forwarded twice in a turn", async () => {
      const s = await withRows(cardRow("card-1"));
      const first = text(await s.tool("card_forward", { cardId: "card-1" }));
      const again = text(await s.tool("card_forward", { cardId: "card-1" }));
      expect(again.messageId).toBe(first.messageId);
      expect(widgets(s)).toHaveLength(1);
    });

    it("forwards a card an earlier turn showed, by its id", async () => {
      const s = await withRows(
        cardRow("old-card", "Yesterday: sleep 7.2 h.", HEALTH, "task-turn-0"),
        {
          role: "user",
          turnId: "task-turn-2",
          content: JSON.stringify([{ type: "text", content: "And the steps?" }]),
        },
        textRow(concluded("8,000 steps."), "task-turn-2"),
      );
      const result = text(await s.tool("card_forward", { cardId: "old-card" }));
      expect(result.forwarded).toBe("card");
      expect(widgets(s).at(-1)?.[0].text).toBe("Yesterday: sleep 7.2 h.");
    });

    it("settles the task's result as told, and pushes the task's title and the card's line", async () => {
      const s = await withRows(cardRow("card-1"));
      const taskId = (await s.taskRepo.findBySession("task-1"))!.id;
      const noted = rs.spyOn(s.service, "noteSaid");
      const settled = rs.spyOn(s.tasks, "resultSaid");
      s.pushLevel("active");
      await s.tool("card_forward", { cardId: "card-1" });
      await s.settle();
      expect(noted).toHaveBeenCalledWith(taskId);
      expect(settled).toHaveBeenCalledWith(taskId);
      expect(s.pushes.map((push) => push.body)).toEqual([`Health: ${LINE}`]);
    });

    it("forwards the card's text where this chat cannot show cards", async () => {
      const s = await withRows(cardRow("card-1"));
      s.drawWidgets("plain_text");
      const result = text(await s.tool("card_forward", { cardId: "card-1" }));
      expect(result.forwarded).toBe("card_text");
      expect(stored(s).at(-1)).toEqual([
        ACK_QUOTE,
        { type: "text", content: LINE, format: "long" },
      ]);
    });

    it("refuses an id that names no card, and says to tell the result with say", async () => {
      const s = await withRows(textRow(concluded("Found 3 flights.")));
      const before = stored(s).length;
      for (const cardId of ["no-such-id", "row-1"]) {
        const result = await s.tool("card_forward", { cardId });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Nothing was sent");
        expect(result.content[0].text).toContain("use say");
        expect(result.content[0].text).toContain("start_message_id");
      }
      expect(stored(s)).toHaveLength(before);
    });

    it("refuses a card that is not in a task chat, such as the Concierge's own", async () => {
      const s = setup();
      s.messages.set(CONCIERGE_CHAT, [cardRow("own-card")]);
      const result = await s.tool("card_forward", { cardId: "own-card" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("No card own-card in a task chat");
      expect(stored(s)).toHaveLength(1);
    });

    it("refuses a card that no longer passes the check, and sends nothing", async () => {
      const s = await withRows(
        cardRow("bad", LINE, { components: [{ id: "root", component: "Button", label: "Go" }] }),
      );
      const before = stored(s).length;
      const result = await s.tool("card_forward", { cardId: "bad" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("with say");
      expect(stored(s)).toHaveLength(before);
    });

    it("takes the card's id alone, and describes itself by id", async () => {
      const s = setup();
      const tools = await buildConciergeTools(s.service, s.context());
      const forward = tools.find((candidate) => candidate.name === "card_forward")!;
      expect(Object.keys((forward.inputSchema as { properties: object }).properties)).toEqual([
        "cardId",
      ]);
      expect(forward.description).toContain("`card id=…` line");
      expect(forward.description).toContain("`cardId`");
      expect(forward.description).toContain("call it once for each");
      expect(tools.map((tool) => tool.name)).not.toContain("chat_forward");
    });

    it("shows a task chat's card in chat_read with its id and plain-text line", async () => {
      const s = await withRows(cardRow("card-1"), textRow(concluded("Summary.")));
      const read = text(await s.tool("chat_read", { chatId: "task-1" }));
      const cardMessage = read.messages.find((message: { id: string }) => message.id === "card-1");
      expect(cardMessage).toMatchObject({ cardId: "card-1", text: LINE });
      expect(read.messages.filter((message: { cardId?: string }) => message.cardId)).toHaveLength(
        1,
      );
    });
  });

  it("say marks no origin on what the agent writes itself", async () => {
    const s = setup();
    await s.tool("say", { text: "# Plan", format: "long" });
    expect(JSON.parse(s.messages.get(CONCIERGE_CHAT)?.[0].content ?? "")[0]).not.toHaveProperty(
      "forwardedFrom",
    );
  });
});

describe("Concierge task list tools", () => {
  const text = (result: RomeToolResult) => JSON.parse(result.content[0].text);

  it("chat_start makes the task of its chat, whose id is the chat's, and answers the chat's id", async () => {
    const s = setup();
    const result = text(await s.tool("chat_start", { title: "Flights", brief: "Find flights" }));
    expect(result.chatId).toBe("task-1");
    expect(await s.taskRepo.get("task-1")).toMatchObject({
      id: "task-1",
      title: "Flights",
      sessionId: "task-1",
    });
  });

  it.each([
    "concierge",
    "guardian",
  ] as const)("chat_send takes up a task stopped by the %s again: it is active once more", async (by) => {
    const s = setup();
    const { taskId } = text(await s.tool("chat_start", { title: "Flights", brief: "Find" }));
    await s.service.stopTask(taskId, by);
    expect((await s.taskRepo.get(taskId))?.stoppedAt).toEqual(expect.any(Date));
    await s.tool("chat_send", { chatId: "task-1", text: "Look again" });
    expect(await s.taskRepo.get(taskId)).toMatchObject({ stoppedAt: null });
    const [row] = await s.tasks.listForPanel();
    expect(row).toMatchObject({ id: taskId, status: "active" });
  });
});

describe("Concierge task chats", () => {
  const text = (result: RomeToolResult) => JSON.parse(result.content[0].text);
  const anchorOf = async (s: ReturnType<typeof setup>, taskId: string) =>
    (await s.taskRepo.getWithChat(taskId))?.sourceMessageId;

  it("chat_start answers the task chat's id and the link that names it, with no card and no row id", async () => {
    const s = setup({ said: false });
    await s.tool("say", { text: "Looking into flights" });
    const result = await s.tool("chat_start", { title: "Flights [Lisbon]", brief: "Find flights" });
    expect(result.isError).toBeFalsy();
    const started = text(result);
    expect(started.chatId).toBe("task-1");
    // The link is the chat's own name as its text, brackets dropped, and the chat's id as its target.
    expect(started.link).toBe("[Flights Lisbon](#rome-task=task-1)");
    // The task is its chat: it points to the latest message of the turn, and shows no card.
    expect(await anchorOf(s, "task-1")).toBe("said-1");
    expect(s.messages.get(CONCIERGE_CHAT)?.every((row) => !row.content.includes("task_chat"))).toBe(
      true,
    );
    expect((await s.tasks.repo.get("task-1"))?.title).toBe("Flights [Lisbon]");
  });

  it("chat_start says its answer is JSON text and its link a whole Markdown link to paste as it is", async () => {
    // In Codex code mode a script gets a tool's answer as a string, so reading
    // `.link` without JSON.parse yields String.prototype.link (#2510).
    const s = setup({ said: false });
    const tools = await buildConciergeTools(s.service, s.context());
    const { description } = tools.find((tool) => tool.name === "chat_start")!;
    expect(description).toContain("Returns JSON text");
    expect(description).toContain("JSON.parse it before you read a field");
    expect(description).toContain("`link` is already the whole Markdown link: paste it as it is");
  });

  it("chat_start refuses a task chat's own card and taskId parameters, as it takes neither", async () => {
    const s = setup({ said: false });
    const tools = await buildConciergeTools(s.service, s.context());
    const start = tools.find((tool) => tool.name === "chat_start")!;
    const properties = (start.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(properties).not.toHaveProperty("taskId");
    expect(properties).not.toHaveProperty("card");
  });

  it("chat_start starts no chat when the task has no message to point to", async () => {
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

  describe("chat_update", () => {
    const startFlights = async () => {
      const s = setup({ said: false });
      await s.tool("say", { text: "On it" });
      const started = text(await s.tool("chat_start", { title: "Flights", brief: "Find flights" }));
      return { s, ...(started as { chatId: string; link: string }) };
    };

    it("renames the chat, so the Tasks view and chat_list show the new name", async () => {
      const { s, chatId } = await startFlights();
      const renamed = text(
        await s.tool("chat_update", { chatId, name: "Direct flights to Lisbon" }),
      );
      expect(renamed).toMatchObject({
        chatId,
        title: "Direct flights to Lisbon",
        link: `[Direct flights to Lisbon](#rome-task=${chatId})`,
      });
      // The chat's own name changed, which is the task's one name.
      expect((await s.storedChats.getSession(chatId))?.name).toBe("Direct flights to Lisbon");
      expect((await s.tasks.listForPanel()).map((row) => [row.id, row.title])).toEqual([
        [chatId, "Direct flights to Lisbon"],
      ]);
      const listed = text(await s.tool("chat_list", {})).filter(
        (chat: { kind: string }) => chat.kind === "task chat",
      );
      expect(listed).toMatchObject([
        { chatId, title: "Direct flights to Lisbon", link: renamed.link, from: CONCIERGE_CHAT },
      ]);
    });

    it("keeps a note for the Concierge's later self, answered only with details", async () => {
      const { s, chatId } = await startFlights();
      await s.tool("chat_update", { chatId, note: "Fly Friday" });
      const plain = text(await s.tool("chat_list", {})).find(
        (chat: { chatId: string }) => chat.chatId === chatId,
      );
      expect(plain).not.toHaveProperty("note");
      const detailed = text(await s.tool("chat_list", { details: true })).find(
        (chat: { chatId: string }) => chat.chatId === chatId,
      );
      expect(detailed).toMatchObject({ note: "Fly Friday" });
      await s.tool("chat_update", { chatId, note: null });
      expect((await s.taskRepo.get(chatId))?.note).toBeNull();
    });

    it("archives the task chat, which stops it while it is open, and brings it back", async () => {
      const { s, chatId } = await startFlights();
      s.chats.activeTurns = () => ["t1"];
      await s.tool("chat_update", { chatId, archived: true });
      expect(await s.taskRepo.get(chatId)).toMatchObject({
        stoppedAt: expect.any(Date),
        archivedAt: expect.any(Date),
      });
      await s.tool("chat_update", { chatId, archived: false });
      expect((await s.taskRepo.get(chatId))?.archivedAt).toBeNull();
    });

    it("refuses a chat that is no task chat of this Concierge chat, and a bad field, changing nothing", async () => {
      const { s, chatId } = await startFlights();
      expect((await s.tool("chat_update", { chatId: CONCIERGE_CHAT, name: "x" })).isError).toBe(
        true,
      );
      expect((await s.tool("chat_update", { chatId, archived: "yes" })).isError).toBe(true);
      expect((await s.tool("chat_update", { chatId, note: 7 })).isError).toBe(true);
      expect((await s.storedChats.getSession(chatId))?.name).toBe("Flights");
    });
  });

  it("chat_list answers each task chat with its link and derived status, and the ended ones on request", async () => {
    const s = setup({ said: false });
    await s.tool("say", { text: "On it" });
    const open = text(await s.tool("chat_start", { title: "Flights", brief: "Find flights" }));
    const done = text(await s.tool("chat_start", { title: "Hotels", brief: "Find hotels" }));
    await s.taskRepo.setLastOutcome(done.chatId, "succeeded", new Date(), { reported: false });
    s.chats.activeTurns = (id: string) => (id === open.chatId ? ["t1"] : []);
    s.chats.isRunning = (id: string) => id === open.chatId;
    const tasks = (result: Awaited<ReturnType<typeof s.tool>>) =>
      text(result).filter((chat: { kind: string }) => chat.kind === "task chat");
    expect(tasks(await s.tool("chat_list", {}))).toMatchObject([
      { chatId: open.chatId, link: open.link, status: "active", from: CONCIERGE_CHAT },
    ]);
    expect(tasks(await s.tool("chat_list", { includeEnded: true }))).toMatchObject([
      { chatId: open.chatId, status: "active" },
      { chatId: done.chatId, status: "ended", endReason: "done" },
    ]);
    expect(tasks(await s.tool("chat_list", { status: "ended" }))).toMatchObject([
      { chatId: done.chatId, status: "ended" },
    ]);
  });

  it("chat_stop stops a task chat of this Concierge chat, and refuses any other", async () => {
    const s = setup({ said: false });
    await s.tool("say", { text: "On it" });
    const { chatId } = text(
      await s.tool("chat_start", { title: "Flights", brief: "Find flights" }),
    );
    s.chats.activeTurns = () => ["t1"];
    expect(text(await s.tool("chat_stop", { chatId }))).toEqual({ stopped: 1 });
    expect((await s.taskRepo.get(chatId))?.stoppedAt).toEqual(expect.any(Date));
    expect((await s.tool("chat_stop", { chatId: CONCIERGE_CHAT })).isError).toBe(true);
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

    it("refuses chat_update, chat_stop and card_forward for another Concierge chat's task chat, and changes nothing", async () => {
      const { s, chatId, taskId, row } = await startInMain();
      s.messages.get(chatId)?.push({
        id: "card-x",
        role: "assistant",
        turnId: "task-turn-1",
        content: JSON.stringify([
          {
            type: "widget",
            toolUseId: "c",
            appId: "core",
            text: "Sleep 6.1 h",
            ui: { components: [{ id: "root", component: "Text", text: "Sleep" }] },
          },
        ]),
      });
      const messagesHere = s.messages.get(TOPIC_CHAT)?.length;

      for (const result of [
        await s.tool("card_forward", { cardId: "card-x" }),
        await s.tool("chat_update", { chatId, name: "Mine now" }),
        await s.tool("chat_stop", { chatId }),
      ]) {
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("belongs to another Concierge chat");
      }
      expect(s.messages.get(TOPIC_CHAT)).toHaveLength(messagesHere ?? 0);
      expect(await s.taskRepo.get(taskId)).toEqual(row);
      expect((await s.storedChats.getSession(chatId))?.name).toBe("Flights");
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

  it("tells the Concierge of a turn that only carries out the guardian's card answer, for it to judge", async () => {
    const s = setup();
    const { chatId } = await startTask(s);
    s.fakeTimers();
    answeredCard(s, chatId, "task-turn-2");
    await s.finish({
      turnId: "task-turn-2",
      agentName: "core:main",
      chatId,
      text: concluded(NOTHING_TO_REPORT, "Saved Tea as your afternoon drink."),
    });
    await rs.advanceTimersByTimeAsync(2_000);
    expect(s.backendTurns).toHaveLength(1);
    expect(s.backendTurns[0].prompt).toContain('changes="turn_end:completed by=concierge"');
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
    const { chatId } = await startTask(s);
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
      `${MAIN_LINE}<task_events>\n<task chat_id="task-1" start_message_id="ack-1" title="Flights" status="ended" end_reason="done" changes="turn_end:completed by=concierge">\nreply: 3 options\n</task>\n</task_events>`,
    );
    expect(s.quietFlags).toEqual([true]);
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

  /** The prompt of the task event an answer `text` brings, with a card for each of `lines` after it. */
  const cardEventFor = async (text: string, lines: string[], answerTurn = "task-turn-1") => {
    const s = setup();
    const { chatId } = await startTask(s, text);
    const rows = s.messages.get(chatId) ?? [];
    const answer = rows.at(-1);
    if (answer) answer.turnId = answerTurn;
    lines.forEach((line, index) => {
      rows.push({
        id: `card-${index + 1}`,
        role: "assistant",
        turnId: "task-turn-1",
        content: JSON.stringify([
          {
            type: "widget",
            toolUseId: "c1",
            appId: "core",
            text: line,
            ui: { components: [{ id: "root", component: "Text", text: "Sleep" }] },
          },
        ]),
      });
    });
    s.fakeTimers();
    await finishTask(s, chatId);
    await rs.advanceTimersByTimeAsync(2_000);
    rs.useRealTimers();
    return s.backendTurns[0]?.prompt ?? "";
  };

  it("tells the Concierge the answer showed a card, by its id and plain-text line", async () => {
    const prompt = await cardEventFor(concluded("Your daily health summary."), [
      "Sleep 6.1 h\n(usual 7–9)",
    ]);
    expect(prompt).toContain("\ncard id=card-1: Sleep 6.1 h (usual 7–9)\n");
    expect(prompt).toContain("\nconclusion: Your daily health summary.\n");
  });

  it("lists every card the answer's turn showed, one line each, in order", async () => {
    const prompt = await cardEventFor(concluded("Today's summary."), [
      "Sleep 6.1 h",
      "Steps 8,000",
    ]);
    expect(prompt).toContain("\ncard id=card-1: Sleep 6.1 h\ncard id=card-2: Steps 8,000\n");
  });

  it("gives a turn that showed only a card as its card line, with no earlier turn's conclusion", async () => {
    const prompt = await cardEventFor(
      concluded("Yesterday's summary."),
      ["Sleep 6.1 h"],
      "task-turn-0",
    );
    expect(prompt).toContain("\ncard id=card-1: Sleep 6.1 h\n");
    expect(prompt).not.toContain("Yesterday's summary.");
  });

  it("names a card even when the answer has nothing to report: the Concierge judges it", async () => {
    const prompt = await cardEventFor(concluded(NOTHING_TO_REPORT), ["Sleep 6.1 h"]);
    expect(prompt).toContain(`conclusion: ${NOTHING_TO_REPORT}`);
    expect(prompt).toContain("card id=card-1: Sleep 6.1 h");
  });

  it("cuts a long card line like a long reply", async () => {
    const prompt = await cardEventFor(concluded("Summary."), ["w".repeat(1_000)]);
    expect(prompt).toContain(
      `\ncard id=card-1: ${"w".repeat(400)}${leftOut(300)}${"w".repeat(300)}\n`,
    );
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

  it("tells the guardian's own turn in a task chat within seconds, as a turn that shows no sign until it speaks", async () => {
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
    await rs.advanceTimersByTimeAsync(2_000);
    expect(s.backendTurns).toHaveLength(1);
    expect(s.backendTurns[0].prompt).toContain('changes="turn_end:completed by=guardian"');
    expect(s.backendTurns[0].prompt).not.toContain("quiet=");
    expect(s.quietFlags).toEqual([true]);
  });

  it("hands a task's result over again once the Concierge's own turns run, however long it was out", async () => {
    const s = setup();
    const { chatId } = await startTask(s);
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
      `<task chat_id="${chatId}" start_message_id="ack-1" title="Flights" status="ended" end_reason="done" changes="turn_end:completed by=concierge">`,
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
      await s.tool("say", { text: "Three options found", replyTo: await startKeyOf(s, taskId) });
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
    await s.tool("chat_update", { chatId: taskId, name: "Flights to Rome" });
    s.onBackendTurn(() => "completed");
    await rs.advanceTimersByTimeAsync(RETRY_MS + 1_000);
    expect(s.backendTurns).toHaveLength(2);
    expect(s.backendTurns[1].prompt).toContain(`chat_id="${taskId}"`);
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
              if (edits) await s.taskRepo.write(taskId, { note: "Edited" });
              if (says) {
                s.inTurn("report");
                await s.tool("say", {
                  text: "Three options found",
                  replyTo: await startKeyOf(s, taskId),
                });
              }
              return outcome;
            });
            await finishTask(s, chatId);
            await rs.advanceTimersByTimeAsync(2_000);
            expect(s.backendTurns).toHaveLength(1);
            // Every later report runs to its end.
            s.onBackendTurn(() => "completed");
            await rs.advanceTimersByTimeAsync(2 * RETRY_MS);
            const reports = s.backendTurns.filter((turn) =>
              turn.prompt.includes(`chat_id="${taskId}"`),
            );
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
      await s.taskRepo.write(taskId, { note: "Edited" });
      return "failed" as const;
    });
    await finishTask(s, chatId);
    await rs.advanceTimersByTimeAsync(2_000);
    expect(s.backendTurns).toHaveLength(1);
    s.onBackendTurn(() => "completed");
    await rs.advanceTimersByTimeAsync(RETRY_MS + 1_000);
    expect(s.backendTurns).toHaveLength(2);
    expect(s.backendTurns[1].prompt).toContain(`chat_id="${taskId}"`);
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

  it("tells the Concierge of a failed or stopped turn at once, a failed one with its cause", async () => {
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
    expect(stopped.backendTurns).toHaveLength(1);
    expect(stopped.backendTurns[0].prompt).toContain("turn_end:interrupted by=concierge");
    expect(stopped.quietFlags).toEqual([true]);
  });

  it("tells the Concierge of a question card at once, by the id card_forward takes", async () => {
    const s = setup();
    const { chatId } = await startTask(s);
    s.messages.get(chatId)?.push({
      id: "ask-1",
      role: "assistant",
      content: JSON.stringify([
        {
          type: "pending_interaction",
          render: {
            builtin: true,
            componentId: "question-card",
            props: {
              questions: [
                { question: "Which airport?", options: ["LIS", "OPO"] },
                { question: "Anything else?" },
              ],
            },
          },
        },
      ]),
    });
    s.fakeTimers();
    await finishTask(s, chatId);
    await rs.advanceTimersByTimeAsync(2_000);
    const prompt = s.backendTurns[0].prompt;
    expect(prompt).toContain('changes="turn_end:completed question by=concierge"');
    expect(prompt).toContain("card id=ask-1: Which airport? (options: LIS | OPO) · Anything else?");
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
    await rs.advanceTimersByTimeAsync(2_000);
    expect(s.backendTurns).toHaveLength(1);
    expect(s.backendTurns[0].prompt).toContain(`<task chat_id="${taskId}"`);
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
    expect(s.quietFlags).toEqual([true]);
  });

  it("keeps a typed reply that dismisses the open card the guardian's own turn", async () => {
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
    expect(s.backendTurns[0].prompt).toContain('changes="turn_end:completed by=guardian"');
    expect(s.quietFlags).toEqual([true]);
  });

  it("tells at once the turn after an approved action, though it has nothing to report, with the decision", async () => {
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
    expect(s.backendTurns).toHaveLength(1);
    expect(s.backendTurns[0].prompt).toContain("approval_decided");
    expect(s.backendTurns[0].prompt).toContain("turn_end:completed by=concierge");
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
    const pending = s.createApproval({
      status: "pending",
      description: "Send the booking email",
      payload: { channelContext: { threadId: chatId } },
    });
    await s.settle();
    await rs.advanceTimersByTimeAsync(2_000);
    expect(s.backendTurns[0].prompt).toContain('changes="approval"');
    expect(s.backendTurns[0].prompt).toContain(`card id=${pending.id}: Send the booking email`);
    expect(s.backendTurns[0].prompt).not.toContain("approval: ");
    expect(s.quietFlags).toEqual([true]);
  });

  it("names a pending approval by its preview's title when it has one", async () => {
    const s = setup();
    const { chatId } = await startTask(s);
    s.fakeTimers();
    const asked = s.createApproval({
      status: "pending",
      description: 'Action "system:vault_apply" requires guardian approval',
      payload: {
        channelContext: { threadId: chatId },
        preview: { kind: "secret_access", title: "Use CF_API_TOKEN for 15 min", summary: "x" },
      },
    });
    await s.settle();
    await rs.advanceTimersByTimeAsync(2_000);
    expect(s.backendTurns[0].prompt).toContain(`card id=${asked.id}: Use CF_API_TOKEN for 15 min`);
    expect(s.backendTurns[0].prompt).not.toContain("requires guardian approval");
  });

  it("tells the Concierge at once of a task turn that failed before it started, either way it is told", async () => {
    const error = "Selected model provider is unavailable: Claude is not signed in";
    const expectFailedTurn = (s: ReturnType<typeof setup>, chatId: string) => {
      expect(s.backendTurns).toHaveLength(1);
      expect(s.backendTurns[0].prompt).toContain(
        `<task chat_id="${chatId}" start_message_id="ack-1" title="Flights" status="ended" end_reason="failed" changes="turn_end:error by=concierge">`,
      );
      expect(s.backendTurns[0].prompt).toContain(`error: ${error}`);
      expect(s.quietFlags).toEqual([true]);
    };

    // A reused agent session: it could not resolve the model for the turn.
    const reused = setup();
    const first = await startTask(reused);
    reused.fakeTimers();
    await reused.failBeforeStart({ turnId: "task-turn-1", chatId: first.chatId, error });
    await reused.failBeforeStart({ turnId: "other-turn", chatId: "not-a-task-chat", error });
    await rs.advanceTimersByTimeAsync(2_000);
    expectFailedTurn(reused, first.chatId);

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
    expectFailedTurn(cold, second.chatId);
  });

  it("tells within seconds a turn with no input, such as a wake-up the task chat set itself, with its conclusion", async () => {
    const s = setup();
    const { chatId, taskId } = await startTask(s);
    s.fakeTimers();
    // The task chat's own `defer` woke it: nobody wrote in it, and it asked nothing.
    s.messages.get(chatId)?.push({
      role: "assistant",
      content: JSON.stringify([
        { type: "text", content: concluded("CI passed on PR #7.", "All 13 checks passed.") },
      ]),
      turnId: "wake-turn",
    });
    await s.finish({
      turnId: "wake-turn",
      agentName: "core:main",
      chatId,
      status: "completed",
      text: concluded("CI passed on PR #7.", "All 13 checks passed."),
    });
    // Its result waits for the report: the task has not ended unsaid.
    expect(await s.taskRepo.get(taskId)).toMatchObject({
      lastOutcome: "succeeded",
      outcomeUnsaid: true,
    });
    await rs.advanceTimersByTimeAsync(2_000);
    expect(s.backendTurns).toHaveLength(1);
    expect(s.backendTurns[0].prompt).toContain(
      `<task chat_id="${taskId}" start_message_id="ack-1" title="Flights"`,
    );
    expect(s.backendTurns[0].prompt).toContain('changes="turn_end:completed by=system"');
    expect(s.backendTurns[0].prompt).toContain("conclusion: CI passed on PR #7.");
    expect(s.backendTurns[0].prompt).not.toContain("quiet=");
    // The digest lists no such run.
    expect((await s.service.digestTaskNotes(CONCIERGE_CHAT, "guardian")).text).toBe("");
  });

  it("tells a turn whose conclusion has nothing to report too, and keeps its result waiting for the report", async () => {
    const s = setup();
    const { chatId, taskId } = await startTask(s);
    s.fakeTimers();
    await s.finish({
      turnId: "wake-turn",
      agentName: "core:main",
      chatId,
      status: "completed",
      text: concluded(NOTHING_TO_REPORT, "Checked again."),
    });
    expect(await s.taskRepo.get(taskId)).toMatchObject({ outcomeUnsaid: true });
    await rs.advanceTimersByTimeAsync(2_000);
    expect(s.backendTurns).toHaveLength(1);
    expect(s.backendTurns[0].prompt).toContain('changes="turn_end:completed by=system"');
  });

  it("keeps a digest's no-response notes until a digest that lists them runs to its end", async () => {
    const s = setup();
    const unanswered = await s.makeTaskRow({ title: "Pick a seat", chatId: CONCIERGE_CHAT });
    await s.taskRepo.markWaitExpired(unanswered!.id, new Date(Date.now() - 2 * 86_400_000));
    // A digest turn that failed marked nothing: the next digest reads the same notes.
    const first = await s.service.digestTaskNotes(CONCIERGE_CHAT, "guardian");
    const again = await s.service.digestTaskNotes(CONCIERGE_CHAT, "guardian");
    expect(again).toEqual(first);
    expect(first.text).toContain(`<ended_no_response task="${unanswered!.id}"`);
    await s.service.markTaskNotesListed(again);
    expect((await s.service.digestTaskNotes(CONCIERGE_CHAT, "guardian")).text).toBe("");
  });

  it("takes a task with its chat when the chat is deleted, and tells no one of a task that is gone", async () => {
    const s = setup();
    const { chatId, taskId } = await startTask(s);
    s.fakeTimers();
    const told: string[] = [];
    s.taskRepo.onChange(({ row }) => told.push(row.id));
    const linked = await s.service.endTaskChat(chatId, "deleted");
    expect(linked).toBe(taskId);
    expect(await s.storedChats.getSession(chatId)).toBeNull();
    // The task is gone with its chat, the Tasks view is told, and no event is owed for it.
    expect(await s.taskRepo.get(taskId)).toBeNull();
    expect(told).toEqual([taskId]);
    await rs.advanceTimersByTimeAsync(120_000);
    expect(s.backendTurns).toEqual([]);
  });

  it("after a restart, hands over rows whose chat was active since the row was written", async () => {
    const s = setup({ startEvents: false });
    await s.storedChats.createSession("behind", "Behind");
    await s.storedChats.createSession("current", "Current");
    s.messages.set("behind", [
      { role: "assistant", content: JSON.stringify([{ type: "text", content: "all done" }]) },
    ]);
    const longAgo = new Date(Date.now() - 3_600_000);
    const behind = await s.taskRepo.create("behind", {}, longAgo);
    await s.taskRepo.create("current", {});
    s.fakeTimers();
    s.startEvents();
    await s.settle();
    await rs.advanceTimersByTimeAsync(59_000);
    expect(s.backendTurns).toEqual([]);
    await rs.advanceTimersByTimeAsync(1_000);
    expect(s.backendTurns).toHaveLength(1);
    expect(s.backendTurns[0].prompt).toContain(`<task chat_id="${behind.id}"`);
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

  it("pushes the Concierge's own words for a say that tells a task's result, not the task's answer", async () => {
    const s = setup();
    const chatId = await finishedTask(s, SECRET_ANSWER);
    const task = await s.tasks.repo.findBySession(chatId);
    const start = (await s.taskRepo.getWithChat(task?.id ?? ""))?.sourceMessageId ?? undefined;
    s.pushLevel("active");
    await s.tool("say", { text: "The bank sent a sign-in code.", replyTo: start });
    await s.settle();
    expect(s.pushes.map((push) => push.body)).toEqual(["The bank sent a sign-in code."]);
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
    defaultProvider: "anthropic" | "openai" | "rome_credits" | null = "openai",
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
      defaults: { current: () => defaultProvider },
    } as unknown as ConciergeDeps);
    return { service, createSession, update };
  };
  const signedOut = reportOf("unauthorized");
  const codexOnly: ModelAccountReports = {
    anthropic: signedOut,
    openai: reportOf("available"),
  };

  it("creates the chat at its fixed id, on the default provider's strong model", async () => {
    const { service, createSession } = serviceWith(codexOnly, false);
    const [first, second] = await Promise.all([service.ensureChatId(), service.ensureChatId()]);
    expect([first, second]).toEqual(["concierge", "concierge"]);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith(
      "concierge",
      "Main chat",
      undefined,
      undefined,
      "gpt-6-1-sol",
      undefined,
      CONCIERGE_AGENT_ID,
      "webchat",
      null,
      {},
      null,
      "auto",
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
      "gpt-6-1-sol",
      undefined,
      CONCIERGE_AGENT_ID,
      "webchat",
      null,
      { ownerKey: "visitor:acct-ann" },
      null,
      "auto",
    );
  });

  const withChats = (
    chats: Record<string, Record<string, unknown>>,
    defaultProvider?: "anthropic" | "openai" | "rome_credits" | null,
  ) => {
    const update = rs.fn(async () => {});
    const selectModel = rs.fn();
    const find = rs.fn(() => ({ selectModel }));
    const service = new ConciergeService({
      settingsRepo: { get: async () => null },
      webchatRepo: {
        getSession: async (id: string) => (chats[id] ? { id, ...chats[id] } : null),
        updateSessionLargeModelSelection: update,
      },
      accounts: fakeAccounts(() => ({
        anthropic: reportOf("available"),
        openai: reportOf("available"),
      })),
      agentSessionManager: { find },
      ...(defaultProvider === undefined ? {} : { defaults: { current: () => defaultProvider } }),
    } as unknown as ConciergeDeps);
    return { service, update, selectModel, find };
  };

  describe("moving off the old default model", () => {
    it("moves a Concierge chat Rome left on Sonnet or Luna to its provider's strong model, once", async () => {
      const { service, update } = withChats({
        concierge: { agentName: CONCIERGE_AGENT_ID, largeModelSelection: "claude-sonnet" },
        topic: { agentName: CONCIERGE_AGENT_ID, largeModelSelection: "gpt-6-luna" },
      });
      await service.followDefault("concierge");
      await service.followDefault("topic");
      expect(update.mock.calls).toEqual([
        ["concierge", "claude-opus-5-5", "auto"],
        ["topic", "gpt-6-1-sol", "auto"],
      ]);
    });

    it("leaves a model its owner picked, one Rome chose since, and every chat that is not a Concierge chat", async () => {
      const { service, update } = withChats({
        concierge: {
          agentName: CONCIERGE_AGENT_ID,
          largeModelSelection: "claude-sonnet",
          largeModelSelectionBy: "owner",
        },
        topic: {
          agentName: CONCIERGE_AGENT_ID,
          largeModelSelection: "claude-sonnet",
          largeModelSelectionBy: "auto",
        },
        // An ordinary chat, and a task chat on its fast model, with no provenance.
        ordinary: { agentName: null, largeModelSelection: "claude-sonnet" },
        task: { agentName: "main", largeModelSelection: "gpt-6-luna" },
      });
      for (const id of ["concierge", "topic", "ordinary", "task"]) await service.followDefault(id);
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe("following the default provider", () => {
    it("moves a model Rome chose to the default provider's model of the same strength, live session included", async () => {
      const { service, update, selectModel, find } = withChats(
        {
          concierge: {
            agentName: CONCIERGE_AGENT_ID,
            largeModelSelection: "gpt-6-1-sol",
            largeModelSelectionBy: "auto",
          },
        },
        "anthropic",
      );
      expect(await service.followDefault("concierge")).toEqual({
        from: "openai",
        to: "anthropic",
      });
      expect(update.mock.calls).toEqual([["concierge", "claude-opus-5-5", "auto"]]);
      expect(find).toHaveBeenCalledWith({
        agentName: CONCIERGE_AGENT_ID,
        channelThreadKey: "webchat:concierge",
      });
      expect(selectModel).toHaveBeenCalledWith("claude-opus-5-5");
    });

    it("keeps a model its owner picked", async () => {
      const { service, update, selectModel } = withChats(
        {
          concierge: {
            agentName: CONCIERGE_AGENT_ID,
            largeModelSelection: "gpt-6-1-sol",
            largeModelSelectionBy: "owner",
          },
        },
        "anthropic",
      );
      expect(await service.followDefault("concierge")).toBeNull();
      expect(update).not.toHaveBeenCalled();
      expect(selectModel).not.toHaveBeenCalled();
    });

    it("moves a task chat Rome put on a fast model to the default provider's fast model", async () => {
      const { service, update, selectModel, find } = withChats(
        {
          task: {
            agentName: "main",
            largeModelSelection: "claude-sonnet",
            largeModelSelectionBy: "auto",
          },
        },
        "openai",
      );
      expect(await service.followDefault("task")).toEqual({ from: "anthropic", to: "openai" });
      expect(update.mock.calls).toEqual([["task", "gpt-6-luna", "auto"]]);
      expect(find).toHaveBeenCalledWith({ agentName: "main", channelThreadKey: "webchat:task" });
      expect(selectModel).toHaveBeenCalledWith("gpt-6-luna");
    });

    it("moves nothing while no default is set", async () => {
      const chats = {
        concierge: {
          agentName: CONCIERGE_AGENT_ID,
          largeModelSelection: "gpt-6-1-sol",
          largeModelSelectionBy: "auto",
        },
      };
      for (const unset of [withChats(chats), withChats(chats, null)]) {
        expect(await unset.service.followDefault("concierge")).toBeNull();
        expect(unset.update).not.toHaveBeenCalled();
        expect(unset.selectModel).not.toHaveBeenCalled();
      }
    });
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
    // The weekday and date are the chat owner's own, not the container's UTC
    // day: the guardian's zone, or a dashboard admin's own once reported.
    rs.useFakeTimers();
    try {
      rs.setSystemTime(new Date("2026-11-19T17:00:00Z"));
      const shanghai = new ConciergeService({
        settingsRepo: {
          get: async (key: string) => (key === "guardianTimezone" ? "Asia/Shanghai" : null),
        },
        webchatRepo: {
          getSession: async (id: string) =>
            id === annMain
              ? { id, agentName: CONCIERGE_AGENT_ID, ownerKey: "visitor:acct-ann" }
              : { id, agentName: CONCIERGE_AGENT_ID, ownerKey: null },
        },
        owners,
      } as unknown as ConciergeDeps);
      expect(await shanghai.nowLine("concierge")).toBe(
        "<now>Fri 20/11/2026 01:00 (Asia/Shanghai)</now>",
      );
      // Before following is attached, an admin's chat falls back to the guardian's zone.
      expect(await shanghai.nowLine(annMain)).toBe(
        "<now>Fri 20/11/2026 01:00 (Asia/Shanghai)</now>",
      );
      shanghai.attachFollowing({
        timezone: async (owner: string) =>
          owner === "visitor:acct-ann" ? "America/Los_Angeles" : "Asia/Shanghai",
      } as never);
      expect(await shanghai.nowLine(annMain)).toBe(
        "<now>Thu 19/11/2026 09:00 (America/Los_Angeles)</now>",
      );
      expect(await shanghai.nowLine("concierge")).toBe(
        "<now>Fri 20/11/2026 01:00 (Asia/Shanghai)</now>",
      );
    } finally {
      rs.useRealTimers();
    }
    // A dashboard admin is served while on the allow-list, the guardian always.
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

  it("gives a chat created before any default its model once a default is set", async () => {
    const { service, update } = serviceWith(codexOnly, true, null);
    await service.ensureChatId();
    expect(update).toHaveBeenCalledWith("concierge", "gpt-6-1-sol", "auto");
  });

  it("falls back to Terra without Sol access, and to Opus on a Claude login", async () => {
    const terra = serviceWith(
      { anthropic: signedOut, openai: reportOf("available", RESTRICTED_PLAN) },
      true,
      null,
    );
    await terra.service.ensureChatId();
    expect(terra.update).toHaveBeenCalledWith("concierge", "gpt-5-6-terra", "auto");
    const claude = serviceWith(
      { anthropic: reportOf("available"), openai: codexOnly.openai },
      true,
      null,
      "anthropic",
    );
    await claude.service.ensureChatId();
    expect(claude.update).toHaveBeenCalledWith("concierge", "claude-opus-5-5", "auto");
  });

  it("stores nothing for an existing chat while no default is set, or Claude is a compatible provider", async () => {
    const none = serviceWith(codexOnly, true, null, null);
    expect(await none.service.ensureChatId()).toBe("concierge");
    expect(none.update).not.toHaveBeenCalled();
    const compatible = serviceWith(
      {
        anthropic: reportOf("available", { authMethod: "stored-compatible" }),
        openai: codexOnly.openai,
      },
      true,
      null,
      "anthropic",
    );
    await compatible.service.ensureChatId();
    expect(compatible.update).not.toHaveBeenCalled();
  });
});

describe("Concierge usage-limit and sign-in failures", () => {
  it.each([
    ["quota", "monthly spend limit", "usage_limit"],
    ["login", "Failed to authenticate", undefined],
  ] as const)("keeps the chat on its provider after a %s failure, with no note and no recovery", async (_reason, message, code) => {
    const s = setup({ delay: async () => {} });
    await s.deps.webchatRepo.updateSessionLargeModelSelection(
      CONCIERGE_CHAT,
      "claude-opus-5-5",
      "auto",
    );
    s.deps.accounts = fakeAccounts({
      anthropic: reportOf(code ? "usage_limit_reached" : "unauthorized"),
      openai: reportOf("available"),
    });
    const switchModel = rs.spyOn(s.service, "switchForModelLimit");
    await s.finish({
      turnId: "failed",
      failure: { provider: "anthropic", message, ...(code ? { code } : {}) },
      agentName: CONCIERGE_AGENT_ID,
      chatId: CONCIERGE_CHAT,
      status: "error",
    });
    await s.settle();
    expect(s.backendTurns).toEqual([]);
    expect(switchModel).not.toHaveBeenCalled();
    expect(s.deps.webchatRepo.updateSessionLargeModelSelection).toHaveBeenCalledTimes(1);
    expect(s.deps.webchatRepo.addBackendMessage).not.toHaveBeenCalled();
    expect(s.sessions.get(CONCIERGE_CHAT)).toMatchObject({
      largeModelSelection: "claude-opus-5-5",
    });
  });
  it.each([
    "no failure",
    "unrecognized error",
    "task chat",
  ])("does not recover %s", async (reason) => {
    const s = setup();
    const switchModel = rs.spyOn(s.service, "switchForModelLimit");
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
    await s.deps.webchatRepo.updateSessionLargeModelSelection(
      CONCIERGE_CHAT,
      "claude-opus-5-5",
      "auto",
    );
    return { s, raw };
  }
  it.each([
    ["anthropic", "claude-sonnet", "You've hit your Sonnet limit", "claude-opus-5-5", "kept"],
    ["openai", "gpt-6-luna", "Selected model is at capacity.", "gpt-5-6-terra", "auto"],
  ] as const)("an overload swap lasts one turn: %s from %s on %s runs the other model once, and the chat keeps its own", async (provider, selection, message, target, by) => {
    const { s } = await prepared({ startEvents: false });
    await s.deps.webchatRepo.updateSessionLargeModelSelection(CONCIERGE_CHAT, selection, by);
    const session = { selectModel: rs.fn(), selectModelForOneTurn: rs.fn() };
    (s.deps.agentSessionManager.find as ReturnType<typeof rs.fn>).mockReturnValue(session);
    (s.deps.webchatRepo.updateSessionLargeModelSelection as ReturnType<typeof rs.fn>).mockClear();
    expect(
      await s.service.switchForModelLimit(CONCIERGE_CHAT, failure(message, provider)),
    ).toMatchObject({ from: provider, to: provider, selectionId: target });
    // The weaker model is never stored: the next turn tries the chat's own again.
    expect(s.deps.webchatRepo.updateSessionLargeModelSelection).not.toHaveBeenCalled();
    expect(s.sessions.get(CONCIERGE_CHAT)).toMatchObject({
      largeModelSelection: selection,
      largeModelSelectionBy: by,
    });
    expect(session.selectModelForOneTurn).toHaveBeenCalledWith(target);
    expect(session.selectModel).not.toHaveBeenCalled();
    expect(s.deps.webchatRepo.addBackendMessage).toHaveBeenLastCalledWith(
      CONCIERGE_CHAT,
      expect.any(String),
      [
        expect.objectContaining({
          type: "quota_switch",
          from: provider,
          to: provider,
          reason: "model_limit",
          oneTurn: true,
        }),
      ],
    );
  });
  it("an overload swap lasts one turn: a chat that follows by its tier stores nothing", async () => {
    const { s } = await prepared({ startEvents: false });
    await s.deps.webchatRepo.updateSessionLargeModelSelection(CONCIERGE_CHAT, null, "auto");
    s.deps.sessionRepository.current = rs.fn(
      async () => ({ provider: "anthropic", model: "claude-opus-5-5[1m]" }) as never,
    );
    const session = { selectModel: rs.fn(), selectModelForOneTurn: rs.fn() };
    (s.deps.agentSessionManager.find as ReturnType<typeof rs.fn>).mockReturnValue(session);
    (s.deps.webchatRepo.updateSessionLargeModelSelection as ReturnType<typeof rs.fn>).mockClear();
    expect(
      await s.service.switchForModelLimit(CONCIERGE_CHAT, failure("You've hit your Opus limit")),
    ).toMatchObject({ selectionId: "claude-sonnet" });
    expect(s.deps.webchatRepo.updateSessionLargeModelSelection).not.toHaveBeenCalled();
    expect(session.selectModel).not.toHaveBeenCalled();
    expect(session.selectModelForOneTurn).toHaveBeenCalledWith("claude-sonnet");
  });
  it("an overload swap needs the chat's live session, and moves nothing without one", async () => {
    const { s } = await prepared({ startEvents: false });
    (s.deps.agentSessionManager.find as ReturnType<typeof rs.fn>).mockReturnValue(undefined);
    expect(
      await s.service.switchForModelLimit(CONCIERGE_CHAT, failure("You've hit your Opus limit")),
    ).toBeNull();
    expect(s.deps.webchatRepo.addBackendMessage).not.toHaveBeenCalled();
  });
  it("keeps a chat on Rome credits there when Codex's model hits its limit", async () => {
    const { s } = await prepared({ startEvents: false });
    // An owner-free chat on a Claude model, while every chat runs on Rome credits: it runs on Codex.
    s.service.deps.defaults = { current: () => "rome_credits" };
    const selectModelForOneTurn = rs.fn();
    (s.deps.agentSessionManager.find as ReturnType<typeof rs.fn>).mockReturnValue({
      selectModel: rs.fn(),
      selectModelForOneTurn,
    });
    expect(
      await s.service.switchForModelLimit(
        CONCIERGE_CHAT,
        failure("Selected model is at capacity.", "openai"),
      ),
    ).toMatchObject({ from: "openai", to: "openai", selectionId: "gpt-6-luna" });
    expect(selectModelForOneTurn).toHaveBeenCalledWith("gpt-6-luna");
  });
  it("a chat held on its own account is not on Rome credits when its model hits its limit", async () => {
    const { s } = await prepared({ startEvents: false });
    s.service.deps.defaults = { current: () => "rome_credits" };
    s.service.deps.held = () => true;
    // Held on Claude: the swap stays on Claude, not on Codex through the credits.
    expect(
      await s.service.switchForModelLimit(CONCIERGE_CHAT, failure("You've hit your Opus limit")),
    ).toMatchObject({ from: "anthropic", to: "anthropic", selectionId: "claude-sonnet" });
  });
  it("counts Rome credits only while no account is logged in, as every chat does", async () => {
    const { s } = await prepared({ startEvents: false });
    // A stale default of Rome credits beside a Claude login runs nothing on them.
    s.service.deps.defaults = {
      current: () => "rome_credits",
      signedIn: () => ({ anthropic: true, openai: false, rome_credits: false }),
    };
    expect(
      await s.service.switchForModelLimit(CONCIERGE_CHAT, failure("You've hit your Opus limit")),
    ).toMatchObject({ from: "anthropic", selectionId: "claude-sonnet" });
  });
  it("moves a chat whose turns never ran off the provider's strong model", async () => {
    const { s } = await prepared({ startEvents: false });
    await s.deps.webchatRepo.updateSessionLargeModelSelection(CONCIERGE_CHAT, null, "auto");
    expect(
      await s.service.switchForModelLimit(
        CONCIERGE_CHAT,
        failure("Selected model is at capacity. Please try a different model.", "openai"),
      ),
    ).toMatchObject({ from: "openai", to: "openai" });
  });
  it("never moves off a model its owner picked: the chat shows a card", async () => {
    const { s } = await prepared({ startEvents: false });
    await s.deps.webchatRepo.updateSessionLargeModelSelection(
      CONCIERGE_CHAT,
      "claude-sonnet",
      "owner",
    );
    expect(
      await s.service.switchForModelLimit(CONCIERGE_CHAT, failure("You've hit your Sonnet limit")),
    ).toBeNull();
    expect(s.deps.webchatRepo.addBackendMessage).not.toHaveBeenCalled();
  });
  it.each(["api source", "other chat"])("refuses %s", async (kind) => {
    const { s, raw } = await prepared({ startEvents: false });
    if (kind === "api source")
      raw.anthropic = reportOf("available", {
        authMethod: "environment",
        usageLimited: false,
      });
    expect(
      await s.service.switchForModelLimit(
        kind === "other chat" ? "task" : CONCIERGE_CHAT,
        failure("You've hit your Opus limit"),
      ),
    ).toBeNull();
    expect(s.deps.webchatRepo.addBackendMessage).not.toHaveBeenCalled();
  });
  it("an overload swap lasts one turn: the chat's own model, still overloaded, swaps again", async () => {
    const { s } = await prepared({ startEvents: false });
    await s.deps.webchatRepo.updateSessionLargeModelSelection(
      CONCIERGE_CHAT,
      "claude-sonnet",
      "auto",
    );
    expect(
      await s.service.switchForModelLimit(CONCIERGE_CHAT, failure("Sonnet limit")),
    ).toMatchObject({ selectionId: "claude-opus-5-5" });
    // The next turn ran Sonnet again, and it is still at its limit.
    expect(
      await s.service.switchForModelLimit(CONCIERGE_CHAT, failure("Sonnet limit")),
    ).toMatchObject({ selectionId: "claude-opus-5-5" });
    expect(s.sessions.get(CONCIERGE_CHAT)).toMatchObject({ largeModelSelection: "claude-sonnet" });
  });
  it("blocks a swap to a model the chat left for ten minutes, and permits it after", async () => {
    const { s } = await prepared({ startEvents: false });
    const now = rs.spyOn(Date, "now").mockReturnValue(1_000_000);
    await s.deps.webchatRepo.updateSessionLargeModelSelection(
      CONCIERGE_CHAT,
      "claude-sonnet",
      "auto",
    );
    expect(
      await s.service.switchForModelLimit(CONCIERGE_CHAT, failure("Sonnet limit")),
    ).toMatchObject({ selectionId: "claude-opus-5-5" });
    // The chat's own model is now Opus: a swap back to Sonnet waits ten minutes.
    await s.deps.webchatRepo.updateSessionLargeModelSelection(
      CONCIERGE_CHAT,
      "claude-opus-5-5",
      "auto",
    );
    expect(await s.service.switchForModelLimit(CONCIERGE_CHAT, failure("Opus limit"))).toBeNull();
    now.mockReturnValue(1_600_001);
    expect(
      await s.service.switchForModelLimit(CONCIERGE_CHAT, failure("Opus limit")),
    ).toMatchObject({ selectionId: "claude-sonnet" });
    now.mockRestore();
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
  ] as const)("runs one recovery after a %s failure, and nothing more when it fails too", async (reason) => {
    const { s } = await prepared({ delay: async () => {} });
    s.onBackendTurn(() => {
      void finish(s, failure("Connection error"), "recovery");
    });
    await finish(
      s,
      failure(reason === "temporary" ? "Connection error" : "You've hit your Opus limit"),
    );
    await s.settle();
    expect(s.backendTurns).toHaveLength(1);
    expect(s.backendTurns[0]?.prompt).toContain("Do only what remains");
    // Only the model-limit move writes a note; no other provider takes over.
    expect(s.deps.webchatRepo.addBackendMessage).toHaveBeenCalledTimes(
      reason === "temporary" ? 0 : 1,
    );
    // Neither stores another model: a model-limit swap lasts its one turn.
    expect(s.sessions.get(CONCIERGE_CHAT)).toMatchObject({
      largeModelSelection: "claude-opus-5-5",
    });
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
    // A failed retry is not retried again, on this provider or another.
    expect(retries).toBe(1);
    expect(s.backendTurns.filter((turn) => turn.prompt.includes("<quota_recovery>"))).toHaveLength(
      1,
    );
    expect(s.deps.webchatRepo.addBackendMessage).not.toHaveBeenCalled();
    expect(delay).toHaveBeenCalledTimes(1);
  });
  it.each([
    { code: "model_unavailable" },
    { reason: "model_access_denied" },
  ] as const)("moves a structured model refusal %j to another model on the same provider", async (fields) => {
    const { s } = await prepared();
    await s.deps.webchatRepo.updateSessionLargeModelSelection(CONCIERGE_CHAT, "gpt-6-luna", "auto");
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
    expect(s.deps.webchatRepo.addBackendMessage).toHaveBeenLastCalledWith(
      CONCIERGE_CHAT,
      expect.any(String),
      [expect.objectContaining({ type: "quota_switch", model: "gpt-5.6-terra", oneTurn: true })],
    );
    expect(s.sessions.get(CONCIERGE_CHAT)).toMatchObject({ largeModelSelection: "gpt-6-luna" });
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
      await s.service.switchForModelLimit(CONCIERGE_CHAT, failure("Sonnet limit")),
    ).toMatchObject({ selectionId: "claude-opus-5-5" });
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
    await s.deps.webchatRepo.updateSessionLargeModelSelection(TOPIC_CHAT, "claude-sonnet", "auto");
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
      failure: failure("You've hit your Sonnet limit"),
      text: "done",
    });
    await s.settle();
    expect(s.backendTurns.at(-1)).toMatchObject({ threadId: TOPIC_CHAT });
    expect(s.sessions.get(TOPIC_CHAT)).toMatchObject({ largeModelSelection: "claude-sonnet" });
    // The topic chat left Sonnet; the main chat may still move to it.
    expect(
      await s.service.switchForModelLimit(CONCIERGE_CHAT, failure("You've hit your Opus limit")),
    ).toMatchObject({ selectionId: "claude-sonnet" });
  });

  it("hands a model limit no other model could take to the card handler", async () => {
    const unrecovered = rs.fn(async () => {});
    const { s } = await prepared({ unrecovered });
    await s.deps.webchatRepo.updateSessionLargeModelSelection(
      CONCIERGE_CHAT,
      "claude-opus-5-5",
      "owner",
    );
    await finish(s, failure("You've hit your Opus limit"));
    await s.settle();
    expect(s.backendTurns).toHaveLength(0);
    expect(unrecovered).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: CONCIERGE_CHAT, turnId: "failed" }),
    );
  });

  it("hands a temporary failure its retry did not get past to the card handler", async () => {
    const unrecovered = rs.fn(async () => {});
    const { s } = await prepared({ delay: async () => {}, unrecovered });
    s.onBackendTurn(() => {
      void finish(s, failure("Connection error"), "retry");
    });
    await finish(s, failure("Connection error"));
    await s.settle();
    expect(s.backendTurns).toHaveLength(1);
    expect(unrecovered).toHaveBeenCalledWith(expect.objectContaining({ turnId: "retry" }));
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

  it("moves an unused chat Rome chose a model for to the default provider before opening its runtime for a delivery", async () => {
    const s = setup({ startEvents: false });
    s.deps.sessionRepository.current = (async () => null) as never;
    s.deps.accounts = fakeAccounts(bothAvailable());
    s.service.deps.defaults = { current: () => "openai" };
    s.sessions.set(CONCIERGE_CHAT, {
      ...s.sessions.get(CONCIERGE_CHAT),
      largeModelSelection: "claude-opus-5-5",
      largeModelSelectionBy: "auto",
    });
    const openedOn: unknown[] = [];
    s.chats.openSession = rs.fn(async (chatId: string) => {
      openedOn.push(s.sessions.get(chatId)?.largeModelSelection);
      return `opened-${chatId}`;
    });
    await s.service.runSystemTurn(CONCIERGE_CHAT, "<external_events/>");
    // The runtime opens on the default provider's model.
    expect(openedOn).toEqual(["gpt-6-1-sol"]);
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
    const oldId = (await s.makeTaskRow({ title: "Old", chatId: TOPIC_CHAT })).id;
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

  it("knows a topic chat of its owner whether it is archived or not, and never the main chat or another person's", async () => {
    const s = setup({ startEvents: false });
    expect(await s.service.isTopicChatOf(TOPIC_CHAT, "guardian")).toBe(true);
    // An archived topic chat is in no list, but its unarchive asks about it.
    s.sessions.set(TOPIC_CHAT, { ...s.sessions.get(TOPIC_CHAT), archivedAt: new Date() });
    expect(await s.service.conciergeChat(TOPIC_CHAT)).toBeNull();
    expect(await s.service.isTopicChatOf(TOPIC_CHAT, "guardian")).toBe(true);
    expect(await s.service.isTopicChatOf(TOPIC_CHAT, "visitor:acct-ann")).toBe(false);
    expect(await s.service.isTopicChatOf(CONCIERGE_CHAT, "guardian")).toBe(false);
    expect(await s.service.isTopicChatOf("gone", "guardian")).toBe(false);
  });

  it("restoring an archived topic chat reads its rows as its own again, and moves its follows back only when asked", async () => {
    const s = setup({ startEvents: false });
    await s.storedChats.createSession(TOPIC_CHAT, "Calendar");
    s.turnIn(TOPIC_CHAT);
    await s.tool("say", { text: "On it" });
    await s.tool("chat_start", { title: "Book dentist", brief: "Book it" });
    const moves: unknown[][] = [];
    const restores: unknown[][] = [];
    s.service.attachFollowing({
      moveToMainChat: async (...args: unknown[]) => (moves.push(args), 1),
      followsOfChat: async () => [],
      followsMovedFrom: async () => [{ source: "github", label: "GitHub", target: "acme/widgets" }],
      restoreToChat: async (...args: unknown[]) => (restores.push(args), 1),
    } as unknown as ConciergeFollowing);
    await s.storedChats.archiveSession(TOPIC_CHAT);
    await s.service.retireChat(TOPIC_CHAT, "archived");
    // An archive marks the follows it moves, so a restore can move them back.
    expect(moves).toEqual([[TOPIC_CHAT, null, true]]);
    expect(await s.service.followsAndTasksOf(TOPIC_CHAT, "guardian")).toMatchObject({
      movedFollows: [{ source: "github", label: "GitHub", target: "acme/widgets" }],
    });
    const chatOfRow = async () =>
      (await s.tasks.listForPanel()).find((row) => row.title === "Book dentist")?.conciergeChat.id;
    expect(await chatOfRow()).toBe(CONCIERGE_CHAT);

    await s.storedChats.unarchiveSession(TOPIC_CHAT);
    await s.service.restoreChat(TOPIC_CHAT, true);
    expect(restores).toEqual([[TOPIC_CHAT, null, "guardian", true]]);
    // The row was never moved, so it is the topic chat's again.
    expect(await chatOfRow()).toBe(TOPIC_CHAT);
    // The main chat is never restored.
    await s.service.restoreChat(CONCIERGE_CHAT, true);
    expect(restores).toHaveLength(1);
  });

  describe("ending a topic chat's follows and tasks before it is deleted", () => {
    /** "Calendar" has a task chat that runs, one that is finished, and one more that is open. */
    const withWork = async () => {
      const s = setup({ startEvents: false });
      await s.storedChats.createSession(TOPIC_CHAT, "Calendar");
      s.turnIn(TOPIC_CHAT);
      await s.tool("say", { text: "On it" });
      const running = JSON.parse(
        (await s.tool("chat_start", { title: "Book dentist", brief: "Book it" })).content[0].text,
      ) as { chatId: string; taskId: string };
      const oldId = (await s.makeTaskRow({ title: "Old", chatId: TOPIC_CHAT })).id;
      const looseId = (await s.makeTaskRow({ title: "Loose", chatId: TOPIC_CHAT })).id;
      await s.taskRepo.setLastOutcome(oldId, "succeeded", new Date(), { reported: false });
      s.tasks.attachFacts({
        now: () => Date.now(),
        running: (chatId) => chatId === running.chatId || chatId === looseId,
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
        followsMovedFrom: async () => [],
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
        stoppedAt: expect.any(Date),
        archivedAt: expect.any(Date),
      });
      expect(await s.taskRepo.get(looseId)).toMatchObject({
        stoppedAt: expect.any(Date),
        archivedAt: expect.any(Date),
      });
      // Ended·stopped, not open, and the finished one is as it was.
      const status = await s.tasks.statusOf(
        [(await s.taskRepo.get(running.taskId))!, (await s.taskRepo.get(looseId))!],
        { asReported: true },
      );
      expect([...status.values()].map((one) => one.status)).toEqual(["ended", "ended"]);
      expect(await s.taskRepo.get(oldId)).toMatchObject({ stoppedAt: null });
      // The task is archived with its chat, so the main chat's panel does not list it.
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
      // Both open tasks are gone from it.
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
      // A task ended with the chat is stopped without a stopped_by_owner report.
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
        followsMovedFrom: async () => [],
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

  it("flags in the digest a task still waiting on a check it scheduled three times", async () => {
    const s = setup({ startEvents: false });
    const often = await s.makeTaskRow({ title: "CI run", chatId: CONCIERGE_CHAT });
    const once = await s.makeTaskRow({ title: "Reply", chatId: CONCIERGE_CHAT });
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
});

describe("Concierge connect_card", () => {
  const text = (result: RomeToolResult) => JSON.parse(result.content[0].text);
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

  it("replies to nothing, even where the guardian wrote inside a thread", async () => {
    const s = setup({ said: false });
    withServices(s, [
      { service: "mail", label: "Mail", icon: "glyph:gmail", state: null, connect: MAIL_CONNECT },
    ]);
    s.messages.set(CONCIERGE_CHAT, [
      { id: "g0", role: "user", content: textContent("Plan Kyoto"), turnId: "older" },
      {
        id: "g1",
        role: "user",
        content: textContent("Connect my mail"),
        turnId: "concierge-turn-1",
        replyTo: "g0",
        chatThread: "g0",
      },
    ]);

    await s.tool("connect_card", { service: "mail" });

    expect(s.deps.webchatRepo.addBackendMessage).toHaveBeenCalledWith(
      CONCIERGE_CHAT,
      "concierge-turn-1",
      [expect.objectContaining({ type: "connect_card", service: "mail" })],
      {},
    );
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

  it("takes the one service labelled with the name it was given", async () => {
    const s = setup();
    withServices(s, [
      { service: "slack_app", label: "Slack", state: "working", connect: null },
      { service: "mail", label: "Mail", state: null, connect: MAIL_CONNECT },
    ]);

    const result = await s.tool("connect_card", { service: "slack" });

    expect(result.isError).toBeFalsy();
    expect(text(result)).toMatchObject({ connected: true });
    expect(cards(s)).toEqual([]);
  });

  it("refuses a name several services are labelled with, naming each", async () => {
    const s = setup();
    withServices(s, [
      { service: "slack_app", label: "Slack", state: "working", connect: null },
      { service: "slack_bot", label: "Slack", state: null, connect: null },
    ]);

    const result = await s.tool("connect_card", { service: "slack" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("slack_app (working), slack_bot (not connected)");
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

describe("Concierge show_card", () => {
  const ITINERARY = {
    components: [
      { id: "root", component: "Column", children: ["title", "steps"] },
      { id: "title", component: "Text", text: "Saturday in Kyoto", variant: "h3" },
      { id: "steps", component: "List", children: ["s1", "s2"] },
      { id: "s1", component: "Text", text: "9:00 Fushimi Inari" },
      { id: "s2", component: "Text", text: "13:00 Nishiki Market" },
    ],
  };
  const TEXT = "Saturday in Kyoto: 9:00 Fushimi Inari, 13:00 Nishiki Market";

  const rows = (s: ReturnType<typeof setup>) =>
    (s.messages.get(CONCIERGE_CHAT) ?? []).map((row) => JSON.parse(row.content));

  it("stores the card as a widget of Rome's own, with its plain-text line", async () => {
    const s = setup();

    const result = await s.tool("show_card", { ui: ITINERARY, text: TEXT });

    expect(result.isError).toBeFalsy();
    expect(rows(s)).toEqual([
      [
        {
          type: "widget",
          toolUseId: expect.any(String),
          appId: "core",
          text: TEXT,
          ui: ITINERARY,
        },
      ],
    ]);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ messageId: "said-1" });
  });

  it("refuses a card with a button and says why, showing nothing", async () => {
    const s = setup();
    const ui = {
      components: [
        { id: "root", component: "Button", child: "label", action: { event: { name: "go" } } },
        { id: "label", component: "Text", text: "Go" },
      ],
    };

    const result = await s.tool("show_card", { ui, text: "Go" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Button");
    expect(result.content[0].text).toContain("say");
    expect(rows(s)).toEqual([]);
  });

  it("refuses a card where cards cannot show, and asks for the content as text", async () => {
    const s = setup();
    s.drawWidgets("plain_text");

    const result = await s.tool("show_card", { ui: ITINERARY, text: TEXT });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("cannot show cards");
    expect(rows(s)).toEqual([]);
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
      `<task_events>\n<task chat_id="${task!.id}" title="Weather">\n</task>\n</task_events>`,
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

  describe("a task's result told with say", () => {
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
    const idOf = (result: RomeToolResult) => JSON.parse(result.content[0].text).messageId as string;

    it("replies to the task's start message and settles the result as told", async () => {
      const { s, taskId } = await finishedWith(concluded("Found 3 flights. Which one?"));
      const start = await startKeyOf(s, taskId);
      const noted = rs.spyOn(s.service, "noteSaid");
      const settled = rs.spyOn(s.tasks, "resultSaid");
      const said = idOf(
        await s.tool("say", {
          text: "Found 3 flights, cheapest ¥4,380. Which one?",
          format: "long",
          replyTo: start,
        }),
      );
      expect(replyOfId(s, said)).toBe(start);
      expect(noted).toHaveBeenCalledWith(taskId);
      expect(settled).toHaveBeenCalledWith(taskId);
      // The message tells the result: it moves neither the start message nor the row.
      expect(await startKeyOf(s, taskId)).toBe(start);
    });

    it("tells a task with no conclusion in one message that replies to its start message", async () => {
      const { s, taskId } = await finishedWith("Details, but no conclusion section.");
      const start = await startKeyOf(s, taskId);
      const settled = rs.spyOn(s.tasks, "resultSaid");
      const said = idOf(
        await s.tool("say", { text: "Found 3 flights, cheapest ¥4,380.", replyTo: start }),
      );
      expect(replyOfId(s, said)).toBe(start);
      expect(settled).toHaveBeenCalledWith(taskId);
    });

    it("replies to nothing when a say in a report turn names no message, and says the result unsettled", async () => {
      const { s, taskId } = await finishedWith(concluded("Found 3 flights."));
      s.reportedTask(taskId);
      const settled = rs.spyOn(s.tasks, "resultSaid");
      const said = idOf(await s.tool("say", { text: "Found 3 flights, cheapest ¥4,380." }));
      expect(replyOfId(s, said)).toBeUndefined();
      expect(settled).not.toHaveBeenCalled();
    });

    it("takes an automated input as a message the turn answers", async () => {
      const { s } = await finishedWith(concluded("Done."));
      const list = s.messages.get(CONCIERGE_CHAT) ?? [];
      list.push({
        id: "auto",
        role: "user",
        content: "[]",
        turnId: "report-turn",
        senderId: "automated::0::routine:Morning briefing",
      });
      s.messages.set(CONCIERGE_CHAT, list);
      const said = await s.tool("say", { text: "Noted.", replyTo: "auto" });
      expect(said.isError).toBeFalsy();
    });

    describe("chat_send moves the start message to the guardian message it relays", () => {
      /** The guardian follows up in turn `turn` with message `id`, and the Concierge relays it. */
      const followUp = async (
        s: ReturnType<typeof setup>,
        chatId: string,
        id: string,
        turn: string,
      ) => {
        s.inTurn(turn);
        guardianSays(s, id, turn);
        await s.tool("chat_send", { chatId, text: "Make it Saturday" });
      };

      it("so the next result replies to the latest request and settles as told", async () => {
        const s = setup({ said: false });
        guardianSays(s, "g1");
        const { chatId, taskId } = await started(s);
        expect(await startKeyOf(s, taskId)).toBe("g1");

        await followUp(s, chatId, "g2", "follow-up");

        expect(await startKeyOf(s, taskId)).toBe("g2");
        const listed = JSON.parse((await s.tool("chat_list", {})).content[0].text) as Array<{
          chatId: string;
          startMessageId?: string;
        }>;
        expect(listed.find((chat) => chat.chatId === taskId)?.startMessageId).toBe("g2");

        s.messages.get(chatId)?.push({
          role: "assistant",
          content: JSON.stringify([{ type: "text", content: concluded("Saturday works.") }]),
        });
        await finishTask(s, chatId, "completed", { reported: false });
        s.inTurn("report-turn");
        const noted = rs.spyOn(s.service, "noteSaid");
        const settled = rs.spyOn(s.tasks, "resultSaid");
        const said = idOf(await s.tool("say", { text: "Saturday works.", replyTo: "g2" }));
        expect(replyOfId(s, said)).toBe("g2");
        expect(noted).toHaveBeenCalledWith(taskId);
        expect(settled).toHaveBeenCalledWith(taskId);
      });

      it("only once the task has taken it", async () => {
        const s = setup({ said: false });
        guardianSays(s, "g1");
        const { chatId, taskId } = await started(s);
        s.refuseSends({ ok: false, invalid: "busy" });
        s.inTurn("follow-up");
        guardianSays(s, "g2", "follow-up");
        expect((await s.tool("chat_send", { chatId, text: "Faster" })).isError).toBe(true);
        expect(await startKeyOf(s, taskId)).toBe("g1");
      });

      it("only for a message the guardian sent, not an automated input", async () => {
        const s = setup({ said: false });
        guardianSays(s, "g1");
        const { chatId, taskId } = await started(s);
        s.inTurn("wake-up");
        const list = s.messages.get(CONCIERGE_CHAT) ?? [];
        list.push({
          id: "auto",
          role: "user",
          content: "[]",
          turnId: "wake-up",
          senderId: "automated::0::routine:Morning briefing",
        });
        s.messages.set(CONCIERGE_CHAT, list);
        await s.tool("chat_send", { chatId, text: "Check again" });
        expect(await startKeyOf(s, taskId)).toBe("g1");
      });

      describe("when the turn carries several guardian messages", () => {
        const statusOf = async (s: ReturnType<typeof setup>, key: string) =>
          (await s.tasks.messageStatusesOf(CONCIERGE_CHAT, [key])).get(key) ?? null;
        /** Task "Weather" started for g1; turn "follow-up" took g2 and g3. */
        const twoInOneTurn = async () => {
          const s = setup({ said: false });
          guardianSays(s, "g1");
          const { chatId, taskId } = await started(s);
          s.inTurn("follow-up");
          guardianSays(s, "g2", "follow-up");
          guardianSays(s, "g3", "follow-up");
          return { s, chatId, taskId };
        };

        it("links and moves nothing when no message is named, and still sends", async () => {
          const { s, chatId, taskId } = await twoInOneTurn();
          const sent = s.posted.length;
          const result = await s.tool("chat_send", { chatId, text: "Make it Saturday" });
          expect(result.isError).toBeFalsy();
          expect(s.posted).toHaveLength(sent + 1);
          expect(await startKeyOf(s, taskId)).toBe("g1");
          expect([await statusOf(s, "g2"), await statusOf(s, "g3")]).toEqual([null, null]);
        });

        it("links and moves to the message `answers` names", async () => {
          const { s, chatId, taskId } = await twoInOneTurn();
          await s.tool("chat_send", { chatId, text: "Make it Saturday", answers: "g2" });
          expect(await startKeyOf(s, taskId)).toBe("g2");
          expect([await statusOf(s, "g2"), await statusOf(s, "g3")]).toEqual(["working", null]);
        });

        it("takes a message an interrupted turn handed on as `answers`", async () => {
          const s = setup({ said: false });
          guardianSays(s, "g1");
          const { chatId, taskId } = await started(s);
          guardianSays(s, "g2", "cut-short");
          s.inTurn("follow-up");
          guardianSays(s, "g3", "follow-up");
          s.service.handOnPrompts(CONCIERGE_CHAT, ["g2"]);
          await s.tool("chat_send", { chatId, text: "Make it Saturday" });
          expect(await startKeyOf(s, taskId)).toBe("g1");
          await s.tool("chat_send", { chatId, text: "Make it Saturday", answers: "g2" });
          expect(await startKeyOf(s, taskId)).toBe("g2");
        });

        it("refuses an id that is no guardian message of this chat, and sends nothing", async () => {
          const { s, chatId, taskId } = await twoInOneTurn();
          const list = s.messages.get(CONCIERGE_CHAT) ?? [];
          list.push({
            id: "auto",
            role: "user",
            content: "[]",
            turnId: "follow-up",
            senderId: "automated::0::routine:Morning briefing",
          });
          list.push({ id: "said", role: "assistant", content: "[]", turnId: "follow-up" });
          const sent = s.posted.length;
          for (const answers of ["no-such-message", "auto", "said"]) {
            const result = await s.tool("chat_send", { chatId, text: "Faster", answers });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain(`No guardian message ${answers}`);
          }
          expect(s.posted).toHaveLength(sent);
          expect(await startKeyOf(s, taskId)).toBe("g1");
        });
      });

      it("never for a task another Concierge chat started", async () => {
        const s = setup({ said: false });
        await s.storedChats.createSession(TOPIC_CHAT, "Calendar");
        guardianSays(s, "g1");
        const { chatId, taskId } = await started(s);
        s.messages.set(TOPIC_CHAT, [
          { id: "t1", role: "user", content: "[]", turnId: "follow-up" },
        ]);
        s.turnIn(TOPIC_CHAT);
        s.inTurn("follow-up");
        expect((await s.tool("chat_send", { chatId, text: "Faster" })).isError).toBe(true);
        expect(await startKeyOf(s, taskId)).toBe("g1");
        expect((await s.taskRepo.get(taskId))?.chatId).toBeNull();
      });
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
    expect(await s.taskRepo.get(taskId)).toMatchObject({ stoppedAt: expect.any(Date) });
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
    expect(await s.taskRepo.get(taskId)).toMatchObject({ stoppedAt: expect.any(Date) });
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
        await s.tool("say", { text: "Quiet one, thanks.", replyTo: "chat" });
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
        await s.tool("say", { text: "It's still checking.", replyTo: await startKeyOf(s, taskId) });
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
        await s.tool("say", {
          text: "The weather task is done.",
          replyTo: await startKeyOf(s, taskId),
        });
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
      await s.tool("say", { text: "Sunny all week", replyTo: await startKeyOf(s, taskId) });
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
      await s.tool("say", { text: "Sunny all week", replyTo: await startKeyOf(s, taskId) });
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
      await s.tool("say", {
        text: "Weather is still running?",
        replyTo: await startKeyOf(s, taskId),
      });
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
      const { chatId, taskId } = await started(s);
      replies(s, chatId);
      guardianTyped(s, chatId);
      s.fakeTimers();
      s.onBackendTurn(() => "interrupted");
      await finishTask(s, chatId, "completed", { reported: false });
      await rs.advanceTimersByTimeAsync(60_000);
      expect(s.backendTurns).toHaveLength(1);
      s.onBackendTurn(() => "completed");
      // The turn that took the report over fails to store the message.
      s.inTurn("takeover");
      guardianSays(s, "g2", "takeover");
      s.deps.webchatRepo.addBackendMessage = async () => {
        throw new Error("disk full");
      };
      expect(
        await s.tool("say", { text: "Sunny", replyTo: await startKeyOf(s, taskId) }),
      ).toMatchObject({ isError: true });
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
      await s.tool("say", { text: "Sunny all week", replyTo: await startKeyOf(s, weather.taskId) });
      await s.tool("say", {
        text: "Roads are clear",
        replyTo: await startKeyOf(s, traffic.taskId),
      });
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
    /**
     * The send route records the message a Concierge turn took. `joined`
     * when the turn had called a tool before.
     */
    const taken = async (
      s: ReturnType<typeof setup>,
      key: string,
      turnId = "concierge-turn-1",
      { joined = false }: { joined?: boolean } = {},
    ) => {
      await s.taskRepo.takeMessage(turnId, { chatId: CONCIERGE_CHAT, messageKey: key });
      s.service.messageStatus.taken(CONCIERGE_CHAT, key, turnId, { joined });
      lastTurn = turnId;
    };
    /** The turn that took a message last: the one that calls tools. */
    let lastTurn = "concierge-turn-1";
    let calls = 0;
    /**
     * The latest turn calls `tool`: answers its grace running out, and how
     * to end the call.
     */
    const callTool = (s: ReturnType<typeof setup>, tool: string, turnId = lastTurn) => {
      const id = `call-${++calls}`;
      return {
        ran: s.service.messageStatus.toolCalled(CONCIERGE_CHAT, turnId, tool, id),
        end: () => s.service.messageStatus.toolEnded(CONCIERGE_CHAT, turnId, id),
      };
    };
    /** A working tool call of the turn runs past its grace, on a clock moved by hand. */
    const workedLong = async (s: ReturnType<typeof setup>, tool = "chat_read") => {
      const { ran } = callTool(s, tool);
      await rs.advanceTimersByTimeAsync(WORKING_GRACE_MS);
      await ran;
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

    it("works once a working tool call ran half a second, and clears when the turn ends with no task", async () => {
      const s = setup({ said: false });
      s.fakeTimers();
      guardianSays(s, "g1");
      await taken(s, "g1");
      const seen = watch(s);
      // Sending a message or a reaction is no work, however long it takes.
      callTool(s, "mcp__rome__say");
      callTool(s, "react");
      await rs.advanceTimersByTimeAsync(5_000);
      expect(await statusOf(s, "g1")).toBeNull();
      const { ran } = callTool(s, "mcp__rome__execute_action");
      await rs.advanceTimersByTimeAsync(WORKING_GRACE_MS - 100);
      expect(await statusOf(s, "g1")).toBeNull();
      await rs.advanceTimersByTimeAsync(100);
      await ran;
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

    it("shows only the reaction for quick work the turn reacts to within the grace", async () => {
      const s = setup({ said: false });
      s.fakeTimers();
      guardianSays(s, "g1");
      const seen = watch(s);
      await taken(s, "g1");
      // A quick defer, then a reaction: no call ran past its grace.
      const call = callTool(s, "defer");
      await rs.advanceTimersByTimeAsync(50);
      call.end();
      await rs.advanceTimersByTimeAsync(3_000);
      expect((await s.tool("react", { emoji: "👍" })).isError).toBeFalsy();
      await rs.advanceTimersByTimeAsync(10_000);
      await conciergeEnds(s);
      await rs.advanceTimersByTimeAsync(100);
      expect(seen.filter(([, status]) => status !== null)).toEqual([]);
      expect(s.reactions.get(`${CONCIERGE_CHAT}:g1`)).toBe("👍");
    });

    it("works at the turn's second working tool call, however short each call is", async () => {
      const s = setup({ said: false });
      s.fakeTimers();
      guardianSays(s, "g1");
      await taken(s, "g1");
      const first = callTool(s, "Read");
      await rs.advanceTimersByTimeAsync(30);
      first.end();
      await rs.advanceTimersByTimeAsync(3_000);
      expect(await statusOf(s, "g1")).toBeNull();
      const second = callTool(s, "Read");
      await second.ran;
      expect(await statusOf(s, "g1")).toBe("working");
    });

    it("never counts one turn's calls toward the next one's", async () => {
      const s = setup({ said: false });
      s.fakeTimers();
      const seen = watch(s);
      // Turn a: one quick call and a reaction; a newer message takes it over.
      guardianSays(s, "g1", "turn-a");
      await taken(s, "g1", "turn-a");
      s.inTurn("turn-a");
      callTool(s, "defer").end();
      await s.tool("react", { emoji: "👍", message_id: "g1" });
      // A call of turn a still runs when turn b takes over: its timer goes with it.
      callTool(s, "chat_read");
      s.chats.activeTurns = () => ["turn-b"];
      await conciergeEnds(s, "interrupted", "turn-a");
      // Turn b: one quick call and a reaction of its own.
      guardianSays(s, "g2", "turn-b");
      await taken(s, "g2", "turn-b");
      s.inTurn("turn-b");
      const call = callTool(s, "defer");
      await rs.advanceTimersByTimeAsync(30);
      call.end();
      expect((await s.tool("react", { emoji: "👍", message_id: "g2" })).isError).toBeFalsy();
      await rs.advanceTimersByTimeAsync(5_000);
      expect(seen.filter(([, status]) => status !== null)).toEqual([]);
      expect([
        s.reactions.get(`${CONCIERGE_CHAT}:g1`),
        s.reactions.get(`${CONCIERGE_CHAT}:g2`),
      ]).toEqual(["👍", "👍"]);
    });

    it.each([
      ["set after its turn ended keeps a task made for it from showing working", "👍", null],
      ["cleared after its turn ended lets a task made for it show working", null, "working"],
    ] as const)("a reaction %s", async (_, later, expected) => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      await taken(s, "g1");
      if (later === null) await s.tool("react", { emoji: "👍" });
      else await s.tool("say", { text: "Sure." });
      await conciergeEnds(s);
      await s.settle();
      // A later turn changes the reaction on the settled message, then starts a task for it.
      s.inTurn("concierge-turn-2");
      await s.tool("react", { emoji: later, message_id: "g1" });
      await started(s, { answers: "g1" });
      await s.settle();
      expect(await statusOf(s, "g1")).toBe(expected);
    });

    it("shows work past the grace as working, and takes no reaction after it", async () => {
      const s = setup({ said: false });
      s.fakeTimers();
      guardianSays(s, "g1");
      await taken(s, "g1");
      await workedLong(s);
      expect(await statusOf(s, "g1")).toBe("working");
      const refused = await s.tool("react", { emoji: "✅" });
      expect(refused.isError).toBeFalsy();
      expect(refused.content[0].text).toContain("already showed 👀 working");
      expect(s.reactions.has(`${CONCIERGE_CHAT}:g1`)).toBe(false);
      expect(await statusOf(s, "g1")).toBe("working");
      // The answer clears it; a reaction afterwards is refused all the same.
      await s.tool("say", { text: "Noted." });
      expect(await statusOf(s, "g1")).toBeNull();
      await s.tool("react", { emoji: "👍" });
      expect(s.reactions.has(`${CONCIERGE_CHAT}:g1`)).toBe(false);
    });

    it.each([
      ["error", "failed"],
      ["interrupted", null],
      ["completed", null],
    ] as const)("a turn that ends %s before answering leaves the message %s", async (status, expected) => {
      const s = setup({ said: false });
      s.fakeTimers();
      guardianSays(s, "g1");
      await taken(s, "g1");
      await workedLong(s);
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

    it("keeps a task's message working while the task runs, clears it while the task waits on the guardian, and works again until its result is reported", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      await taken(s, "g1");
      const { chatId } = await started(s);
      await conciergeEnds(s);
      await s.settle();
      expect(await statusOf(s, "g1")).toBe("working");
      // The task asks the guardian: the message no longer works. Its task link and
      // the Tasks button show that it needs them, whether or not any card was shown.
      const repo = s.deps.webchatRepo as unknown as {
        openWaitsOf: (ids: readonly string[]) => Promise<Map<string, unknown>>;
      };
      const seen = watch(s);
      repo.openWaitsOf = async (ids) =>
        approvalWaits(new Map(ids.filter((id) => id === chatId).map((id) => [id, Date.now()])));
      await s.tasks.chatChanged(chatId);
      await s.settle();
      expect(await statusOf(s, "g1")).toBeNull();
      expect(seen.at(-1)).toEqual(["g1", null]);
      // Answered, it works again, through its end until its result is reported.
      repo.openWaitsOf = async () => new Map();
      expect(await statusOf(s, "g1")).toBe("working");
      await finishTask(s, chatId, "completed", { reported: false });
      expect(await statusOf(s, "g1")).toBe("working");
      await reportEnds(s, chatId);
      expect(await statusOf(s, "g1")).toBeNull();
    });

    it("clears a task's message the moment its result is said", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      const task = await started(s);
      await finishTask(s, task.chatId, "completed", { reported: false });
      expect(await statusOf(s, "g1")).toBe("working");
      // The report turn says the result; it has not ended yet.
      s.inTurn("report-turn");
      const replyTo = await startKeyOf(s, task.taskId);
      expect((await s.tool("say", { text: "Sunny all week", replyTo })).isError).toBeFalsy();
      expect(await statusOf(s, "g1")).toBeNull();
      await reportEnds(s, task.chatId);
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
      await workedLong(s);
      expect(await statusOf(s, "ask")).toBe("working");
      // The thanks cut the turn short, which hands its work on to the next one.
      s.chats.activeTurns = () => ["turn-b"];
      await conciergeEnds(s, "interrupted", "turn-a");
      s.inTurn("turn-b");
      guardianSays(s, "thanks", "turn-b");
      await taken(s, "ask", "turn-b");
      await taken(s, "thanks", "turn-b");
      await workedLong(s);
      await rs.advanceTimersByTimeAsync(6_000);
      expect([await statusOf(s, "ask"), await statusOf(s, "thanks")]).toEqual(["working", null]);
    });

    it("never shows working on a message the turn reacted to, by long work or a task made for it", async () => {
      const s = setup({ said: false });
      s.fakeTimers();
      guardianSays(s, "g1");
      const seen = watch(s);
      await taken(s, "g1");
      await s.tool("react", { emoji: "👍" });
      await workedLong(s);
      expect(await statusOf(s, "g1")).toBeNull();
      await started(s);
      await s.settle();
      expect(await statusOf(s, "g1")).toBeNull();
      expect(seen.filter(([, status]) => status !== null)).toEqual([]);
      expect(s.reactions.get(`${CONCIERGE_CHAT}:g1`)).toBe("👍");
    });

    it("refuses a reaction on a message a task works for", async () => {
      const s = setup({ said: false });
      guardianSays(s, "g1");
      await taken(s, "g1");
      await started(s);
      expect(await statusOf(s, "g1")).toBe("working");
      await s.tool("react", { emoji: "✅" });
      expect(s.reactions.has(`${CONCIERGE_CHAT}:g1`)).toBe(false);
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
      await workedLong(s);
      expect(await statusOf(s, "g2")).toBe("working");
    });

    it("works out each change once, however many chats listen", async () => {
      const s = setup({ said: false });
      s.fakeTimers();
      guardianSays(s, "g1");
      await taken(s, "g1");
      const reads = rs.spyOn(s.tasks, "messageStatusesOf");
      const seen: unknown[] = [];
      const stops = [1, 2, 3].map(() => s.service.onMessageStatus((event) => seen.push(event)));
      await workedLong(s);
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
      s.fakeTimers();
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
      await workedLong(s);
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
      s.fakeTimers();
      guardianSays(s, "a");
      guardianSays(s, "b");
      await taken(s, "a");
      await taken(s, "b");
      await workedLong(s);
      await s.tool("say", { text: "Sunny", replyTo: "a" });
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
      s.fakeTimers();
      guardianSays(s, "g1");
      await taken(s, "g1");
      await s.tool("react", { emoji: "👍" });
      await s.tool("react", { emoji: null });
      await workedLong(s);
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

    it("settles a message in the task's thread that a said result answers", async () => {
      const s = setup({ said: false });
      s.fakeTimers();
      guardianSays(s, "g0", "t0");
      s.inTurn("t0");
      const { chatId } = await started(s);
      s.messages.get(chatId)?.push({
        role: "assistant",
        content: JSON.stringify([{ type: "text", content: concluded("Sunny") }]),
      });
      // The guardian asks for the result, and the said result answers them.
      s.inTurn("ask-turn");
      guardianSays(s, "ask", "ask-turn");
      s.messages.get(CONCIERGE_CHAT)!.find((row) => row.id === "ask")!.chatThread = "g0";
      await taken(s, "ask", "ask-turn");
      expect((await s.tool("say", { text: "Sunny", replyTo: "g0" })).isError).toBeFalsy();
      await workedLong(s);
      expect(await statusOf(s, "ask")).toBeNull();
      await conciergeEnds(s, "error", "ask-turn");
      await s.settle();
      expect(await statusOf(s, "ask")).toBeNull();
    });

    it("never shows working on a thanks that joins a busy turn", async () => {
      const s = setup({ said: false });
      s.fakeTimers();
      guardianSays(s, "a");
      guardianSays(s, "thanks");
      const seen = watch(s);
      await taken(s, "a");
      // The turn works on a past its grace, and the thanks joins it meanwhile.
      const first = callTool(s, "chat_read");
      await rs.advanceTimersByTimeAsync(1_000);
      await taken(s, "thanks", "concierge-turn-1", { joined: true });
      await rs.advanceTimersByTimeAsync(WORKING_GRACE_MS);
      await first.ran;
      // Its later work, long or not, leaves the thanks alone.
      await workedLong(s);
      await rs.advanceTimersByTimeAsync(10_000);
      expect([await statusOf(s, "a"), await statusOf(s, "thanks")]).toEqual(["working", null]);
      await s.tool("say", { text: "Sunny", replyTo: "a" });
      expect((await s.tool("react", { emoji: "🙏", message_id: "thanks" })).isError).toBeFalsy();
      expect(s.reactions.get(`${CONCIERGE_CHAT}:thanks`)).toBe("🙏");
      expect(seen.filter(([key, status]) => key === "thanks" && status !== null)).toEqual([]);
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
      s.fakeTimers();
      guardianSays(s, "g1");
      await taken(s, "g1");
      await workedLong(s);
      await conciergeEnds(s, "error");
      await s.settle();
      expect(s.pushes).toEqual([]);
    });

    describe("a turn that ends without answering (docs/domains/chats.md#reaction)", () => {
      /** The turn makes one quick working call, as `defer` does. */
      const quickCall = async (s: ReturnType<typeof setup>) => {
        const call = callTool(s, "defer");
        await rs.advanceTimersByTimeAsync(30);
        call.end();
      };

      it("reacts ✅ to a message a defer-only turn left silent", async () => {
        const s = setup({ said: false });
        s.fakeTimers();
        guardianSays(s, "g1");
        await taken(s, "g1");
        await quickCall(s);
        await conciergeEnds(s);
        await s.settle();
        expect(s.reactions.get(`${CONCIERGE_CHAT}:g1`)).toBe("✅");
        expect(await statusOf(s, "g1")).toBeNull();
      });

      it.each([
        ["reacts", (s: ReturnType<typeof setup>) => s.tool("react", { emoji: "👍" }), "👍"],
        [
          "replies",
          (s: ReturnType<typeof setup>) => s.tool("say", { text: "Will do." }),
          undefined,
        ],
      ])("adds nothing when the turn %s", async (_, answer, reaction) => {
        const s = setup({ said: false });
        s.fakeTimers();
        guardianSays(s, "g1");
        await taken(s, "g1");
        await quickCall(s);
        expect((await answer(s)).isError).toBeFalsy();
        await conciergeEnds(s);
        await s.settle();
        expect(s.reactions.get(`${CONCIERGE_CHAT}:g1`)).toBe(reaction);
      });

      it("adds nothing to a message that joined the turn", async () => {
        const s = setup({ said: false });
        s.fakeTimers();
        guardianSays(s, "a");
        guardianSays(s, "thanks");
        await taken(s, "a");
        await quickCall(s);
        await taken(s, "thanks", "concierge-turn-1", { joined: true });
        await conciergeEnds(s);
        await s.settle();
        expect(s.reactions.get(`${CONCIERGE_CHAT}:a`)).toBe("✅");
        expect(s.reactions.has(`${CONCIERGE_CHAT}:thanks`)).toBe(false);
      });

      it("shows ⚠️, not ✅, when the turn failed", async () => {
        const s = setup({ said: false });
        s.fakeTimers();
        guardianSays(s, "g1");
        await taken(s, "g1");
        await quickCall(s);
        await conciergeEnds(s, "error");
        await s.settle();
        expect(s.reactions.has(`${CONCIERGE_CHAT}:g1`)).toBe(false);
        expect(await statusOf(s, "g1")).toBe("failed");
      });

      it.each([
        ["no ✅ once the reminder delivers the answer", true, undefined],
        ["✅ when the reminder says nothing either", false, "✅"],
      ])("waits for the unsent-reply reminder, then gives %s", async (_, delivers, reaction) => {
        const s = setup({ said: false });
        s.fakeTimers();
        guardianSays(s, "g1");
        await taken(s, "g1");
        await quickCall(s);
        let seenAtReminder: string | undefined;
        s.onBackendTurn(async () => {
          seenAtReminder = s.reactions.get(`${CONCIERGE_CHAT}:g1`);
          s.inTurn("reminder");
          if (delivers) expect((await s.tool("say", { text: "It is 7291." })).isError).toBeFalsy();
          await s.finish({
            turnId: "reminder",
            agentName: CONCIERGE_AGENT_ID,
            chatId: CONCIERGE_CHAT,
            text: "done",
          });
        });
        // The turn wrote its answer outside `say`, so the reminder runs.
        await s.finish({
          turnId: "concierge-turn-1",
          agentName: CONCIERGE_AGENT_ID,
          chatId: CONCIERGE_CHAT,
          text: "It is 7291.",
        });
        await s.settle();
        expect(seenAtReminder).toBeUndefined();
        expect(s.reactions.get(`${CONCIERGE_CHAT}:g1`)).toBe(reaction);
      });
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

  it("reads a schedule only for a task chat that chat_list lists", async () => {
    const s = setup();
    const schedules = withSchedules(s, "every_run");
    await s.storedChats.createSession(TOPIC_CHAT, "Calendar");
    const start = async (title: string) =>
      JSON.parse((await s.tool("chat_start", { title, brief: title })).content[0].text).taskId;
    const flights = await start("Flights");
    await s.tool("chat_stop", { chatId: flights });
    const hotels = await start("Hotels");
    s.turnIn(TOPIC_CHAT);
    const agenda = await start("Agenda");
    const list = async (input: Record<string, unknown>) => {
      schedules.of.mockClear();
      const titles = JSON.parse((await s.tool("chat_list", input)).content[0].text).map(
        (chat: { title: string }) => chat.title,
      );
      return { titles, read: schedules.of.mock.calls.map((call) => (call as unknown[])[0]) };
    };
    // Another chat's tasks are not read.
    expect(await list({ here: true, recentlyEnded: true })).toEqual({
      titles: ["Agenda"],
      read: [agenda],
    });
    // Nor is a task that ended too long ago.
    s.turnIn(CONCIERGE_CHAT);
    const later = rs.spyOn(Date, "now").mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);
    try {
      expect(await list({ here: true, recentlyEnded: true })).toEqual({
        titles: ["Hotels"],
        read: [hotels],
      });
    } finally {
      later.mockRestore();
    }
  });

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

  it("leaves a scheduled task's start message where it is when a chat_send relays a guardian message", async () => {
    const s = setup();
    withSchedules(s, "every_run");
    const { chatId, taskId } = await startScheduled(s);
    const before = await startKeyOf(s, taskId);
    const list = s.messages.get(CONCIERGE_CHAT) ?? [];
    list.push({ id: "g9", role: "user", content: "[]", turnId: "concierge-turn-1" });
    s.messages.set(CONCIERGE_CHAT, list);
    await s.tool("chat_send", { chatId, text: "Add my sleep too" });
    expect(await startKeyOf(s, taskId)).toBe(before);
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

  it("tells a run that reports only when it matters like any run, with its report setting", async () => {
    const s = setup();
    withSchedules(s, "when_it_matters");
    const { chatId, taskId } = await startScheduled(s, "when_it_matters");
    s.fakeTimers();

    await s.service.runScheduledTask(taskId, Date.now());
    await s.finish({ turnId: "task-turn-1", agentName: "core:main", chatId, text: "x" });
    await rs.advanceTimersByTimeAsync(2_000);
    expect(s.backendTurns).toHaveLength(1);
    expect(s.backendTurns[0].prompt).toContain(`<task chat_id="${taskId}"`);
    expect(s.backendTurns[0].prompt).toContain("report: when_it_matters");
    expect((await s.service.digestTaskNotes(CONCIERGE_CHAT, "guardian")).text).toBe("");
  });

  it("gives an every-run task's event no report line", async () => {
    const s = setup();
    withSchedules(s, "every_run");
    const { chatId, taskId } = await startScheduled(s);
    s.fakeTimers();

    await s.service.runScheduledTask(taskId, Date.now());
    await s.finish({ turnId: "task-turn-1", agentName: "core:main", chatId, text: "x" });
    await rs.advanceTimersByTimeAsync(2_000);
    expect(s.backendTurns).toHaveLength(1);
    expect(s.backendTurns[0].prompt).not.toContain("report:");
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

  it("changes or removes a task's schedule from chat_update, keeping its brief", async () => {
    const s = setup();
    const schedules = withSchedules(s, "every_run");
    const { taskId } = await startScheduled(s);

    await s.tool("chat_update", { chatId: taskId, schedule: { at: "08:00", days: ["mon"] } });
    expect(schedules.set).toHaveBeenLastCalledWith(
      { id: taskId, title: "Daily summary", owner: "guardian" },
      { at: "08:00", days: ["mon"], report: "every_run", brief: "Sum up my last day" },
    );
    await s.tool("chat_update", { chatId: taskId, schedule: null });
    expect(schedules.remove).toHaveBeenCalledWith(taskId);
    const listed = JSON.parse((await s.tool("chat_list", { includeEnded: true })).content[0].text);
    expect(listed.find((chat: { chatId: string }) => chat.chatId === taskId)).toMatchObject({
      schedule: { at: "12:25", report: "every_run", nextRunAt: "2026-11-13T04:25:00.000Z" },
    });
  });
});
