// Concierge's session tools: `say` is its only way to speak, the `chat_*`
// tools run its task chats and read its other Concierge chats, `topic_start`
// starts a topic chat, and `connect_card` shows a card that connects a service.

import type { ForwardedFrom } from "@rome/api-types/chat";
import {
  CONCIERGE_TASK_STATES,
  CONCIERGE_TASK_SUMMARY_MAX_LENGTH,
  type ConciergeTaskState,
} from "@rome/api-types/concierge";
import type { SaidMessage } from "../chats/message.js";
import type { ChatThreadPlacement } from "../webchat/repository.js";
import type { SendResult } from "../chats/send.js";
import type {
  ConciergeTaskWithChat,
  ConciergeTaskWrite,
} from "../db/repositories/concierge-tasks.js";
import {
  CONVERSATION_TITLE_MAX_LENGTH,
  conversationTitleLength,
} from "../core/conversation-title.js";
import { romeToolRunner, type RomeTool } from "../agent/index.js";
import type { SessionToolContext } from "../core/session-tools.js";
import { createLogger } from "../logger.js";
import { getWebchatProjectsRoot, resolveAgentProjectPath } from "../webchat/projects.js";
import {
  CONCIERGE_ACCOUNT,
  type ConciergeService,
  isConciergeAgent,
  isConciergeChat,
  isMainConciergeChat,
  privateOwnerOf,
  TASK_CHAT_TRIGGER_KIND,
} from "./service.js";
import { hasText, latestSaid, MAX_READ_LIMIT, taskChatPlace } from "./task-chat.js";

const log = createLogger("concierge-tools");
const runTool = romeToolRunner(log);

const TASK_STATUSES = ["running", "idle", "waiting_input", "failed"] as const;
type TaskStatus = (typeof TASK_STATUSES)[number];
const DEFAULT_READ_LIMIT = 6;

/**
 * Which guardian message each message of a recent turn named with
 * `answers`, by Concierge and turn, so a task started later in the turn can
 * take its acknowledgements along. Tools are built afresh, so it lives here;
 * the oldest turns are dropped.
 */
const NAMED_ANSWERS = new WeakMap<object, Map<string, Map<string, string>>>();
const NAMED_ANSWERS_TURNS = 64;

/** The parameter that names the thread a report goes into, in a turn no guardian message started. */
const THREAD_PARAMETER = {
  type: "string",
  description:
    "Only in a turn the guardian did not start, such as task events about several tasks: the id of an existing chat thread, or of a message in one, that this message reports on. Leave it out to report in the thread of the task the turn is about. It never starts a thread, and in a turn the guardian started your answer goes where their message is.",
};

/** The parameter that names the guardian message whose words go on to a task. */
const RELAYS_PARAMETER = {
  type: "string",
  description:
    "The message_id of the guardian message whose words you send on to the task, from its <chat_thread> line. That message joins the task's chat thread. Give it when the guardian sent several messages in this turn; without it, only a turn's one message in no thread joins.",
};

/** The parameter that names the one guardian message an answer answers. */
const ANSWERS_PARAMETER = {
  type: "string",
  description:
    "The message_id of the guardian message this answers, from its <chat_thread> line. Give it when the guardian sent several messages in this turn, so the answer goes where that one is; without it such an answer goes in no thread.",
};

function requireString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A chat whose latest turn ended in an error, such as on a model it could not use, is failed. */
function statusOf(
  running: boolean,
  chat: { awaitingGuardian: boolean; lastTurnFailed: boolean } | undefined,
): TaskStatus {
  if (running) return "running";
  if (chat?.awaitingGuardian) return "waiting_input";
  return chat?.lastTurnFailed ? "failed" : "idle";
}

const isTaskState = (value: unknown): value is ConciergeTaskState =>
  (CONCIERGE_TASK_STATES as readonly unknown[]).includes(value);

/** The ISO time of a nullable instant, for the Concierge to read. */
const isoOf = (date: Date | null) => date?.toISOString();

/** A row as the Concierge reads it: compact, with no empty fields. */
function compactTask({ row }: ConciergeTaskWithChat) {
  return {
    id: row.id,
    title: row.title,
    state: row.state,
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.waitingOn ? { waitingOn: row.waitingOn } : {}),
    ...(row.dueAt ? { dueAt: isoOf(row.dueAt) } : {}),
    ...(row.rank !== null ? { rank: row.rank } : {}),
    ...(row.sessionId ? { chatId: row.sessionId } : {}),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function refusal(result: Exclude<SendResult, { ok: true }>): string {
  if ("error" in result) return result.error;
  if ("invalid" in result) return result.invalid;
  return `The task chat cannot take a message (${result.send})`;
}

/**
 * The Concierge tools for one session, or none when the session is not
 * Concierge's. Each handler acts on the session's running turn and fails
 * when none runs.
 */
export async function buildConciergeTools(
  service: ConciergeService,
  context: SessionToolContext,
): Promise<RomeTool[]> {
  if (!isConciergeAgent(context.agentName) || context.isSubagent) return [];
  const { webchatRepo, messages, tasks } = service.deps;

  const currentTurn = (): { chatId: string; turnId: string } => {
    const turnId = context.getTurnId();
    const thread = context.getThreadContext();
    if (!turnId || thread?.channel !== "webchat" || !thread.threadId) {
      throw new Error("This tool works only during a turn in a Concierge chat");
    }
    return { chatId: thread.threadId, turnId };
  };

  const taskProjectPath = async (project: string | undefined) =>
    project === undefined
      ? undefined
      : resolveAgentProjectPath(
          project,
          (await webchatRepo.listProjects()).map((stored) => stored.path),
        );

  // Whose Concierge this turn is: the owner of the chat it runs in. Every
  // chat and row the tools reach is that owner's.
  const ownerHere = async () => {
    const { chatId } = currentTurn();
    const owner = await service.ownerOfChat(chatId);
    if (owner === null) throw new Error(`No Concierge chat ${chatId}`);
    return owner;
  };

  const requireTaskChat = async (chatId: string) => {
    const chat = await webchatRepo.getSession(chatId);
    if (
      !chat ||
      chat.triggerKind !== TASK_CHAT_TRIGGER_KIND ||
      privateOwnerOf(chat) !== (await ownerHere())
    ) {
      throw new Error(`No task chat ${chatId}. Use chat_list to find your task chats.`);
    }
    return chat;
  };

  // A chat the Concierge may read: one of its task chats, or another of its
  // Concierge chats.
  const requireReadableChat = async (chatId: string) => {
    const chat = await webchatRepo.getSession(chatId);
    if (
      !chat ||
      (chat.triggerKind !== TASK_CHAT_TRIGGER_KIND && !isConciergeChat(chat)) ||
      privateOwnerOf(chat) !== (await ownerHere())
    ) {
      throw new Error(`No task chat or Concierge chat ${chatId}. Use chat_list to find them.`);
    }
    return chat;
  };

  // A row of this owner's task list.
  const requireTaskRow = async (taskId: string) => {
    const found = await tasks.repo.getWithChat(taskId);
    if (!found || found.owner !== (await ownerHere())) {
      throw new Error(`No task ${taskId}. Use task_list to find it.`);
    }
    return found.row;
  };

  /** This owner's rows, as the agent's list reads them. */
  const ownRows = async (includeDone: boolean) => {
    const owner = await ownerHere();
    return (await tasks.repo.listForAgent(includeDone)).filter((task) => task.owner === owner);
  };

  // Said as Concierge's account, so the task event reads who asked off the
  // message.
  const sendInput = async (chatId: string, text: string, skillName?: string) => {
    const sent = await service.dashboard.send(
      taskChatPlace(chatId),
      { text, ...(skillName ? { skillName } : {}) },
      CONCIERGE_ACCOUNT,
    );
    if (!sent.ok) throw new Error(refusal(sent));
  };

  // A task chat always has a row. One from before the todo list gets its row
  // when the Concierge next works with it.
  const ensureTaskRow = async (chat: { id: string; name: string; triggerName?: string | null }) => {
    if (await tasks.repo.findBySession(chat.id)) return;
    await tasks.repo.upsertMany([
      {
        title: chat.triggerName ?? chat.name,
        state: "doing",
        sessionId: chat.id,
        chatId: currentTurn().chatId,
      },
    ]);
  };

  // A row points back to a message of this chat, so the panel can jump to it.
  const requireSourceMessage = async (messageId: string) => {
    const { chatId } = currentTurn();
    if (!(await webchatRepo.getReplyTarget(chatId, messageId))) {
      throw new Error(
        `No message ${messageId} in this chat. Pass the messageId that say, chat_card, or chat_forward returned.`,
      );
    }
    return messageId;
  };

  // The latest thing the Concierge said this turn, or null.
  const latestSaidThisTurn = async () => {
    const { chatId, turnId } = currentTurn();
    const said = (await webchatRepo.getTurnChatMessages(chatId, turnId)).filter(
      (row) => row.role === "assistant",
    );
    return said[said.length - 1]?.id ?? null;
  };

  const NO_ROW_MESSAGE =
    "A new row needs a message to point to. Call say first, then pass the messageId it returns.";

  // The message a new row points to: the one passed, else the latest thing
  // said this turn. The guardian's own words are no default, since a row
  // starts from what the Concierge told them.
  const sourceMessageForNewRow = async (explicit: string | undefined) => {
    if (explicit) return requireSourceMessage(explicit);
    const latest = await latestSaidThisTurn();
    if (!latest) throw new Error(NO_ROW_MESSAGE);
    return latest;
  };

  // The message a new task's row points to. The Concierge sends no
  // acknowledgement before a task, so with nothing said this turn it is the
  // guardian message the task is for: the one `answers` names, or the turn's
  // only one.
  const sourceMessageForTask = async (
    explicit: string | undefined,
    answers: string | undefined,
  ) => {
    if (explicit) return requireSourceMessage(explicit);
    const latest = await latestSaidThisTurn();
    if (latest) return latest;
    const prompts = await turnPrompts();
    const asked = answers ?? (prompts.length === 1 ? prompts[0] : undefined);
    const { chatId } = currentTurn();
    if (asked && (await webchatRepo.getReplyTarget(chatId, asked))?.role === "user") return asked;
    throw new Error(NO_ROW_MESSAGE);
  };

  // Rome's status reaction on the guardian message a task works for
  // (docs/domains/chats.md#status-reaction). It only shows how the work
  // stands, so failing to write it never fails the tool.
  const writeReaction = async (label: string, write: () => Promise<void>) => {
    try {
      await write();
    } catch (error) {
      log.warn(`failed to ${label} a status reaction`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Sends `send` on to task `taskId` with guardian message `messageKey`
  // marked as being worked on: marked first, so a task that ends at once
  // still settles it, and taken back when the task never hears it.
  const sendMarked = async (
    taskId: string,
    messageKey: string | undefined,
    send: () => Promise<void>,
  ) => {
    if (!messageKey) return send();
    const target = { chatId: currentTurn().chatId, messageKey };
    await writeReaction("mark", () => tasks.repo.markWorking(taskId, target));
    try {
      await send();
    } catch (error) {
      await writeReaction("take back", () => tasks.repo.unmark(taskId, target));
      throw error;
    }
  };

  const parseTaskWrite = async (
    raw: Record<string, unknown>,
    where: string,
  ): Promise<ConciergeTaskWrite> => {
    const write: ConciergeTaskWrite = {};
    const text = (field: string) => {
      const value = raw[field];
      if (value === null) return null;
      if (typeof value !== "string") throw new Error(`${where}.${field} must be a string or null`);
      return value.trim() || null;
    };
    if (raw.id !== undefined) {
      write.id = requireString(raw, "id");
      await requireTaskRow(write.id);
    }
    if (raw.title !== undefined) write.title = requireString(raw, "title");
    if (raw.state !== undefined) {
      if (!isTaskState(raw.state)) {
        throw new Error(`${where}.state must be one of: ${CONCIERGE_TASK_STATES.join(", ")}`);
      }
      write.state = raw.state;
    }
    if (raw.summary !== undefined) {
      const summary = text("summary");
      write.summary =
        summary && summary.length > CONCIERGE_TASK_SUMMARY_MAX_LENGTH
          ? `${summary.slice(0, CONCIERGE_TASK_SUMMARY_MAX_LENGTH - 1)}…`
          : summary;
    }
    if (raw.waitingOn !== undefined) write.waitingOn = text("waitingOn");
    if (raw.dueAt !== undefined) {
      const due = text("dueAt");
      const dueAt = due === null ? null : new Date(due);
      if (dueAt !== null && Number.isNaN(dueAt.getTime())) {
        throw new Error(`${where}.dueAt must be an ISO 8601 time`);
      }
      write.dueAt = dueAt;
    }
    if (raw.rank !== undefined) {
      if (raw.rank !== null && !Number.isInteger(raw.rank)) {
        throw new Error(`${where}.rank must be an integer or null`);
      }
      write.rank = raw.rank as number | null;
    }
    if (raw.chatId !== undefined) {
      const chatId = text("chatId");
      if (chatId) await requireTaskChat(chatId);
      write.sessionId = chatId;
    }
    if (raw.archived !== undefined) {
      if (typeof raw.archived !== "boolean") throw new Error(`${where}.archived must be a boolean`);
      write.archived = raw.archived;
    }
    const messageId = raw.messageId === undefined ? undefined : requireString(raw, "messageId");
    // A row that waits for the guardian points at the message that asks. Only an
    // entry that sets the state is held to this, so a later write that merely
    // touches a needs_user row keeps its message.
    if (write.state === "needs_user" && !messageId) {
      throw new Error(
        `${where}: needs_user requires messageId: show a task question or approval with chat_card, otherwise ask with say or chat_forward; pass the returned messageId`,
      );
    }
    // A row belongs to the Concierge chat it was made in, and moves to the
    // chat whose message it is pointed at.
    if (!write.id) {
      if (!write.title) throw new Error(`${where}.title is required to create a row`);
      write.state ??= write.sessionId ? "doing" : "next";
      write.sourceMessageId = await sourceMessageForNewRow(messageId);
      write.chatId = currentTurn().chatId;
    } else if (messageId) {
      write.sourceMessageId = await requireSourceMessage(messageId);
      write.chatId = currentTurn().chatId;
    }
    return write;
  };

  const findListEntry = async (chatId: string) =>
    (await webchatRepo.listSessions("all")).find((chat) => chat.id === chatId);

  // Every message of a turn with a push level may also reach the phone. Its
  // lock-screen line is only ever words the Concierge wrote in this message,
  // and null when it wrote none or marked them private, which pushes a fixed line.
  const said = (chatId: string, turnId: string, ownWords: string | null, isPrivate = false) =>
    service.said({
      turnId,
      chatId,
      ownWords,
      ...(isPrivate ? { private: true } : {}),
      level: context.getTurnPushLevel(),
    });

  // Only the guardian's messages this turn has taken: one still queued
  // behind it belongs to the turn that takes it.
  const turnPrompts = async () => {
    const { chatId, turnId } = currentTurn();
    return (await webchatRepo.getTurnChatMessages(chatId, turnId))
      .filter((row) => row.role === "user" && row.inputState !== "queued")
      .map((row) => row.id);
  };

  /** This turn's guardian messages, once `answers`, when given, is one of them. */
  const requireTurnPrompt = async (answers: string | undefined) => {
    const prompts = await turnPrompts();
    if (answers !== undefined && !prompts.includes(answers)) {
      throw new Error(
        `No guardian message ${answers} in this turn. Pass a message_id from this turn's <chat_thread> lines.`,
      );
    }
    return prompts;
  };

  /** The chat thread a message is in, or null when it is in none. */
  const threadOf = async (chatId: string, messageId: string) =>
    (await webchatRepo.getReplyTarget(chatId, messageId))?.chatThreadId ?? null;

  // The guardian messages turn `turnId` took, as its prompts.
  const promptsOf = async (chatId: string, turnId: string) =>
    (await webchatRepo.getTurnChatMessages(chatId, turnId))
      .filter((row) => row.role === "user" && row.inputState !== "queued")
      .map((row) => row.id);

  // The guardian message a task is for, and the root it starts with: the
  // message's thread, or the message. `answers` names it, in this turn or an
  // earlier one. Without it, it is read from the message the task's row
  // points to: that message when the guardian said it, else the only
  // guardian message of the turn that said it. A row pointing nowhere asks
  // this turn. Several, or none, and the task starts with no root
  // (docs/domains/chats.md#chat-thread).
  const startingRoot = async (
    answers: string | undefined,
    pointsTo: string | undefined,
  ): Promise<{ answered: string; root: string; turnId: string | null } | null> => {
    const { chatId, turnId } = currentTurn();
    let answered: string | undefined;
    if (answers !== undefined) {
      const named = await webchatRepo.getReplyTarget(chatId, answers);
      if (named?.role !== "user") {
        throw new Error(
          `No guardian message ${answers} in this chat. Pass a message_id from a <chat_thread> line.`,
        );
      }
      answered = answers;
    } else {
      const pointed = pointsTo ? await webchatRepo.getReplyTarget(chatId, pointsTo) : null;
      if (pointed?.role === "user") answered = pointed.id;
      else {
        const prompts = await promptsOf(chatId, pointed?.turnId ?? turnId);
        answered = prompts.length === 1 ? prompts[0] : undefined;
      }
    }
    if (!answered) return null;
    const message = await webchatRepo.getReplyTarget(chatId, answered);
    return {
      answered,
      root: message?.chatThreadId ?? answered,
      turnId: message?.turnId ?? null,
    };
  };

  const namedAnswers = () => {
    let turns = NAMED_ANSWERS.get(service);
    if (!turns) {
      turns = new Map();
      NAMED_ANSWERS.set(service, turns);
    }
    return turns;
  };
  const noteAnswers = (messageId: string, answers: string | undefined) => {
    if (!answers) return;
    const { turnId } = currentTurn();
    const turns = namedAnswers();
    const turn = turns.get(turnId) ?? new Map<string, string>();
    turn.set(messageId, answers);
    turns.delete(turnId);
    turns.set(turnId, turn);
    if (turns.size > NAMED_ANSWERS_TURNS) turns.delete(turns.keys().next().value as string);
  };

  // A task started for guardian message `start.answered` takes its root, for
  // good. A message in no thread becomes the root itself, and the messages of
  // the turn it prompted that answer it join it: that turn's only guardian
  // message, or the one their `answers` named. Only the Concierge's messages
  // in no thread move; a guardian's choice never does.
  const rootTaskAt = async (
    taskId: string,
    start: { answered: string; root: string; turnId: string | null },
  ) => {
    const { chatId } = currentTurn();
    const root = await tasks.repo.setThreadRoot(taskId, start.root);
    if (!root) return;
    if (root === start.answered && !(await threadOf(chatId, root))) {
      await webchatRepo.placeInChatThread(chatId, root, { starts: true, settle: true });
    }
    // The acknowledgements are in the turn the guardian's message prompted.
    const turnId = start.turnId;
    if (!turnId) return;
    const prompts = await promptsOf(chatId, turnId);
    const answersOf = (id: string) => namedAnswers().get(turnId)?.get(id);
    for (const row of await webchatRepo.getTurnChatMessages(chatId, turnId)) {
      if (row.role !== "assistant" || (await threadOf(chatId, row.id))) continue;
      const answered = answersOf(row.id) ?? (prompts.length === 1 ? prompts[0] : undefined);
      if (answered !== start.answered) continue;
      await webchatRepo.placeInChatThread(chatId, row.id, { in: root });
    }
  };

  // A task's stored root in this Concierge chat, or null. A task from before
  // stored roots takes the thread its row's message is in, once.
  const rootOf = async (taskId: string): Promise<string | null> => {
    const { chatId } = currentTurn();
    const found = await tasks.repo.getWithChat(taskId);
    if (!found || found.conciergeChat.id !== chatId) return null;
    if (found.row.threadRoot) return found.row.threadRoot;
    const pointed = found.sourceMessageId ? await threadOf(chatId, found.sourceMessageId) : null;
    return pointed ? tasks.repo.setThreadRoot(taskId, pointed) : null;
  };

  // Where a message the Concierge says goes (docs/domains/chats.md#chat-thread).
  // One about a task goes into the task's thread; when the task has none
  // yet, the message becomes its root (`rootFor`). An answer goes where the
  // guardian's message it answers is. A report names a thread with `thread`.
  const placementFor = async (
    answers: string | undefined,
    about: { thread?: string; taskId?: string | null } = {},
  ): Promise<{ chatThread?: ChatThreadPlacement; rootFor?: string }> => {
    const { chatId } = currentTurn();
    const prompts = await requireTurnPrompt(answers);
    const reported = prompts.length === 0 && !about.thread ? context.getTurnReportedTask() : null;
    const taskId = about.taskId ?? reported ?? null;
    const own = taskId ? await tasks.repo.getWithChat(taskId) : null;
    if (taskId && own?.conciergeChat.id === chatId) {
      const root = await rootOf(taskId);
      return root ? { chatThread: { in: root } } : { rootFor: taskId };
    }
    if (prompts.length > 0) {
      // With several guardian messages and no `answers`, which one this
      // answers is a guess, so it goes in no thread.
      const answered = answers ?? (prompts.length === 1 ? prompts[0] : undefined);
      const thread = answered ? await threadOf(chatId, answered) : null;
      return thread ? { chatThread: { in: thread } } : {};
    }
    if (about.thread !== undefined) {
      const thread = await threadOf(chatId, about.thread);
      if (!thread) {
        throw new Error(
          `No chat thread holds ${about.thread}. Pass the id of a message in an existing thread, or leave thread out.`,
        );
      }
      return { chatThread: { in: thread } };
    }
    return {};
  };

  // Says `parts` where `placementFor` puts them, and roots the task there
  // when the message is the first it brings back.
  const addMessage = async (
    parts: Parameters<typeof webchatRepo.addBackendMessage>[2],
    placement: { chatThread?: ChatThreadPlacement; rootFor?: string },
  ) => {
    const { chatId, turnId } = currentTurn();
    const { id } = await webchatRepo.addBackendMessage(
      chatId,
      turnId,
      parts,
      placement.chatThread ? { chatThread: placement.chatThread } : {},
    );
    if (placement.rootFor) {
      const root = await tasks.repo.setThreadRoot(placement.rootFor, id);
      await webchatRepo.placeInChatThread(
        chatId,
        id,
        root === id || !root ? { starts: true, settle: true } : { in: root, settle: true },
      );
    }
    return id;
  };

  // The guardian's words this turn are sent on to the task chat
  // `taskChatId`, so the message they came from joins the task's thread:
  // the one `answers` names, or the turn's only guardian message in no
  // thread. With several and none named, none moves. A task with no root
  // yet takes that message as its root.
  const relayToTaskThread = async (taskChatId: string, answers?: string) => {
    const { chatId } = currentTurn();
    const prompts = await requireTurnPrompt(answers);
    const unthreaded: string[] = [];
    for (const id of answers ? [answers] : prompts) {
      if (!(await threadOf(chatId, id))) unthreaded.push(id);
    }
    const relayed = unthreaded.length === 1 ? unthreaded[0] : undefined;
    const task = relayed ? await tasks.repo.findBySession(taskChatId) : null;
    if (!relayed || !task) return;
    const found = await tasks.repo.getWithChat(task.id);
    if (found?.conciergeChat.id !== chatId) return;
    const root = (await rootOf(task.id)) ?? (await tasks.repo.setThreadRoot(task.id, relayed));
    await webchatRepo.placeInChatThread(
      chatId,
      relayed,
      !root || root === relayed ? { starts: true, settle: true } : { in: root, settle: true },
    );
  };

  // Points the task in task chat `taskChatId` to `messageId`, its panel's
  // jump target. Answers the row, or null.
  const pointTaskTo = async (taskChatId: string, messageId: string) => {
    const { chatId } = currentTurn();
    const task = await tasks.repo.findBySession(taskChatId);
    if (!task) return null;
    await tasks.repo.setSourceMessage(task.id, chatId, messageId);
    return task;
  };

  const say = async (
    text: string,
    format: "bubble" | "long",
    isPrivate: boolean,
    answers?: string,
    thread?: string,
  ) => {
    const { chatId, turnId } = currentTurn();
    const id = await addMessage(
      [{ type: "text", content: text, ...(format === "long" ? { format } : {}) }],
      await placementFor(answers, thread ? { thread } : {}),
    );
    noteAnswers(id, answers);
    said(chatId, turnId, text, isPrivate);
    return id;
  };

  // One message, so the lead-in and the report always arrive together. The
  // transcript still shows them as two bubbles.
  const forward = async (text: string, from: ForwardedFrom, intro?: string, answers?: string) => {
    const { chatId, turnId } = currentTurn();
    const task = await tasks.repo.findBySession(from.chatId);
    const id = await addMessage(
      [
        ...(intro ? [{ type: "text" as const, content: intro }] : []),
        { type: "text", content: text, format: "long", forwardedFrom: from },
      ],
      await placementFor(answers, { taskId: task?.id ?? null }),
    );
    noteAnswers(id, answers);
    // Forwarded text is the task's, not the Concierge's, and so are a task's
    // title and chat name, which can come from its output: none becomes the
    // push's line, which could carry a code or password onto the lock screen.
    said(chatId, turnId, intro ?? null);
    return id;
  };

  // A card that opens the task chat; it reads the chat's live status itself.
  const showCard = async (chatId: string, title: string) => {
    const { chatId: conciergeChatId, turnId } = currentTurn();
    const task = await tasks.repo.findBySession(chatId);
    const id = await addMessage(
      [{ type: "task_chat", chatId, title }],
      await placementFor(undefined, { taskId: task?.id ?? null }),
    );
    said(conciergeChatId, turnId, null);
    return id;
  };

  return [
    {
      name: "say",
      description:
        "Send the guardian one message. This is the only way the guardian hears you: text you write outside this tool is private. " +
        "One call is one message. Use format bubble (default) for a short chat line, and long for one long message with content the guardian asked for. " +
        "Every message can show on the guardian's phone lock screen: set private for one that holds a code, password, token or other secret, and the phone shows a fixed line instead.",
      inputSchema: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string", description: "The message, in Markdown." },
          format: {
            type: "string",
            enum: ["bubble", "long"],
            description: "bubble: a short chat line. long: one long message.",
          },
          private: {
            type: "boolean",
            description:
              "true: the message holds a secret, so its words never show on the phone's lock screen.",
          },
          answers: ANSWERS_PARAMETER,
          thread: THREAD_PARAMETER,
        },
      },
      handler: (input) =>
        runTool("say", input, async (args) => {
          const messageId = await say(
            requireString(args, "text"),
            args.format === "long" ? "long" : "bubble",
            args.private === true,
            optionalString(args, "answers"),
            optionalString(args, "thread"),
          );
          return {
            sent: "The guardian sees it. Call say again only for a new message.",
            messageId,
          };
        }),
    },
    {
      name: "task_upsert",
      description:
        "Write your task list, the guardian's panel of what you are busy with. Batch only: one call writes every row that changed. " +
        "An entry without id creates a row (title required, and a message to point to); an entry with id updates it, and fields you leave out stay. " +
        "For needs_user, show a task question or approval with chat_card, otherwise ask with say or chat_forward. Use the returned messageId as the row anchor. " +
        "Returns each row's id and the message it points to.",
      inputSchema: {
        type: "object",
        required: ["tasks"],
        properties: {
          tasks: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "The row to update. Leave out to create one." },
                title: { type: "string", description: "A few words naming the task." },
                state: {
                  type: "string",
                  enum: [...CONCIERGE_TASK_STATES],
                  description:
                    "next: planned. doing: in progress. watching: waiting on something external. needs_user: blocked on the guardian. done: finished. dropped: given up or called off, with the reason in summary.",
                },
                summary: {
                  type: ["string", "null"],
                  description: `One line, at most ${CONCIERGE_TASK_SUMMARY_MAX_LENGTH} characters: the result or the current status.`,
                },
                waitingOn: {
                  type: ["string", "null"],
                  description:
                    'What a watching or needs_user row waits for, such as "CI" or "your budget call".',
                },
                dueAt: {
                  type: ["string", "null"],
                  description:
                    "ISO 8601 time: the next check of a watching row, or when a next row is planned.",
                },
                rank: {
                  type: ["integer", "null"],
                  description: "Order inside next. Lower comes first.",
                },
                chatId: {
                  type: ["string", "null"],
                  description: "The task chat this row follows. Each chat belongs to one row.",
                },
                archived: { type: "boolean", description: "Archive the row, or bring it back." },
                messageId: {
                  type: "string",
                  description:
                    "The message the row points to, as say, chat_card, or chat_forward returned it. Required for needs_user: show a task question or approval with chat_card, otherwise ask with say or chat_forward. Use the returned messageId as the row anchor. A new row of another state takes your latest message this turn if you leave it out. On an update it replaces the old one; leave it out to keep it. chat_card and chat_forward update this anchor automatically.",
                },
              },
            },
          },
        },
      },
      handler: (input) =>
        runTool("task_upsert", input, async (args) => {
          currentTurn();
          if (!Array.isArray(args.tasks) || args.tasks.length === 0) {
            throw new Error("tasks is required: an array with one entry per row to write");
          }
          const writes: ConciergeTaskWrite[] = [];
          for (const [index, raw] of args.tasks.entries()) {
            if (!raw || typeof raw !== "object")
              throw new Error(`tasks[${index}] must be an object`);
            writes.push(await parseTaskWrite(raw as Record<string, unknown>, `tasks[${index}]`));
          }
          const rows = await tasks.repo.upsertMany(writes);
          // A row made in this turn is a task for its guardian message.
          for (const [index, row] of rows.entries()) {
            const write = writes[index];
            if (!write || write.id) continue;
            const start = await startingRoot(undefined, write.sourceMessageId ?? undefined);
            if (start) await rootTaskAt(row.id, start);
          }
          const anchors = await Promise.all(
            rows.map(async (row) => (await tasks.repo.getWithChat(row.id))?.sourceMessageId),
          );
          // Says which message each row points to, and flags the ones that kept an
          // earlier message because the entry passed none.
          return {
            tasks: rows.map((row, index) => ({
              id: row.id,
              title: row.title,
              state: row.state,
              ...(anchors[index] ? { anchor: anchors[index] } : {}),
              ...(writes[index].sourceMessageId === undefined ? { anchorKept: true } : {}),
            })),
          };
        }),
    },
    {
      name: "task_list",
      description:
        "List your task list: the open rows, or with includeDone the finished ones too. Check it before you create a row, so you do not create a duplicate.",
      inputSchema: {
        type: "object",
        properties: {
          includeDone: { type: "boolean", description: "Also list done and dropped rows." },
        },
      },
      handler: (input) =>
        runTool("task_list", input, async (args) => ({
          tasks: (await ownRows(args.includeDone === true)).map(compactTask),
        })),
    },
    {
      name: "chat_start",
      description:
        "Start a task chat: a normal chat with another agent (main by default) that does the work while you keep talking. " +
        "Pass skill to invoke a catalog skill on its first turn. Its result comes back to you in a <task_events> batch, in the Concierge chat you start it from. Every task chat has a row on your task list: this call creates one (or links taskId). Returns the chat's id and the row's id.",
      inputSchema: {
        type: "object",
        required: ["title", "brief"],
        properties: {
          title: {
            type: "string",
            description: "A short name for the chat, shown in the sidebar.",
          },
          brief: {
            type: "string",
            description:
              "The full request for the other agent, with every detail it needs. It does not see this conversation.",
          },
          skill: {
            type: "string",
            description:
              "Exact catalog skill name to invoke on the first turn, with brief as its task.",
          },
          agent: { type: "string", description: 'Agent id. Defaults to "main".' },
          project: {
            type: "string",
            description: `Project the chat works in, as a path relative to the projects root ${getWebchatProjectsRoot()}, such as "website" or "apps/notes". Defaults to "default".`,
          },
          taskId: {
            type: "string",
            description:
              "Link the chat to this existing task row, such as one planned under next, and set it to doing. Without it a doing row is created for the chat.",
          },
          messageId: {
            type: "string",
            description:
              "The message the new row points to, as say returned it. Leave it out to use your latest message this turn. With taskId the row keeps its message unless you pass this.",
          },
          answers: {
            type: "string",
            description:
              "The message_id of the guardian message this task is for, from its <chat_thread> line, in this turn or an earlier one. Give it when the guardian sent several messages, or the task is for one from an earlier turn, so the task's results join that message's chat thread.",
          },
          card: {
            type: "boolean",
            description:
              "Also show the guardian a card that opens the task chat. The task runs either way. Decide by complexity: on for complex or long-running work they may want to watch, such as code, a PR, or research across many sources; off for a simple task that will finish quickly.",
          },
        },
      },
      handler: (input) =>
        runTool("chat_start", input, async (args) => {
          currentTurn();
          const title = requireString(args, "title");
          const brief = requireString(args, "brief");
          const requestedSkill = optionalString(args, "skill");
          const skill = requestedSkill ? service.deps.skillCatalog.find(requestedSkill) : undefined;
          // Like the other optional fields, null or empty means no skill.
          if (requestedSkill && !skill) {
            throw new Error(
              `Unknown skill: ${requestedSkill}. Pass the exact name from the slash command.`,
            );
          }
          const taskId = optionalString(args, "taskId");
          const messageId = optionalString(args, "messageId");
          if (taskId) {
            const planned = await requireTaskRow(taskId);
            if (planned.sessionId) {
              throw new Error(
                `Task ${taskId} already has chat ${planned.sessionId}. Use chat_send to continue it.`,
              );
            }
          }
          // Settled before the chat starts, so a refusal leaves nothing running.
          // A linked row keeps its message unless one is passed.
          const sourceMessageId = taskId
            ? messageId
              ? await requireSourceMessage(messageId)
              : undefined
            : await sourceMessageForTask(messageId, optionalString(args, "answers"));
          // The guardian message the task is for, if one can tell. Checked
          // before anything starts; the root is set once the task runs.
          const start = await startingRoot(
            optionalString(args, "answers"),
            sourceMessageId ??
              (taskId
                ? ((await tasks.repo.getWithChat(taskId))?.sourceMessageId ?? undefined)
                : undefined),
          );
          const { chatId: conciergeChatId } = currentTurn();
          // The task chat is the owner's, private to them as their Concierge is.
          const chatId = await service.dashboard.chats.startChat(
            {
              agentName: optionalString(args, "agent"),
              projectPath: await taskProjectPath(optionalString(args, "project")),
            },
            await ownerHere(),
          );
          // Marked before the first turn, so that turn's event already sees it.
          await webchatRepo.setSessionTrigger(chatId, {
            triggerKind: TASK_CHAT_TRIGGER_KIND,
            triggerName: title,
          });
          // Linked before the first turn, so that turn's events find the row.
          const [task] = await tasks.repo.upsertMany([
            taskId
              ? {
                  id: taskId,
                  sessionId: chatId,
                  state: "doing",
                  waitingOn: null,
                  ...(sourceMessageId ? { sourceMessageId, chatId: conciergeChatId } : {}),
                }
              : {
                  title,
                  state: "doing",
                  sessionId: chatId,
                  sourceMessageId,
                  chatId: conciergeChatId,
                },
          ]);
          await sendMarked(task.id, start?.answered, () => sendInput(chatId, brief, skill?.name));
          if (start) await rootTaskAt(task.id, start);
          // Named after the first turn: the first message would rename it.
          if (conversationTitleLength(title) <= CONVERSATION_TITLE_MAX_LENGTH) {
            // The task already runs, so a failure here must not read as a
            // failed start that the agent retries.
            await webchatRepo.updateSessionName(chatId, title).catch((error: unknown) =>
              log.warn("failed to name a task chat", {
                chatId,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
          } else {
            log.warn("task chat title too long to name the chat", { chatId });
          }
          if (args.card === true) await showCard(chatId, title);
          return { chatId, taskId: task.id };
        }),
    },
    {
      name: "chat_send",
      description:
        "Send a follow-up to a task chat: more detail, a correction, or the guardian's answer to its question. " +
        "A running task takes it as input, so it does not restart.",
      inputSchema: {
        type: "object",
        required: ["chatId", "text"],
        properties: {
          chatId: { type: "string" },
          text: { type: "string", description: "The message for the other agent." },
          answers: RELAYS_PARAMETER,
        },
      },
      handler: (input) =>
        runTool("chat_send", input, async (args) => {
          currentTurn();
          const chatId = requireString(args, "chatId");
          const chat = await requireTaskChat(chatId);
          const answers = optionalString(args, "answers");
          // Checked before the task hears anything, so a retry never sends twice.
          const prompts = await requireTurnPrompt(answers);
          await ensureTaskRow(chat);
          const task = await tasks.repo.findBySession(chatId);
          const text = requireString(args, "text");
          // The guardian message whose words go on: the one named, or the
          // turn's only one.
          const relayed = answers ?? (prompts.length === 1 ? prompts[0] : undefined);
          if (task) await sendMarked(task.id, relayed, () => sendInput(chatId, text));
          else await sendInput(chatId, text);
          await relayToTaskThread(chatId, answers);
          return "Sent; the task chat takes it as input.";
        }),
    },
    {
      name: "chat_read",
      description:
        "Read a task chat's status (running, idle, waiting_input, or failed) and its latest messages, or the latest messages of another of your Concierge chats when the guardian's question needs what was said there.",
      inputSchema: {
        type: "object",
        required: ["chatId"],
        properties: {
          chatId: { type: "string" },
          last: {
            type: "integer",
            minimum: 1,
            maximum: MAX_READ_LIMIT,
            description: `How many latest messages to return. Defaults to ${DEFAULT_READ_LIMIT}.`,
          },
        },
      },
      handler: (input) =>
        runTool("chat_read", input, async (args) => {
          const chatId = requireString(args, "chatId");
          const chat = await requireReadableChat(chatId);
          const limit =
            typeof args.last === "number"
              ? Math.min(MAX_READ_LIMIT, Math.max(1, Math.floor(args.last)))
              : DEFAULT_READ_LIMIT;
          const said = await latestSaid(messages, taskChatPlace(chatId), limit, hasText);
          return {
            chatId,
            title: chat.name,
            kind:
              chat.triggerKind === TASK_CHAT_TRIGGER_KIND
                ? "task chat"
                : isMainConciergeChat(chat)
                  ? "main chat"
                  : "topic chat",
            status: statusOf(
              service.dashboard.chats.isRunning(chatId),
              await findListEntry(chatId),
            ),
            messages: said.map((message) => ({
              id: message.id,
              role: message.direction === "fromRome" ? "assistant" : "user",
              text: message.body.text,
              at: message.at.toISOString(),
              ...(message.chatThread ? { thread: message.chatThread } : {}),
            })),
          };
        }),
    },
    {
      name: "chat_stop",
      description:
        'Stop a task chat\'s running work. Only when the guardian clearly calls the task off ("never mind", "算了", "不用了"). A follow-up or a side question is not a reason.',
      inputSchema: {
        type: "object",
        required: ["chatId"],
        properties: { chatId: { type: "string" } },
      },
      handler: (input) =>
        runTool("chat_stop", input, async (args) => {
          const chatId = requireString(args, "chatId");
          await requireTaskChat(chatId);
          const { chats } = service.dashboard;
          const turns = chats.activeTurns(chatId);
          for (const turnId of turns) await chats.interruptTurn(turnId);
          return { stopped: turns.length };
        }),
    },
    {
      name: "chat_list",
      description:
        "List your other chats, each with its kind: the main chat and your topic chats (kind main chat or topic chat), then the task chats you started (kind task chat), newest first, each with the Concierge chat it came from and its status. chat_read reads any of them.",
      inputSchema: {
        type: "object",
        properties: { status: { type: "string", enum: [...TASK_STATUSES] } },
      },
      handler: (input) =>
        runTool("chat_list", input, async (args) => {
          const wanted = TASK_STATUSES.find((status) => status === args.status);
          const { chats } = service.dashboard;
          const { chatId: here } = currentTurn();
          const owner = await ownerHere();
          const all = (await webchatRepo.listSessions("all")).filter(
            (chat) => privateOwnerOf(chat) === owner,
          );
          // The Concierge chat each task chat came from, by its task row.
          const cameFrom = new Map(
            (await ownRows(true)).flatMap(({ row, conciergeChat }) =>
              row.sessionId
                ? [[row.sessionId, { chatId: conciergeChat.id, title: conciergeChat.name }]]
                : [],
            ),
          );
          const taskChats = all
            .filter((chat) => chat.triggerKind === TASK_CHAT_TRIGGER_KIND && !chat.archivedAt)
            .map((chat) => ({
              chatId: chat.id,
              title: chat.name,
              kind: "task chat",
              ...(cameFrom.has(chat.id) ? { from: cameFrom.get(chat.id) } : {}),
              status: statusOf(chats.isRunning(chat.id), chat),
            }))
            .filter((chat) => !wanted || chat.status === wanted);
          const conciergeChats = wanted
            ? []
            : (await service.listChats(owner))
                .filter((chat) => chat.id !== here)
                .map((chat) => ({
                  chatId: chat.id,
                  title: chat.name,
                  kind: chat.main ? "main chat" : "topic chat",
                }));
          return [...conciergeChats, ...taskChats];
        }),
    },
    {
      name: "topic_start",
      description:
        "Start a topic chat: another Concierge chat for one topic, such as the calendar or a project, beside the main chat. Only when the guardian asks for one. " +
        "You talk there too, with the same memory, follows and tasks. Returns its chatId and the link that opens it.",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", description: "A short name for the chat, shown in the sidebar." },
        },
      },
      handler: (input) =>
        runTool("topic_start", input, async (args) => {
          currentTurn();
          const chat = await service.startTopicChat(await ownerHere(), requireString(args, "name"));
          return { chatId: chat.id, name: chat.name, link: `/chat/${chat.id}` };
        }),
    },
    {
      name: "chat_forward",
      description:
        "Send the guardian a task chat's latest answer as one long message, word for word, without retyping it. " +
        "Use it for long content the guardian asked for. An existing task row automatically points to the forwarded message in this Concierge chat, unless the task already has a chat thread.",
      inputSchema: {
        type: "object",
        required: ["chatId"],
        properties: {
          chatId: { type: "string" },
          intro: { type: "string", description: "Optional short line sent before it." },
          answers: ANSWERS_PARAMETER,
        },
      },
      handler: (input) =>
        runTool("chat_forward", input, async (args) => {
          const chatId = requireString(args, "chatId");
          const chat = await requireTaskChat(chatId);
          const [latest] = await latestSaid(
            messages,
            taskChatPlace(chatId),
            1,
            (message) => message.direction === "fromRome" && hasText(message),
          );
          const answer = latest?.body.text ?? null;
          if (!answer) throw new Error("The task chat has no answer yet");
          currentTurn();
          await relayToTaskThread(chatId, optionalString(args, "answers"));
          const messageId = await forward(
            answer,
            { chatId, title: chat.name },
            optionalString(args, "intro"),
            optionalString(args, "answers"),
          );
          const task = await pointTaskTo(chatId, messageId);
          return {
            forwardedChars: answer.length,
            messageId,
            ...(task ? { taskAnchored: task.id } : {}),
          };
        }),
    },
    {
      name: "chat_card",
      description:
        "Show the guardian a card that opens a task chat and shows its live status. " +
        "Use it for a task question or approval and use the returned messageId as the needs_user row anchor. Also use it to open or find a task chat instead of sending its id. " +
        "An existing task row automatically points to this card in this Concierge chat, unless the task already has a chat thread.",
      inputSchema: {
        type: "object",
        required: ["chatId"],
        properties: { chatId: { type: "string" } },
      },
      handler: (input) =>
        runTool("chat_card", input, async (args) => {
          const chatId = requireString(args, "chatId");
          const chat = await requireTaskChat(chatId);
          currentTurn();
          const messageId = await showCard(chatId, chat.name);
          await pointTaskTo(chatId, messageId);
          return { sent: "Shown; the guardian sees the card.", messageId };
        }),
    },
    {
      name: "connect_card",
      description:
        "Show the guardian a card that connects a service that is not connected yet, so they do not have to find Settings. " +
        "`service` is the name `core:concierge_following_list` gives it. A service that already works shows no card and the answer says so. " +
        "When the guardian connects it, a `<service_connected/>` input arrives in this chat.",
      inputSchema: {
        type: "object",
        required: ["service"],
        properties: { service: { type: "string" } },
      },
      handler: (input) =>
        runTool("connect_card", input, async (args) => {
          const wanted = requireString(args, "service");
          const { chatId, turnId } = currentTurn();
          const { connectors } = await service.following.list(await ownerHere());
          const connector = connectors.find((entry) => entry.service === wanted);
          if (!connector) {
            throw new Error(
              `No service ${wanted}. Use core:concierge_following_list for the service names.`,
            );
          }
          if (connector.state === "working") {
            return { connected: true, note: "Already connected; no card shown." };
          }
          const { id } = await webchatRepo.addBackendMessage(
            chatId,
            turnId,
            [
              {
                type: "connect_card",
                service: connector.service,
                label: connector.label,
                icon: connector.icon,
                // A service with no entry can only be connected from Settings.
                connect: connector.connect ?? { kind: "dashboard" },
              },
            ],
            await placementFor(undefined).then(({ chatThread }) =>
              chatThread ? { chatThread } : {},
            ),
          );
          said(chatId, turnId, null);
          return { sent: "Shown; the guardian sees the card.", messageId: id };
        }),
    },
  ];
}
