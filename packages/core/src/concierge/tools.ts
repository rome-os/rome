// Concierge's session tools: `say` is its only way to speak, the `chat_*`
// tools run its task chats and read its other Concierge chats, `topic_start`
// starts a topic chat, and `connect_card` shows a card that connects a service.

import type { ForwardedFrom } from "@rome/api-types/chat";
import { CONCIERGE_TASK_SUMMARY_MAX_LENGTH } from "@rome/api-types/concierge";
import { finiteOrNull, type TaskStatusView } from "./tasks.js";
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
import { CONCLUSION_MAX_CHARS, conclusionOf, withoutMarkers } from "./conclusion.js";
import { automatedSource } from "../webchat/automated-source.js";
import { ownerOf } from "../webchat/owner.js";
import {
  parseTaskSchedule,
  SCHEDULE_REPORTS,
  SCHEDULE_WEEKDAYS,
  type TaskScheduleView,
} from "./task-schedule.js";

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

/** The parameter that names the task a message reports on. */
const TASK_PARAMETER = {
  type: "string",
  description:
    "The id of the task this message reports on, from task_list or a <task id> line. Pass it whenever the message tells a task's result or news, in any turn: the message then goes in that task's thread. In a turn that holds both a guardian message and another task's news, a message that names no task or answers goes in no thread.",
};

/** The parameter that names the guardian message whose words go on to a task. */
const RELAYS_PARAMETER = {
  type: "string",
  description:
    "The message_id of the guardian message whose words you send on to the task, from its <chat_thread> line. That message joins the task's chat thread and shows the task working. Required when this turn carries several guardian messages, its own or ones an interrupted turn handed on; without it nothing joins and nothing is marked.",
};

/** The parameter that names the one guardian message an answer answers. */
const ANSWERS_PARAMETER = {
  type: "string",
  description:
    "The message_id of the guardian message this answers, from its <chat_thread> line. Required when the turn carries several guardian messages, its own or ones an interrupted turn handed on, or a guardian message and another task's news, so the answer goes where that message is; without it such an answer goes in no thread.",
};

/** The parameter that names the guardian message a forward is the content of. */
const FORWARD_ANSWERS_PARAMETER = {
  type: "string",
  description:
    "The message_id of the guardian message, from its <chat_thread> line, that asked for this content. Set it only when this forward is what that message asked for: that message then joins the task's thread for good. A forward that only reports a task's news names none.",
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

/** A row as the Concierge reads it: compact, with no empty fields. Rome derives its status. */
/**
 * A row as `task_list` answers it: its id, title, status, task chat and
 * schedule, and with `details` also what the Concierge wrote on it and its
 * schedule's brief.
 */
function compactTask(
  { row }: ConciergeTaskWithChat,
  status: TaskStatusView | undefined,
  details: boolean,
  schedule?: TaskScheduleView | null,
) {
  return {
    id: row.id,
    title: row.title,
    ...(status ? { status: status.status } : {}),
    ...(status?.endReason ? { endReason: status.endReason } : {}),
    ...(finiteOrNull(status?.laterAt ?? null) !== null
      ? { laterAt: new Date(status?.laterAt as number).toISOString() }
      : {}),
    ...(row.sessionId ? { chatId: row.sessionId } : {}),
    ...(schedule
      ? {
          schedule: {
            at: schedule.at,
            ...(schedule.days ? { days: schedule.days } : {}),
            report: schedule.report,
            ...(details ? { brief: schedule.brief } : {}),
            ...(schedule.nextRunAt
              ? { nextRunAt: new Date(schedule.nextRunAt).toISOString() }
              : {}),
          },
        }
      : {}),
    ...(details
      ? {
          ...(row.summary ? { summary: row.summary } : {}),
          ...(row.note ? { note: row.note } : {}),
          updatedAt: row.updatedAt.toISOString(),
        }
      : {}),
  };
}

/** The `schedule` parameter of chat_start and task_upsert. */
const SCHEDULE_PARAMETER = {
  type: ["object", "null"],
  description:
    "Run this task again and again: at each time, Rome sends `brief` into the task's own task chat, without a turn of yours, and the result comes back to you as any task's does. Between runs the task is later. On task_upsert, null removes the schedule.",
  required: ["at"],
  properties: {
    at: { type: "string", description: 'Local time in the guardian\'s zone, "HH:MM".' },
    days: {
      type: "array",
      items: { type: "string", enum: [...SCHEDULE_WEEKDAYS] },
      description: "The weekdays it runs on. Leave out for every day.",
    },
    report: {
      type: "string",
      enum: [...SCHEDULE_REPORTS],
      description:
        "every_run: each run's result is reported to you. when_it_matters: a run that finishes with nothing to ask goes to the next digest as <ran_on_schedule>; a question, an approval or a failure still comes to you.",
    },
    brief: {
      type: "string",
      description:
        "What each run asks the task chat, standing on its own. chat_start uses its own brief when you leave it out; task_upsert keeps the one the schedule has.",
    },
  },
} as const;

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

  // Whether the row `taskId` belongs to this Concierge chat, with the chat
  // that owns it. A row with no owner to find counts as ours.
  const rowOwnedElsewhere = async (taskId: string) => {
    const { chatId: here } = currentTurn();
    const found = await tasks.repo.getWithChat(taskId);
    return found && found.conciergeChat.id !== here ? found.conciergeChat : null;
  };

  // Refuses a write that would move a row another Concierge chat owns here:
  // its result and thread belong to that chat.
  const requireRowHere = async (taskId: string, then: string) => {
    const other = await rowOwnedElsewhere(taskId);
    if (other) {
      throw new Error(`Task ${taskId} belongs to another Concierge chat (${other.name}). ${then}`);
    }
  };

  // A task chat this Concierge chat started, which it may send into or
  // forward. A task another Concierge chat started is refused. A task chat
  // with no row yet counts as ours.
  const requireOwnTaskChat = async (chatId: string) => {
    const chat = await requireTaskChat(chatId);
    const task = await tasks.repo.findBySession(chatId);
    const other = task ? await rowOwnedElsewhere(task.id) : null;
    if (other) {
      throw new Error(
        `Task chat ${chatId} belongs to another Concierge chat (${other.name}). ` +
          "Start a task here with chat_start; read that chat with chat_read first to reuse what it found.",
      );
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
  const ownRows = async (includeEnded: boolean) => {
    const owner = await ownerHere();
    const rows = (await tasks.repo.listForAgent(true)).filter((task) => task.owner === owner);
    const status = await tasks.statusOf(rows.map((task) => task.row));
    return rows
      .map((task) => ({ ...task, status: status.get(task.row.id) }))
      .filter((task) => includeEnded || task.status?.status !== "ended");
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

  // A message is what its parts say, about which task, answering which
  // messages: the same words about another task, or answering another
  // message, are another message.
  const sayKey = (content: string, taskId: string | undefined, answers: unknown) =>
    JSON.stringify([taskId ?? null, answers ?? null, content]);

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

  // The message a new task's row points to: the one passed, else the
  // guardian message `answers` names, else the latest thing said this turn,
  // else the turn's only guardian message. What was said this turn may be
  // another task's report, so the guardian message the task is for comes
  // first.
  const sourceMessageForTask = async (
    explicit: string | undefined,
    answers: string | undefined,
  ) => {
    if (explicit) return requireSourceMessage(explicit);
    const { chatId } = currentTurn();
    // The guardian message the task is for comes before anything said this
    // turn, which may be another task's report.
    if (answers && (await webchatRepo.getReplyTarget(chatId, answers))?.role === "user") {
      return answers;
    }
    // With several guardian messages, which one the task is for, or which
    // one this turn's last line answered, is a guess.
    const prompts = await turnPrompts();
    if (prompts.length > 1) {
      throw new Error(
        "This turn carries several guardian messages. Pass answers: the message_id of the one this task is for.",
      );
    }
    const latest = await latestSaidThisTurn();
    if (latest) return latest;
    const only = prompts[0];
    if (only && (await webchatRepo.getReplyTarget(chatId, only))?.role === "user") return only;
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
    await writeReaction("mark", () => tasks.repo.linkMessage(taskId, target));
    try {
      await send();
    } catch (error) {
      await writeReaction("take back", () => tasks.repo.unlinkMessage(taskId, target));
      throw error;
    }
  };

  // What the Concierge writes on a row: what Rome cannot know. Rome derives
  // the status, and a field from before it is refused by name.
  const parseTaskWrite = async (
    raw: Record<string, unknown>,
    where: string,
  ): Promise<{ write: ConciergeTaskWrite; stop: boolean }> => {
    const write: ConciergeTaskWrite = {};
    const text = (field: string) => {
      const value = raw[field];
      if (value === null) return null;
      if (typeof value !== "string") throw new Error(`${where}.${field} must be a string or null`);
      return value.trim() || null;
    };
    for (const field of ["state", "waitingOn", "dueAt", "rank", "chatId"]) {
      if (raw[field] !== undefined) {
        throw new Error(
          `${where}.${field} is no longer written: Rome keeps each task's status from its task chat. ` +
            "Start a task with chat_start, stop it with stop, and schedule a check with defer.",
        );
      }
    }
    if (raw.id !== undefined) {
      write.id = requireString(raw, "id");
      await requireTaskRow(write.id);
    }
    if (raw.title !== undefined) write.title = requireString(raw, "title");
    if (raw.summary !== undefined) {
      const summary = text("summary");
      write.summary =
        summary && summary.length > CONCIERGE_TASK_SUMMARY_MAX_LENGTH
          ? `${summary.slice(0, CONCIERGE_TASK_SUMMARY_MAX_LENGTH - 1)}…`
          : summary;
    }
    if (raw.note !== undefined) write.note = text("note");
    if (raw.archived !== undefined) {
      if (typeof raw.archived !== "boolean") throw new Error(`${where}.archived must be a boolean`);
      write.archived = raw.archived;
    }
    if (raw.stop !== undefined && typeof raw.stop !== "boolean") {
      throw new Error(`${where}.stop must be a boolean`);
    }
    const stop = raw.stop === true;
    if (stop && !write.id) throw new Error(`${where}.stop needs the id of the task to stop`);
    const messageId = raw.messageId === undefined ? undefined : requireString(raw, "messageId");
    // A row belongs to the Concierge chat it was made in, and moves to the
    // chat whose message it is pointed at.
    if (!write.id) {
      if (!write.title) throw new Error(`${where}.title is required to create a row`);
      write.sourceMessageId = await sourceMessageForNewRow(messageId);
      write.chatId = currentTurn().chatId;
    } else if (messageId) {
      await requireRowHere(
        write.id,
        "Update it there, or start a task here with chat_start. Without a messageId you can still update its summary.",
      );
      write.sourceMessageId = await requireSourceMessage(messageId);
      write.chatId = currentTurn().chatId;
    }
    return { write, stop };
  };

  // Stops a task: Rome keeps it stopped, and its task chat's running work stops.
  const stopTask = (taskId: string) => service.stopTask(taskId, "concierge");

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

  // The user-role messages this turn took: one still queued behind it belongs
  // to the turn that takes it. An automation's or an agent's input is stored
  // as one too, its source in `senderId`.
  const ownPrompts = async () => {
    const { chatId, turnId } = currentTurn();
    return (await webchatRepo.getTurnChatMessages(chatId, turnId)).filter(
      (row) => row.role === "user" && row.inputState !== "queued",
    );
  };

  // The messages this turn answers: the ones it took, and the ones a turn a
  // newer input superseded handed on to it. An automated input counts: the
  // reply to it is placed and its status reaction settled like any other's.
  const turnPrompts = async () => {
    const { chatId } = currentTurn();
    const own = (await ownPrompts()).map((row) => row.id);
    const handedOn = service.promptsHandedOn(chatId).filter((id) => !own.includes(id));
    return [...handedOn, ...own];
  };

  // Whether the guardian started this turn: one of the messages it took is
  // not an automation's or an agent's. A message an earlier, cut-short turn
  // handed on does not count, so a turn that only reports on tasks, or only
  // continues work on its own, never counts either.
  const guardianStartedTurn = async () =>
    (await ownPrompts()).some((row) => automatedSource(row.senderId) === null);

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

  /**
   * This turn's guardian messages, once it is certain which one `answers`
   * names or, with none named, that the turn has at most one: a message sent
   * on to a task is never a guess.
   */
  const requireOnePrompt = async (answers: string | undefined, what: string) => {
    const prompts = await requireTurnPrompt(answers);
    if (answers === undefined && prompts.length > 1) {
      throw new Error(
        `This turn carries several guardian messages. Pass answers: the message_id of the one ${what}.`,
      );
    }
    return prompts;
  };

  /**
   * The task whose chat thread message `messageId` is in, with the thread's
   * root, or null. Only a task has a thread: a thread no task has, from
   * before, counts as none (docs/domains/chats.md#chat-thread).
   */
  const taskThreadOf = async (chatId: string, messageId: string) => {
    const root = (await webchatRepo.getReplyTarget(chatId, messageId))?.chatThreadId ?? null;
    const task = root ? await tasks.repo.taskOfThread(chatId, root) : null;
    return root && task ? { root, task } : null;
  };

  /** The task chat thread a message is in, or null when it is in none. */
  const threadOf = async (chatId: string, messageId: string) =>
    (await taskThreadOf(chatId, messageId))?.root ?? null;

  /**
   * Whether a message is in any chat thread, one from before that no task
   * has included: such a message is settled there, so nothing moves it into
   * a task's thread and no task takes it as its root.
   */
  const inAnyThread = async (chatId: string, messageId: string) =>
    Boolean((await webchatRepo.getReplyTarget(chatId, messageId))?.chatThreadId);

  // A guardian message in a task's thread is that task's: the Concierge
  // sends it on to that task or answers it itself, never sends it to another.
  const requireOwnTask = async (taskChatId: string, messageId: string | undefined) => {
    if (!messageId) return;
    const owner = await taskThreadOf(currentTurn().chatId, messageId);
    if (!owner) return;
    // Rows from before one root per task may share it: each owns the thread.
    if ((await tasks.repo.findBySession(taskChatId))?.threadRoot === owner.root) return;
    throw new Error(
      `Guardian message ${messageId} is in the thread of task ${owner.task.id} ("${owner.task.title}"). Send it on to that task, or answer it yourself with say.`,
    );
  };

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
  ): Promise<{ answered: string; root: string | null; turnId: string | null } | null> => {
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
        const prompts =
          !pointed?.turnId || pointed.turnId === turnId
            ? await turnPrompts()
            : await promptsOf(chatId, pointed.turnId);
        answered = prompts.length === 1 ? prompts[0] : undefined;
      }
    }
    if (!answered) return null;
    const message = await webchatRepo.getReplyTarget(chatId, answered);
    return {
      answered,
      // A message already in a thread roots nothing: one in a task's thread
      // is that task's, and one in a thread from before is settled there.
      // The task then takes the first thing it brings back.
      root: message?.chatThreadId ? null : answered,
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
    start: { answered: string; root: string | null; turnId: string | null },
  ) => {
    if (!start.root) return;
    const { chatId } = currentTurn();
    const root = await tasks.repo.setThreadRoot(taskId, start.root);
    if (!root) return;
    if (root === start.answered && !(await inAnyThread(chatId, root))) {
      await webchatRepo.placeInChatThread(chatId, root, { starts: true, settle: true });
    }
    // The acknowledgements are in the turn the guardian's message prompted.
    const turnId = start.turnId;
    if (!turnId) return;
    const prompts = await promptsOf(chatId, turnId);
    const answersOf = (id: string) => namedAnswers().get(turnId)?.get(id);
    for (const row of await webchatRepo.getTurnChatMessages(chatId, turnId)) {
      if (row.role !== "assistant" || (await inAnyThread(chatId, row.id))) continue;
      const answered = answersOf(row.id) ?? (prompts.length === 1 ? prompts[0] : undefined);
      if (answered !== start.answered) continue;
      await webchatRepo.placeInChatThread(chatId, row.id, { in: root });
    }
  };

  // A task's stored root in this Concierge chat, or null.
  const rootOf = async (taskId: string): Promise<string | null> => {
    const { chatId } = currentTurn();
    const found = await tasks.repo.getWithChat(taskId);
    if (!found || found.conciergeChat.id !== chatId || !found.row.threadRoot) return null;
    // A row whose Concierge chat is archived reads as the main chat's, and
    // keeps its root, which names a message only that chat has. A deleted
    // chat's rows keep none.
    return (await webchatRepo.getReplyTarget(chatId, found.row.threadRoot))
      ? found.row.threadRoot
      : null;
  };

  // Where a message the Concierge says goes (docs/domains/chats.md#chat-thread).
  // Only a task has a thread. A message that names its subject goes there,
  // whichever turn says it: the task it is about goes into the task's thread,
  // and when the task has none yet the message becomes its root (`rootFor`);
  // the guardian message it answers takes it to that message's task thread.
  // One that names nothing goes where the turn's one subject is: the task it
  // reports on, or its only guardian message's task thread. A turn with two
  // subjects, the owner's message and a report a newer input took over, puts
  // it in no thread.
  const placementFor = async (
    answers: string | undefined,
    about: { taskId?: string | null } = {},
  ): Promise<{ chatThread?: ChatThreadPlacement; rootFor?: string }> => {
    const { chatId } = currentTurn();
    const prompts = await requireTurnPrompt(answers);
    const toTask = async (taskId: string) => {
      const own = await tasks.repo.getWithChat(taskId);
      if (own?.conciergeChat.id !== chatId) return null;
      const root = await rootOf(taskId);
      return root ? { chatThread: { in: root } } : { rootFor: taskId };
    };
    if (about.taskId) {
      const placed = await toTask(about.taskId);
      if (placed) return placed;
    }
    if (answers) {
      const thread = await threadOf(chatId, answers);
      return thread ? { chatThread: { in: thread } } : {};
    }
    if (prompts.length === 0) {
      const reported = context.getTurnReportedTask();
      return (reported ? await toTask(reported) : null) ?? {};
    }
    // Two subjects, or several guardian messages: which one this is about
    // is a guess, so it goes in no thread.
    if (prompts.length > 1 || service.carriedReport(chatId)) return {};
    const thread = await threadOf(chatId, prompts[0] as string);
    return thread ? { chatThread: { in: thread } } : {};
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
    // A turn that also carries another task's report has two subjects:
    // which one the guardian's message goes with is a guess.
    if (answers === undefined && service.carriedReport(chatId)) return;
    // Without `answers`, only the turn's one message is certain.
    const named = answers ?? (prompts.length === 1 ? prompts[0] : undefined);
    const relayed = named && !(await inAnyThread(chatId, named)) ? named : undefined;
    const task = relayed ? await tasks.repo.findBySession(taskChatId) : null;
    if (!relayed || !task) return;
    const found = await tasks.repo.getWithChat(task.id);
    if (found?.conciergeChat.id !== chatId) return;
    const root = (await rootOf(task.id)) ?? (await tasks.repo.setThreadRoot(task.id, relayed));
    // Another task claimed the message as its root first.
    if (!root) return;
    await webchatRepo.placeInChatThread(
      chatId,
      relayed,
      root === relayed ? { starts: true, settle: true } : { in: root, settle: true },
    );
  };

  // Points the task in task chat `taskChatId` to `messageId`, its panel's
  // jump target. Answers the row, or null.
  const pointTaskTo = async (taskChatId: string, messageId: string) => {
    const { chatId } = currentTurn();
    const task = await tasks.repo.findBySession(taskChatId);
    // A row another Concierge chat owns stays where it is.
    if (!task || (await rowOwnedElsewhere(task.id))) return null;
    await tasks.repo.setSourceMessage(task.id, chatId, messageId);
    return task;
  };

  const say = async (
    text: string,
    format: "bubble" | "long",
    isPrivate: boolean,
    answers?: string,
    taskId?: string,
  ) => {
    const { chatId, turnId } = currentTurn();
    if (taskId) {
      const own = await tasks.repo.getWithChat(taskId);
      if (own?.conciergeChat.id !== chatId) {
        throw new Error(`No task ${taskId} in this chat. Pass a task id from task_list.`);
      }
    }
    const parts: Parameters<typeof webchatRepo.addBackendMessage>[2] = [
      { type: "text", content: text, ...(format === "long" ? { format } : {}) },
    ];
    // A model sometimes repeats a message word for word in one turn. Each
    // message can ring the guardian's phone, so the repeat is the same message.
    const key = sayKey(JSON.stringify(parts), taskId, answers);
    const repeated = service.saidInTurn(turnId, key);
    if (repeated) return repeated;
    const id = await addMessage(parts, await placementFor(answers, taskId ? { taskId } : {}));
    service.keepSaid(turnId, key, id);
    if (taskId) service.noteSaid(taskId);
    noteAnswers(id, answers);
    said(chatId, turnId, text, isPrivate);
    const answered = answers ?? (await certainlyAnswered(taskId));
    if (answered) {
      await tasks.repo.answerMessage(chatId, answered).catch((error: unknown) =>
        log.warn("failed to settle an answered message's status reaction", {
          chatId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return id;
  };

  // The guardian message a `say` naming no `answers` answers, when that is
  // certain: the turn's only one, when the message is about no task or about
  // the task whose thread that one is in. Otherwise the turn's end settles it.
  const certainlyAnswered = async (taskId: string | undefined) => {
    const { chatId } = currentTurn();
    if (service.carriedReport(chatId)) return undefined;
    const prompts = await turnPrompts();
    const only = prompts.length === 1 ? prompts[0] : undefined;
    if (!only || !taskId) return only;
    // A message naming a task answers the turn's message when that message
    // is in the task's thread.
    const root = await rootOf(taskId);
    return root && (await threadOf(chatId, only)) === root ? only : undefined;
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
    // Only a result the guardian was shown counts as said.
    if (task) service.noteSaid(task.id);
    noteAnswers(id, answers);
    // Forwarded text is the task's, not the Concierge's, and so are a task's
    // title and chat name, which can come from its output: none becomes the
    // push's line, which could carry a code or password onto the lock screen.
    said(chatId, turnId, intro ?? null);
    return id;
  };

  // How `chat_card` shows task chat `chatId`: its question or approval while
  // the task waits on the guardian, an expired one included, since its card
  // still takes an answer; else its task card.
  const shownAs = async (chatId: string): Promise<"task" | "ask"> => {
    const task = await tasks.repo.findBySession(chatId);
    if (!task) return "task";
    const status = (await tasks.statusOf([task])).get(task.id);
    return status?.status === "needs_you" || status?.endReason === "no_response" ? "ask" : "task";
  };

  // A card that opens the task chat; it reads the chat's live status itself.
  const showCard = async (chatId: string, title: string, show: "task" | "ask") => {
    const { chatId: conciergeChatId, turnId } = currentTurn();
    const task = await tasks.repo.findBySession(chatId);
    const id = await addMessage(
      [{ type: "task_chat", chatId, title, show }],
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
          task: TASK_PARAMETER,
          answers: ANSWERS_PARAMETER,
        },
      },
      handler: (input) =>
        runTool("say", input, async (args) => {
          const messageId = await say(
            requireString(args, "text"),
            args.format === "long" ? "long" : "bubble",
            args.private === true,
            optionalString(args, "answers"),
            optionalString(args, "task"),
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
        "Write your task list, the guardian's panel of what you are busy with. Rome keeps each task's status from its task chat; you write only what Rome cannot know. Batch only: one call writes every row that changed. " +
        "An entry without id creates a row (title required, and a message to point to); an entry with id updates it, and fields you leave out stay. " +
        "Returns each row's id, its status, and the message it points to.",
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
                summary: {
                  type: ["string", "null"],
                  description: `One line the guardian reads, at most ${CONCIERGE_TASK_SUMMARY_MAX_LENGTH} characters: the result, or where the task stands.`,
                },
                note: {
                  type: ["string", "null"],
                  description:
                    "What you keep for your later self about the task: links, ids, what to check next. The guardian never sees it.",
                },
                stop: {
                  type: "boolean",
                  description:
                    "Stop the task: its task chat's running work stops, and it ends stopped. Only when the guardian calls it off.",
                },
                archived: { type: "boolean", description: "Archive the row, or bring it back." },
                schedule: {
                  ...SCHEDULE_PARAMETER,
                  description:
                    "Add, change or remove (null) the task's repeating schedule. Only a task with a task chat, that is not stopped.",
                },
                messageId: {
                  type: "string",
                  description:
                    "The message the row points to, as say, chat_card, or chat_forward returned it. A new row takes your latest message this turn if you leave it out. On an update it replaces the old one; leave it out to keep it. chat_card and chat_forward update this anchor automatically.",
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
          const stops: string[] = [];
          const schedules: Array<{ taskId: string; raw: unknown }> = [];
          for (const [index, raw] of args.tasks.entries()) {
            if (!raw || typeof raw !== "object")
              throw new Error(`tasks[${index}] must be an object`);
            const { write, stop } = await parseTaskWrite(
              raw as Record<string, unknown>,
              `tasks[${index}]`,
            );
            writes.push(write);
            if (stop && write.id) stops.push(write.id);
            const scheduleRaw = (raw as Record<string, unknown>).schedule;
            if (scheduleRaw !== undefined) {
              if (!write.id) {
                throw new Error(
                  `tasks[${index}].schedule needs the id of a task with a task chat. Start a scheduled task with chat_start and schedule.`,
                );
              }
              if (stop) throw new Error(`tasks[${index}] cannot both stop and schedule the task`);
              schedules.push({ taskId: write.id, raw: scheduleRaw });
            }
          }
          // Checked before anything is written, so a refusal changes nothing.
          const scheduleWrites = await Promise.all(
            schedules.map(async ({ taskId, raw }) => {
              const row = await tasks.repo.get(taskId);
              if (!row?.sessionId) {
                throw new Error(
                  `Task ${taskId} has no task chat to run in. Start it with chat_start and schedule.`,
                );
              }
              if (row.stoppedAt) {
                throw new Error(
                  `Task ${taskId} is stopped. Take it up again with chat_send first.`,
                );
              }
              if (!service.deps.schedules) throw new Error("Rome cannot schedule tasks here");
              const kept = raw === null ? null : await service.deps.schedules.of(taskId);
              const schedule = parseTaskSchedule(raw, kept?.brief);
              // A changed schedule keeps the skill its runs were started with.
              if (schedule && kept?.skill) schedule.skill = kept.skill;
              return { row, schedule };
            }),
          );
          const rows = await tasks.repo.upsertMany(writes);
          for (const taskId of stops) await stopTask(taskId);
          for (const { row, schedule } of scheduleWrites) {
            if (schedule === null) await service.deps.schedules?.remove(row.id);
            else {
              await service.deps.schedules?.set(
                {
                  id: row.id,
                  title: rows.find((written) => written.id === row.id)?.title ?? row.title,
                  owner: ownerOf(row),
                },
                schedule,
              );
            }
          }
          // Archiving a task that is still open stops it, so nothing runs
          // hidden; an archived task has nothing left to check on.
          for (const write of writes) {
            if (!write.id || write.archived !== true) continue;
            const row = await tasks.repo.get(write.id);
            const open = row && (await tasks.statusOf([row])).get(row.id)?.status !== "ended";
            if (open && !stops.includes(write.id)) await stopTask(write.id);
            await service.cancelChecks(write.id);
          }
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
          const status = await tasks.statusOf(
            await Promise.all(rows.map(async (row) => (await tasks.repo.get(row.id)) ?? row)),
          );
          // Says which message each row points to, and flags the ones that kept an
          // earlier message because the entry passed none.
          return {
            tasks: rows.map((row, index) => ({
              id: row.id,
              title: row.title,
              ...(status.get(row.id) ? { status: status.get(row.id)?.status } : {}),
              ...(anchors[index] ? { anchor: anchors[index] } : {}),
              ...(writes[index].sourceMessageId === undefined ? { anchorKept: true } : {}),
            })),
          };
        }),
    },
    {
      name: "task_list",
      description:
        "List your task list: each task's id, title, task chat and status, which Rome keeps: needs_you, active, later, or ended (with endReason done, failed, stopped or no_response). Ended rows only with includeDone. Check it before you start a task, so you do not start one twice.",
      inputSchema: {
        type: "object",
        properties: {
          includeDone: { type: "boolean", description: "Also list ended rows." },
          details: {
            type: "boolean",
            description:
              "Also answer each row's summary, the note you wrote for your later self, and when it last changed.",
          },
        },
      },
      handler: (input) =>
        runTool("task_list", input, async (args) => {
          const rows = await ownRows(args.includeDone === true);
          const schedules = await Promise.all(
            rows.map((task) => service.deps.schedules?.of(task.row.id) ?? null),
          );
          return {
            tasks: rows.map((task, index) =>
              compactTask(task, task.status, args.details === true, schedules[index]),
            ),
          };
        }),
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
              "The full request for the other agent, with every detail it needs, written in the guardian's language. It does not see this conversation.",
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
              "The message_id of the guardian message this task is for, from its <chat_thread> line, in this turn or an earlier one. Required when this turn carries several guardian messages, its own or ones an interrupted turn handed on, or the task is for one from an earlier turn: the task's results join that message's chat thread and it shows the task working. Without it, with several, nothing is marked.",
          },
          schedule: SCHEDULE_PARAMETER,
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
          // A scheduled task runs first at its time, not now.
          const schedule =
            args.schedule === undefined || args.schedule === null
              ? null
              : parseTaskSchedule(args.schedule, brief);
          // Each run sends the brief with the skill the first send would have.
          if (schedule && skill) schedule.skill = skill.name;
          if (schedule && !service.deps.schedules)
            throw new Error("Rome cannot schedule tasks here");
          if (taskId) {
            const planned = await requireTaskRow(taskId);
            await requireRowHere(taskId, "Start a task here without taskId instead.");
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
          const { chatId: conciergeChatId, turnId } = currentTurn();
          // A retry may rename the task: a start counts as failed before by
          // its row, its title or its brief.
          const startKeys = [taskId ?? title, `brief:${brief}`];
          const failedBefore = startKeys
            .map((key) => service.failedStart(conciergeChatId, turnId, key))
            .find((id) => id !== null);
          if (failedBefore) {
            throw new Error(
              `Task ${failedBefore} already failed to start this turn and is marked failed. Do not start it again; tell the guardian.`,
            );
          }
          // The task chat is the owner's, private to them as their Concierge is.
          const chatId = await service.dashboard.chats.startChat(
            {
              agentName: optionalString(args, "agent"),
              projectPath: await taskProjectPath(optionalString(args, "project")),
            },
            await ownerHere(),
          );
          // The chat, its row and its first message start together: a start
          // that fails leaves no empty chat, and its row failed, so a retry
          // makes no second task.
          let task: { id: string } | undefined;
          try {
            // Marked before the first turn, so that turn's event already sees it.
            await webchatRepo.setSessionTrigger(chatId, {
              triggerKind: TASK_CHAT_TRIGGER_KIND,
              triggerName: title,
            });
            // Linked before the first turn, so that turn's events find the row.
            [task] = await tasks.repo.upsertMany([
              taskId
                ? {
                    id: taskId,
                    sessionId: chatId,
                    ...(sourceMessageId ? { sourceMessageId, chatId: conciergeChatId } : {}),
                  }
                : {
                    title,
                    sessionId: chatId,
                    sourceMessageId,
                    chatId: conciergeChatId,
                  },
            ]);
            const started = task.id;
            if (schedule) {
              await service.deps.schedules?.set(
                { id: started, title, owner: await ownerHere() },
                schedule,
              );
            } else {
              await sendMarked(started, start?.answered, () =>
                sendInput(chatId, brief, skill?.name),
              );
            }
            // A planned row that was stopped is taken up again by its start.
            if (taskId) await tasks.repo.resume(taskId);
          } catch (error) {
            await webchatRepo.deleteSession(chatId).catch((cleanup: unknown) =>
              log.warn("failed to remove a task chat that did not start", {
                chatId,
                error: cleanup instanceof Error ? cleanup.message : String(cleanup),
              }),
            );
            if (!task) throw error;
            await tasks.repo.markStartFailed(task.id);
            for (const key of startKeys) {
              service.noteFailedStart(conciergeChatId, turnId, key, task.id);
            }
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(
              `${reason} Task ${task.id} did not start and is marked failed. Do not start it again; tell the guardian.`,
            );
          }
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
          if (args.card === true) await showCard(chatId, title, "task");
          if (schedule) {
            const view = await service.deps.schedules?.of(task.id);
            return {
              chatId,
              taskId: task.id,
              scheduled: view?.nextRunAt
                ? `First run ${new Date(view.nextRunAt).toISOString()}. Nothing runs before then.`
                : "Scheduled.",
            };
          }
          return { chatId, taskId: task.id };
        }),
    },
    {
      name: "chat_send",
      description:
        "Send a follow-up to a task chat started from this Concierge chat: more detail, a correction, or the guardian's answer to its question. " +
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
          const chat = await requireOwnTaskChat(chatId);
          const answers = optionalString(args, "answers");
          // Checked before the task hears anything, so a retry never sends twice.
          const prompts = await requireOnePrompt(answers, "whose words you pass on");
          await requireOwnTask(chatId, answers ?? (prompts.length === 1 ? prompts[0] : undefined));
          await ensureTaskRow(chat);
          const task = await tasks.repo.findBySession(chatId);
          const text = requireString(args, "text");
          // New work for a task the guardian or you stopped takes it up again.
          if (task) await tasks.repo.resume(task.id);
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
          // The task ends stopped, whether or not it was running.
          const task = await tasks.repo.findBySession(chatId);
          if (task) return { stopped: await stopTask(task.id) };
          const { chats } = service.dashboard;
          const turns = chats.activeTurns(chatId);
          for (const turnId of turns) await chats.interruptTurn(turnId);
          return { stopped: turns.length };
        }),
    },
    {
      name: "chat_list",
      description:
        "List your other chats, each with its kind: the main chat and your topic chats (kind main chat or topic chat), then the task chats you started (kind task chat), newest first, each with the id of the Concierge chat it came from and its status. Only the task chats of tasks that have not ended, unless you pass includeEnded or a status. chat_read reads any of them.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: [...TASK_STATUSES] },
          includeEnded: {
            type: "boolean",
            description:
              "Also list the task chats of ended tasks, such as one to send a follow-up into.",
          },
        },
      },
      handler: (input) =>
        runTool("chat_list", input, async (args) => {
          const wanted = TASK_STATUSES.find((status) => status === args.status);
          const everyTask = wanted !== undefined || args.includeEnded === true;
          const { chats } = service.dashboard;
          const { chatId: here } = currentTurn();
          const owner = await ownerHere();
          const all = (await webchatRepo.listSessions("all")).filter(
            (chat) => privateOwnerOf(chat) === owner,
          );
          const rows = (await ownRows(true)).filter(({ row }) => row.sessionId);
          // The Concierge chat each task chat came from, by its task row.
          const cameFrom = new Map(
            rows.map(({ row, conciergeChat }) => [row.sessionId as string, conciergeChat.id]),
          );
          const ended = new Set(
            rows.flatMap(({ row, status }) =>
              status?.status === "ended" ? [row.sessionId as string] : [],
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
            .filter((chat) => !wanted || chat.status === wanted)
            .filter((chat) => everyTask || chat.status === "running" || !ended.has(chat.chatId));
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
        "Send the guardian a finished task's conclusion, word for word, without retyping it: the short closing section the task chat writes at the end of its final answer. The message shows its source chat, which opens the details. " +
        `A conclusion over ${CONCLUSION_MAX_CHARS} characters, or none, is refused and nothing is sent: then report the outcome yourself in at most two sentences. ` +
        "Set full to send the whole answer instead, only when the guardian explicitly asks for the full text in a message they sent this turn. " +
        "The task chat must be one started from this Concierge chat. An existing task row automatically points to the forwarded message in this Concierge chat, unless the task already has a chat thread.",
      inputSchema: {
        type: "object",
        required: ["chatId"],
        properties: {
          chatId: { type: "string" },
          intro: { type: "string", description: "Optional short line sent before it." },
          full: {
            type: "boolean",
            description:
              "Send the whole answer, not its conclusion. Refused unless the guardian sent a message this turn: a turn that reports on a task never sends a full report.",
          },
          answers: FORWARD_ANSWERS_PARAMETER,
        },
      },
      handler: (input) =>
        runTool("chat_forward", input, async (args) => {
          const chatId = requireString(args, "chatId");
          const chat = await requireOwnTaskChat(chatId);
          const [latest] = await latestSaid(
            messages,
            taskChatPlace(chatId),
            1,
            (message) => message.direction === "fromRome" && hasText(message),
          );
          const answer = latest?.body.text ?? null;
          if (!answer) throw new Error("The task chat has no answer yet");
          currentTurn();
          const full = args.full === true;
          // Everything that can refuse comes before anything is said.
          if (full && !(await guardianStartedTurn())) {
            throw new Error(
              "The full text goes to the guardian only in a turn they started, when they explicitly ask for it. Forward the conclusion, or report the outcome yourself in at most two sentences.",
            );
          }
          const conclusion = full ? null : conclusionOf(answer);
          if (conclusion && conclusion.kind !== "found") {
            throw new Error(
              `${
                conclusion.kind === "missing"
                  ? "The task chat's latest answer has no conclusion section."
                  : `The task chat's conclusion is ${conclusion.length} characters, over the ${CONCLUSION_MAX_CHARS} limit.`
              } Nothing was sent. Report the outcome yourself with say, in one message of at most two sentences with task set to this task's id, and the guardian can open the task chat for details.`,
            );
          }
          const text = conclusion?.kind === "found" ? conclusion.text : withoutMarkers(answer);
          // A forward shows the task's result to the guardian; it passes their
          // message on to no task, so it needs no message named. A message
          // already in a thread stays there.
          await relayToTaskThread(chatId, optionalString(args, "answers"));
          const messageId = await forward(
            text,
            { chatId, title: chat.name },
            optionalString(args, "intro"),
            optionalString(args, "answers"),
          );
          const task = await pointTaskTo(chatId, messageId);
          return {
            forwarded: full ? "full" : "conclusion",
            forwardedChars: text.length,
            messageId,
            ...(task ? { taskAnchored: task.id } : {}),
          };
        }),
    },
    {
      name: "chat_card",
      description:
        "Show the guardian a task chat as a card. While the task waits on them, the card is its question or approval alone: the guardian answers on it, straight into the task chat, and the task waits for them until they do. Otherwise it is the task's card, with its live status and a link that opens it: use it to open or find a task chat instead of sending its id. " +
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
          // A task waiting on the guardian shows its question or approval
          // alone; any other shows its task card, to find it by.
          const messageId = await showCard(chatId, chat.name, await shownAs(chatId));
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
