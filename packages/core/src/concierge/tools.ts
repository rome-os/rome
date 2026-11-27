// Concierge's session tools: `say` is its only way to speak, the `chat_*`
// tools run its task chats (a task is its task chat) and read its other
// Concierge chats, `topic_start` starts a topic chat, `react` puts an emoji on
// a guardian message, `connect_card` shows a card that connects a service, and
// `show_card` shows a card the Concierge composes itself.

import { randomUUID } from "node:crypto";
import { pushBody } from "./push.js";
import { turnPrompts as turnPromptsOf } from "./reply-target.js";
import { approvalLine, taskCardLine } from "./task-cards.js";
import type { ForwardedFrom, TaskChatWaitedOn } from "@rome/api-types/chat";
import type { AgentPlan } from "@rome/api-types/trace-segments";
import { CONCIERGE_REACTIONS } from "@rome/api-types/concierge";
import { CONCIERGE_TASK_STATUSES } from "@rome/api-types/concierge-task-status";
import { taskLink } from "@rome/api-types/task-link";
import { finiteOrNull, type TaskStatusView } from "./tasks.js";
import type { SaidMessage } from "../chats/message.js";
import {
  type AgentCardPart,
  agentCardPart,
  SHOW_CARD_INPUT_SCHEMA,
  SHOW_CARD_TOOL,
  showCardDescription,
} from "../chats/agent-card.js";
import { askingDeviceOf } from "../connections/device/live-route.js";
import type { SendResult } from "../chats/send.js";
import type { ConciergeTaskWithChat } from "../db/repositories/concierge-tasks.js";
import {
  CONVERSATION_TITLE_MAX_LENGTH,
  conversationTitleLength,
} from "../core/conversation-title.js";
import { REPLY_TO_PARAMETER, romeToolRunner, type RomeTool } from "../agent/index.js";
import type { TaskInputSender, SessionToolContext } from "../core/session-tools.js";
import { createLogger } from "../logger.js";
import { getWebchatProjectsRoot, resolveAgentProjectPath } from "../webchat/projects.js";
import {
  CONCIERGE_ACCOUNT,
  type ConciergeService,
  isConciergeAgent,
  isConciergeChat,
  isMainConciergeChat,
  TASK_CHAT_TRIGGER_KIND,
} from "./service.js";
import { hasText, latestSaid, MAX_READ_LIMIT, taskChatPlace } from "./task-chat.js";
import { openQuestion } from "./transcript.js";
import { automatedSource } from "../webchat/automated-source.js";
import { replyQuoteOf } from "../webchat/reply-quote.js";
import { GUARDIAN_OWNER, ownerOf } from "../webchat/owner.js";
import { PRIVATE_CHILD_TRIGGER_KIND } from "../webchat/privacy.js";
import { getConfiguredInstanceOrigin } from "../instance/rome-cloud-origin.js";
import { CONNECTION_TOOLS, conciergePlaceSetup } from "./on-connection.js";
import {
  parseTaskSchedule,
  SCHEDULE_REPORTS,
  SCHEDULE_WEEKDAYS,
  type TaskScheduleView,
} from "./task-schedule.js";

const log = createLogger("concierge-tools");
const runTool = romeToolRunner(log);

/** A dashboard chat a list names as a chat, not as a task: neither a task
 *  chat nor a fork or subagent of a private chat. */
function isDashboardChat(chat: { triggerKind?: string | null }): boolean {
  return (
    chat.triggerKind !== TASK_CHAT_TRIGGER_KIND && chat.triggerKind !== PRIVATE_CHILD_TRIGGER_KIND
  );
}

const TASK_STATUSES = ["running", "idle", "waiting_input", "failed"] as const;
type TaskStatus = (typeof TASK_STATUSES)[number];
const DEFAULT_READ_LIMIT = 6;
/** How many steps of a running turn's plan chat_read shows, and how long each may be. */
const PLAN_STEPS = 8;
const PLAN_STEP_CHARS = 80;

/**
 * A running turn's plan as chat_read shows it: each step's text on one line,
 * cut to PLAN_STEP_CHARS, with its status. A plan of more than PLAN_STEPS
 * steps drops its first ones, but never the step before the first one not yet
 * completed, so the step in progress always shows.
 */
function planForRead({ steps }: AgentPlan) {
  const next = steps.findIndex((step) => step.status !== "completed");
  const from = Math.max(
    0,
    Math.min((next === -1 ? steps.length : next) - 1, steps.length - PLAN_STEPS),
  );
  return steps.slice(from, from + PLAN_STEPS).map((step) => {
    const text = step.text.replace(/\s+/g, " ").trim();
    return {
      step: text.length > PLAN_STEP_CHARS ? `${text.slice(0, PLAN_STEP_CHARS - 1)}…` : text,
      status: step.status,
    };
  });
}

function requireString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** One of `allowed`, or undefined when left out; anything else is refused. */
function optionalEnum<const T extends string>(
  args: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T | undefined {
  const value = optionalString(args, field);
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
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

/** How far back `chat_list`'s `recentlyEnded` reaches. */
const RECENTLY_ENDED_HOURS = 24;

/**
 * A task chat as `chat_list` answers it: compact, with no empty fields. Its
 * id, name, link, status, when it ended, the Concierge chat it came from,
 * start message and schedule, and with `details` also what the Concierge
 * wrote on it and its schedule's brief. Rome derives its status.
 */
function compactTask(
  { row, chat, conciergeChat, sourceMessageId }: ConciergeTaskWithChat,
  status: TaskStatusView | undefined,
  details: boolean,
  schedule?: TaskScheduleView | null,
) {
  return {
    chatId: chat.id,
    title: chat.name,
    kind: "task chat",
    link: taskLink(chat.name, chat.id),
    from: conciergeChat.id,
    ...(status ? { status: status.status } : {}),
    ...(status?.endReason ? { endReason: status.endReason } : {}),
    ...(status?.status === "ended" && row.endedAt ? { endedAt: row.endedAt.toISOString() } : {}),
    ...(finiteOrNull(status?.laterAt ?? null) !== null
      ? { laterAt: new Date(status?.laterAt as number).toISOString() }
      : {}),
    ...(sourceMessageId ? { startMessageId: sourceMessageId } : {}),
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
          ...(row.note ? { note: row.note } : {}),
          updatedAt: row.updatedAt.toISOString(),
        }
      : {}),
  };
}

/** The `schedule` parameter of chat_start and chat_update. */
const SCHEDULE_PARAMETER = {
  type: ["object", "null"],
  description:
    "Run this task again and again: at each time, Rome sends `brief` into the task's own task chat, without a turn of yours, and the result comes back to you as any task's does. Between runs the task is later. On chat_update, null removes the schedule.",
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
        "every_run: tell the guardian each run's result. when_it_matters: tell them only news or a problem. Every run's result comes to you either way.",
    },
    brief: {
      type: "string",
      description:
        "What each run asks the task chat, standing on its own. chat_start uses its own brief when you leave it out; chat_update keeps the one the schedule has.",
    },
  },
} as const;

function refusal(result: Exclude<SendResult, { ok: true }>): string {
  if ("error" in result) return result.error;
  if ("invalid" in result) return result.invalid;
  return `The task chat cannot take a message (${result.send})`;
}

/** The tool use the one card part of a stored message waits on, or undefined. */
function toolUseOf(content: string): string | undefined {
  try {
    const parts: unknown = JSON.parse(content);
    const part = Array.isArray(parts) ? (parts[0] as { toolUseId?: unknown }) : undefined;
    return typeof part?.toolUseId === "string" ? part.toolUseId : undefined;
  } catch {
    return undefined;
  }
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
  // On a connection the Concierge answers in plain text, and keeps only the
  // tools for tasks (CONNECTION_TOOLS): a task started there reports to
  // that chat. Every other tool needs a Concierge chat on the dashboard.
  const onConnection = conciergePlaceSetup(context.agentName, context.getThreadContext()) !== null;
  // The connection chat this session is in, for a turn whose thread does not
  // name it, as a task's report does.
  let sessionChatId: string | null = null;
  if (onConnection) {
    try {
      sessionChatId = (await webchatRepo.chatOfSession(context.sessionId))?.id ?? null;
    } catch {
      // A turn whose thread names its chat needs no lookup.
    }
  }

  const currentTurn = (): { chatId: string; turnId: string } => {
    const turnId = context.getTurnId();
    const thread = context.getThreadContext();
    if (onConnection) {
      const chatId = thread?.romeSessionId ?? sessionChatId;
      if (!turnId || !chatId) throw new Error("This tool works only during a turn in this chat");
      return { chatId, turnId };
    }
    if (!turnId || thread?.channel !== "webchat" || !thread.threadId) {
      throw new Error("This tool works only during a turn in a Concierge chat");
    }
    return { chatId: thread.threadId, turnId };
  };

  // The keys of this turn's messages in a chat on a connection, oldest first.
  // The model sees no message ids there, so a reply and a reaction name one
  // of these, never an id it guessed.
  const turnMessageKeys = async (chatId: string, turnId: string) =>
    (await webchatRepo.getTurnChatMessages(chatId, turnId))
      .filter((row) => row.role === "user")
      .map((row) => row.id);

  // A reaction in a chat on a connection: one emoji on the turn's message,
  // sent to the platform. It cannot be taken back there, and no message status
  // follows it.
  const reactOnConnection = async (args: Record<string, unknown>) => {
    const { chatId, turnId } = currentTurn();
    const { emoji } = args;
    if (emoji === null) throw new Error("A reaction here cannot be taken back.");
    if (!(CONCIERGE_REACTIONS as readonly unknown[]).includes(emoji)) {
      throw new Error(`emoji must be one of ${CONCIERGE_REACTIONS.join(" ")}`);
    }
    const chat = await service.connectionChat(chatId);
    if (!chat) throw new Error("This chat takes no reaction.");
    const keys = await turnMessageKeys(chatId, turnId);
    const asked = optionalString(args, "message_id");
    const target = asked && keys.includes(asked) ? asked : keys.at(-1);
    if (!target) throw new Error("No message in this turn to react to.");
    if (!service.deps.reactInChat) throw new Error("This chat takes no reaction.");
    // A message shows one emoji for its whole life, as on the dashboard: one
    // that showed working takes no reaction (docs/domains/chats.md#reaction).
    if (await tasks.repo.showedWorking(chatId, target)) {
      return "Not reacted: this message already showed 👀 working, and a message shows one emoji. Answer it in one short line with say instead.";
    }
    await service.deps.reactInChat(chat, target, emoji as string);
    // The reaction is how the turn handles the message: it shows working never.
    await service.messageStatus.reactedTo(chatId, target);
    return `Reacted ${emoji as string}.`;
  };

  // A task's link as this chat shows it: a chip on the dashboard, and the
  // dashboard's public address on a connection, where a chip means nothing.
  // With no public address, only the title: a loopback address opens nowhere
  // on the guardian's phone.
  const linkOf = (title: string, chatId: string) => {
    if (!onConnection) return taskLink(title, chatId);
    const plain = title.replace(/[[\]]/g, "");
    const origin = getConfiguredInstanceOrigin();
    return origin ? `[${plain}](${origin}/chat/${encodeURIComponent(chatId)})` : plain;
  };

  const taskProjectPath = async (project: string | undefined) =>
    project === undefined
      ? undefined
      : resolveAgentProjectPath(
          project,
          (await webchatRepo.listProjects()).map((stored) => stored.path),
        );

  // Whose Concierge this turn is: the owner of the chat it runs in. The
  // chats and rows its lists show are that owner's, and so is what it makes.
  const ownerHere = async () => {
    const { chatId } = currentTurn();
    // A chat on a connection is the guardian's Concierge's.
    if (onConnection) return GUARDIAN_OWNER;
    const owner = await service.ownerOfChat(chatId);
    if (owner === null) throw new Error(`No Concierge chat ${chatId}`);
    return owner;
  };

  const requireTaskChat = async (chatId: string) => {
    const chat = await webchatRepo.getSession(chatId);
    if (chat?.triggerKind !== TASK_CHAT_TRIGGER_KIND) {
      throw new Error(`No task chat ${chatId}. Use chat_list to find your task chats.`);
    }
    return chat;
  };

  // The Concierge chat that owns task chat `chatId`, when another one than
  // this does.
  const rowOwnedElsewhere = async (chatId: string) => {
    const { chatId: here } = currentTurn();
    const found = await tasks.repo.getWithChat(chatId);
    return found && found.conciergeChat.id !== here ? found.conciergeChat : null;
  };

  // A task chat this Concierge chat started, which it may send into. A task
  // another Concierge chat started is refused.
  const requireOwnTaskChat = async (chatId: string) => {
    const chat = await requireTaskChat(chatId);
    const other = await rowOwnedElsewhere(chatId);
    if (other) {
      throw new Error(
        `Task chat ${chatId} belongs to another Concierge chat (${other.name}). ` +
          "Start a task here with chat_start; read that chat with chat_read first to reuse what it found.",
      );
    }
    return chat;
  };

  // A chat the Concierge may read: a task chat, a Concierge chat, or any
  // other dashboard chat, since every member may read every chat (#2722 D12).
  const requireReadableChat = async (chatId: string) => {
    const chat = await webchatRepo.getSession(chatId);
    const readable =
      chat !== null &&
      (chat.triggerKind === TASK_CHAT_TRIGGER_KIND ||
        isConciergeChat(chat) ||
        (chat.type === "webchat" && isDashboardChat(chat)));
    if (!chat || !readable) {
      throw new Error(`No task chat or Concierge chat ${chatId}. Use chat_list to find them.`);
    }
    return chat;
  };

  /** This owner's task chats, as the agent's list reads them; on a
   *  connection, every member's. */
  const ownRows = async (includeEnded: boolean) => {
    const owner = await ownerHere();
    const rows = (await tasks.repo.listForAgent(true)).filter(
      (task) => onConnection || task.owner === owner,
    );
    const status = await tasks.statusOf(rows.map((task) => task.row));
    return rows
      .map((task) => ({ ...task, status: status.get(task.row.id) }))
      .filter((task) => includeEnded || task.status?.status !== "ended");
  };

  /** Who `owner` is, as a list names them. */
  const ownerName = async (owner: string) => {
    const profile = await service.owners.profileOf(owner);
    return profile.name ?? profile.email ?? profile.role;
  };

  /** On a connection, every chat a member may read but the one the turn is
   *  in: each person's Concierge chats, named by whose they are, then the
   *  other dashboard chats. Task chats are listed as tasks. */
  const everyChat = async (here: string) => {
    const chats = (await webchatRepo.listSessions("active")).filter(
      (chat) => chat.id !== here && isDashboardChat(chat),
    );
    // One lookup per person, however many chats they have.
    const names = new Map<string, Promise<string>>();
    const nameOf = (owner: string) => {
      const known = names.get(owner) ?? ownerName(owner);
      names.set(owner, known);
      return known;
    };
    const conciergeChats = await Promise.all(
      chats.filter(isConciergeChat).map(async (chat) => ({
        chatId: chat.id,
        title: chat.name,
        kind: service.isMainChat(chat) ? "main chat" : "topic chat",
        owner: await nameOf(ownerOf(chat)),
      })),
    );
    const others = chats
      .filter((chat) => !isConciergeChat(chat))
      .map((chat) => ({ chatId: chat.id, title: chat.name, kind: "dashboard chat" }));
    return [...conciergeChats, ...others];
  };

  // Said as Concierge's account, so the task event reads who asked off the
  // message. The device the guardian asks from goes with the work, so the
  // task chat's live reads ask that device too, not another install.
  const sendInput = async (
    sender: TaskInputSender | undefined,
    chatId: string,
    text: string,
    skillName?: string,
  ) => {
    const asking = askingDeviceOf(context.getThreadContext());
    if (asking) await webchatRepo.setAskingDevice(chatId, asking);
    const body = { text, ...(skillName ? { skillName } : {}) };
    const send = () => service.dashboard.send(taskChatPlace(chatId), body, CONCIERGE_ACCOUNT);
    const sent = sender ? await sender(chatId, body, send) : await send();
    if (!sent.ok) throw new Error(refusal(sent));
  };

  // A task points back to a message of this chat, its start message.
  const requireSourceMessage = async (messageId: string) => {
    const { chatId } = currentTurn();
    if (!(await webchatRepo.getReplyTarget(chatId, messageId))) {
      throw new Error(
        `No message ${messageId} in this chat. Pass the messageId that say returned.`,
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

  // A message is what its parts say, replying to which message: the same
  // words replying to another message are another message.
  const sayKey = (content: string, replyTo: string | undefined) =>
    JSON.stringify([replyTo ?? null, content]);

  const NO_ROW_MESSAGE =
    "A new task needs a message to point to. Call say first, then pass the messageId it returns.";

  // The message a new task's row points to: the one passed, else the
  // guardian message `answers` names, else the latest thing said this turn
  // when it is in the thread of the turn's only guardian message or the turn
  // has none, else that guardian message. What was said this turn may be
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
    const only = prompts[0];
    const guardian =
      only && (await webchatRepo.getReplyTarget(chatId, only))?.role === "user" ? only : undefined;
    // The latest thing said counts only when it is in the guardian message's
    // chat thread: a report on another task, said in this turn, is not.
    if (latest && guardian) {
      const rootOf = async (key: string) =>
        (await webchatRepo.getReplyTarget(chatId, key))?.chatThreadId ?? key;
      return (await rootOf(latest)) === (await rootOf(guardian)) ? latest : guardian;
    }
    if (latest) return latest;
    if (guardian) return guardian;
    throw new Error(NO_ROW_MESSAGE);
  };

  // Rome's status on the guardian message a task works for
  // (docs/domains/chats.md#status). It only shows how the work stands, so
  // failing to write it never fails the tool.
  const writeStatus = async <T>(label: string, write: () => Promise<T>): Promise<T | null> => {
    try {
      return await write();
    } catch (error) {
      log.warn(`failed to ${label} a message's task`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  // Sends `send` on to task `taskId` with guardian message `messageKey`
  // linked to it, so the message shows working while the task does: linked
  // first, so a task that ends at once still settles it. When the task never
  // hears it the link is taken back to what it was, unless `keepOnFailure`:
  // a task whose start failed stays, failed, and its message shows it.
  const sendLinked = async (
    taskId: string,
    messageKey: string | undefined,
    send: () => Promise<void>,
    { keepOnFailure = false }: { keepOnFailure?: boolean } = {},
  ) => {
    if (!messageKey) return send();
    const target = { chatId: currentTurn().chatId, messageKey };
    const before = await writeStatus("link", () => tasks.repo.linkMessage(taskId, target));
    try {
      await send();
    } catch (error) {
      if (!keepOnFailure) {
        if (before) {
          await writeStatus("unlink", () => tasks.repo.unlinkMessage(taskId, target, before));
        }
      }
      throw error;
    }
  };

  // Stops a task: Rome keeps it stopped, and its task chat's running work stops.
  const stopTask = (chatId: string) => service.stopTask(chatId, "concierge");

  const findListEntry = async (chatId: string) =>
    (await webchatRepo.listSessions("all")).find((chat) => chat.id === chatId);

  // Every message of a turn with a push level may also reach the phone. Its
  // lock-screen line is what the message shows: the Concierge's words, what a
  // card asks, or a forwarded card's preview; one marked private pushes a fixed
  // line.
  const said = (chatId: string, turnId: string, ownWords: string | null, isPrivate = false) =>
    service.said({
      turnId,
      chatId,
      ownWords,
      ...(isPrivate ? { private: true } : {}),
      level: context.getTurnPushLevel(),
    });

  // The messages this turn answers (reply-target.ts).
  const turnPrompts = () => {
    const { chatId, turnId } = currentTurn();
    return turnPromptsOf(service, chatId, turnId);
  };

  // The guardian messages turn `turnId` took, as its prompts.
  const promptsOf = async (chatId: string, turnId: string) =>
    (await webchatRepo.getTurnChatMessages(chatId, turnId))
      .filter((row) => row.role === "user" && row.inputState !== "queued")
      .map((row) => row.id);

  // The guardian message a task started for `answers` or `pointsTo` works
  // for, which shows working while the task does. `answers` names it, in
  // this turn or an earlier one. Without it, it is the message the task's
  // row points to when the guardian said it, else the only guardian message
  // of the turn that said it. Several, or none, is none.
  const promptFor = async (
    answers: string | undefined,
    pointsTo: string | undefined,
  ): Promise<string | undefined> => {
    const { chatId, turnId } = currentTurn();
    if (answers !== undefined) {
      if ((await webchatRepo.getReplyTarget(chatId, answers))?.role !== "user") {
        throw new Error(
          `No message ${answers} from a person in this chat. Pass a message_id from a <chat_thread> line.`,
        );
      }
      return answers;
    }
    const pointed = pointsTo ? await webchatRepo.getReplyTarget(chatId, pointsTo) : null;
    if (pointed?.role === "user") return pointed.id;
    const prompts =
      !pointed?.turnId || pointed.turnId === turnId
        ? await turnPrompts()
        : await promptsOf(chatId, pointed.turnId);
    return prompts.length === 1 ? prompts[0] : undefined;
  };

  // The key of task `taskId`'s start message in this Concierge chat, or
  // undefined: another chat's task, or one that points nowhere.
  const startOf = async (taskId: string) => {
    const found = await tasks.repo.getWithChat(taskId);
    return found?.conciergeChat.id === currentTurn().chatId
      ? (found.sourceMessageId ?? undefined)
      : undefined;
  };

  // The message in this chat keyed `messageId`, which a message the
  // Concierge says may reply to.
  const requireReplyTarget = async (messageId: string) => {
    const target = await webchatRepo.getReplyTarget(currentTurn().chatId, messageId);
    if (!target) {
      throw new Error(
        `No message ${messageId} in this chat. Pass a message_id from a <chat_thread> line, a task's start_message_id, or a messageId say returned.`,
      );
    }
    return target;
  };

  // Task `taskId`'s start message, which its results and cards reply to
  // (docs/domains/chats.md#chat-thread), or undefined when it has none here.
  const startMessageOf = async (taskId: string | undefined) => {
    const start = taskId ? await startOf(taskId) : undefined;
    return start
      ? ((await webchatRepo.getReplyTarget(currentTurn().chatId, start)) ?? undefined)
      : undefined;
  };

  // The task a message that replies to `startKey` reports on: the one started
  // at that message, the turn's own when several are. Nothing when it is
  // not certain.
  const taskStartedAt = async (startKey: string) => {
    const { chatId } = currentTurn();
    const owner = await ownerHere();
    const started = (await tasks.repo.listStartedAt(chatId, startKey)).filter(
      (task) => task.owner === owner && task.conciergeChat.id === chatId,
    );
    const reported = context.getTurnReportedTask();
    const own = started.find((task) => task.row.id === reported);
    return (own ?? (started.length === 1 ? started[0] : undefined))?.row.id;
  };

  // Says `parts`. A message that replies to `replyTo` shows its quote
  // (docs/domains/chats.md#chat-thread), and joins its thread.
  const addMessage = async (
    parts: Parameters<typeof webchatRepo.addBackendMessage>[2],
    replyTo?: { id: string; role: "user" | "assistant"; content: string; senderId?: string | null },
  ) => {
    const { chatId, turnId } = currentTurn();
    const quote = replyTo
      ? await replyQuoteOf(replyTo, (card, waitedOn) =>
          taskCardLine(service.taskCardSources(), card, waitedOn),
        )
      : null;
    const { id } = await webchatRepo.addBackendMessage(
      chatId,
      turnId,
      quote ? [quote, ...parts] : parts,
      replyTo ? { replyTo: replyTo.id } : {},
    );
    return id;
  };

  // Points task chat `taskChatId` to `messageId`, its start message. Answers
  // the row, or null.
  const pointTaskTo = async (taskChatId: string, messageId: string) => {
    const { chatId } = currentTurn();
    const task = await tasks.repo.findBySession(taskChatId);
    // A task another Concierge chat owns stays where it is.
    if (!task || (await rowOwnedElsewhere(task.id))) return null;
    await tasks.repo.setSourceMessage(task.id, chatId, messageId);
    return task;
  };

  // Whether message `messageKey` of this chat is one a person sent: an
  // automation's or an agent's input is stored as a user message too.
  const isPersonMessage = async (messageKey: string) => {
    const message = await webchatRepo.getReplyTarget(currentTurn().chatId, messageKey);
    return message?.role === "user" && automatedSource(message.senderId) === null;
  };

  // The guardian message a `chat_send` passes on: the one `answers` names, in
  // this turn or an earlier one, which must be a guardian message of this
  // chat. Without it, the turn's only guardian message. Several, or none, is
  // none: a guess would link and move the wrong message.
  const relayedMessage = async (answers: string | undefined) => {
    if (answers !== undefined) {
      if (!(await isPersonMessage(answers))) {
        throw new Error(
          `No message ${answers} from a person in this chat. Pass a message_id from a <chat_thread> line.`,
        );
      }
      return answers;
    }
    const fromPeople: string[] = [];
    for (const key of await turnPrompts()) {
      if (await isPersonMessage(key)) fromPeople.push(key);
    }
    return fromPeople.length === 1 ? fromPeople[0] : undefined;
  };

  // Says `text` in this chat on a connection. Answers the platform's key.
  // The turn's first message quotes the message it answers, as the inbox
  // quoted every reply.
  const sayOnConnection = async (text: string, replyTo: string | undefined) => {
    const { chatId, turnId } = currentTurn();
    const chat = await service.connectionChat(chatId);
    if (!chat || !service.deps.sayInChat) throw new Error("Nothing can be said in this chat.");
    const quoting =
      replyTo ??
      (service.saidAnyInTurn(turnId) ? undefined : (await turnMessageKeys(chatId, turnId)).at(-1));
    return service.deps.sayInChat(chat, {
      text,
      ...(quoting ? { replyTo: quoting } : {}),
      turnId,
    });
  };

  const say = async (
    text: string,
    format: "bubble" | "long",
    isPrivate: boolean,
    replyTo?: string,
  ): Promise<{ id: string }> => {
    const { chatId, turnId } = currentTurn();
    // Others may read a chat on a connection, and no lock screen hides a
    // message there: nothing said there is private.
    if (onConnection && isPrivate) {
      throw new Error(
        "This chat has no private messages. Say it without the secret, or tell them to ask you for it on the dashboard.",
      );
    }
    // On a connection the model sees no message ids: a replyTo that names
    // none of the chat's quotes the turn's message instead of failing.
    const target = replyTo
      ? onConnection
        ? ((await webchatRepo.getReplyTarget(chatId, replyTo)) ?? undefined)
        : await requireReplyTarget(replyTo)
      : undefined;
    const parts: Parameters<typeof webchatRepo.addBackendMessage>[2] = [
      { type: "text", content: text, ...(format === "long" ? { format } : {}) },
    ];
    // A model sometimes repeats a message word for word in one turn. Each
    // message can ring the guardian's phone, so the repeat is the same message.
    const key = sayKey(JSON.stringify(parts), replyTo);
    const repeated = service.saidInTurn(turnId, key);
    if (repeated) return { id: repeated };
    // Only where the message goes differs: the dashboard chat, or the
    // platform the chat on a connection is on.
    let id: string;
    if (onConnection) {
      id = await sayOnConnection(text, target?.id);
    } else {
      id = await addMessage(parts, target);
    }
    service.keepSaid(turnId, key, id);
    // A reply to a task's start message tells that task's result.
    const taskId = target ? await taskStartedAt(target.id) : undefined;
    if (taskId) {
      service.noteSaid(taskId);
      await writeStatus("settle", () => tasks.resultSaid(taskId));
    }
    // A chat on a connection rings no phone: the platform tells its readers.
    if (!onConnection) said(chatId, turnId, text, isPrivate);
    await settleAnswered(target?.id, taskId);
    return { id };
  };

  // A message answers the guardian message of this turn that it replies to,
  // or the one it certainly answers: that message is settled.
  const settleAnswered = async (repliedTo: string | undefined, taskId: string | undefined) => {
    const { chatId } = currentTurn();
    const answered =
      repliedTo && (await turnPrompts()).includes(repliedTo)
        ? repliedTo
        : await certainlyAnswered(taskId);
    if (!answered) return;
    await tasks.repo.answerMessage(chatId, answered).catch((error: unknown) =>
      log.warn("failed to settle an answered message", {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  // The guardian message a message answers when it names none of the turn's,
  // when that is certain: the turn's only one, when the message is about no
  // task or about a task started in the thread that one is in. Otherwise the
  // turn's end settles it.
  const certainlyAnswered = async (taskId: string | undefined) => {
    const { chatId } = currentTurn();
    if (service.carriedReport(chatId)) return undefined;
    const prompts = await turnPrompts();
    const only = prompts.length === 1 ? prompts[0] : undefined;
    if (!only || !taskId) return only;
    // A message about a task answers the turn's message when that message
    // is in the thread the task started in.
    const start = await startOf(taskId);
    if (!start) return undefined;
    const rootOf = async (key: string) =>
      (await webchatRepo.getReplyTarget(chatId, key))?.chatThreadId ?? key;
    return (await rootOf(start)) === (await rootOf(only)) ? only : undefined;
  };

  // The guardian message `react` puts its emoji on: the one named, in this
  // turn or an earlier one, as with `chat_start`'s `answers`, else the turn's
  // only one. A message of another chat, or one the Concierge said, is none.
  const reactionTarget = async (messageId: string | undefined) => {
    const { chatId } = currentTurn();
    const refusal = (id: string) =>
      new Error(
        `No message ${id} from a person in this chat. Pass a message_id from a <chat_thread> line.`,
      );
    if (messageId !== undefined) {
      if ((await webchatRepo.getReplyTarget(chatId, messageId))?.role !== "user") {
        throw refusal(messageId);
      }
      return messageId;
    }
    const prompts = await turnPrompts();
    if (prompts.length > 1) {
      throw new Error(
        "This turn carries several guardian messages. Pass message_id: the one you react to, from its <chat_thread> line.",
      );
    }
    const only = prompts[0];
    if (!only) {
      throw new Error(
        "This turn holds no guardian message. Pass message_id from a <chat_thread> line.",
      );
    }
    return only;
  };

  // The question card message `id` of a task chat holds: its chat, the tool
  // use it waits on, and its questions in one line. Null for any other
  // message, such as an app's own card, which its task chat answers.
  const questionCardIn = async (id: string) => {
    const message = await webchatRepo.widgetMessage(id);
    if (!message) return null;
    const holder = await webchatRepo.getSession(message.chatId);
    if (holder?.triggerKind !== TASK_CHAT_TRIGGER_KIND) return null;
    const asked = openQuestion([{ id, role: "assistant", content: message.content }]);
    const toolUseId = toolUseOf(message.content);
    return asked && toolUseId ? { chatId: message.chatId, toolUseId, line: asked.line } : null;
  };

  // The approval `id` of a task chat: its chat, whether it still waits, and
  // what it asks in one line. Null for any other id.
  const approvalIn = async (id: string) => {
    const approval = await service.deps.approvals.findById(id);
    if (!approval?.threadId || approval.type !== "action_execution") return null;
    const holder = await webchatRepo.getSession(approval.threadId);
    if (holder?.triggerKind !== TASK_CHAT_TRIGGER_KIND) return null;
    return {
      chatId: approval.threadId,
      pending: approval.status === "pending",
      line: approvalLine(approval.payload, approval.description),
    };
  };

  // Forwards the question or approval `waitedOn` of task chat `taskChatId` as
  // the card itself: a task card that shows what it waits on and settles in
  // its task chat, so both chats show the same card and its one outcome
  // (docs/domains/chats.md#task). It replies to the task's start message.
  // Where this chat cannot draw cards, a question goes as a message, which
  // the guardian answers in words; `card_forward` refuses an approval there
  // before it gets here. Forwarding it twice in one turn is one message.
  const forwardAsk = async (
    taskChatId: string,
    waitedOn: TaskChatWaitedOn,
    cardId: string,
    title: string,
    line: string,
  ) => {
    const { chatId, turnId } = currentTurn();
    const key = sayKey(`card:${cardId}`, undefined);
    const repeated = service.saidInTurn(turnId, key);
    if (repeated) return repeated;
    const task = await tasks.repo.findBySession(taskChatId);
    const start = await startMessageOf(task?.id);
    // A card replies with no quote, as a forwarded result card does.
    const id =
      context.widgets === "card"
        ? (
            await webchatRepo.addBackendMessage(
              chatId,
              turnId,
              [{ type: "task_chat", chatId: taskChatId, title, show: "ask", waitedOn }],
              start ? { replyTo: start.id } : {},
            )
          ).id
        : await addMessage(
            [
              {
                type: "text",
                content: `${taskLink(title, taskChatId)}: ${line}`,
              },
            ],
            start,
          );
    said(chatId, turnId, `${title}: ${pushBody(line)}`);
    service.keepSaid(turnId, key, id);
    return id;
  };

  // Forwards the card message `cardId` of a task chat, as it is: Rome issues
  // it again here, checked as `show_card` checks one, so it never rests on
  // the task chat's stored part. It is a message of its own, as every card
  // is, replying to the task's start message with no quote. Where this chat
  // cannot draw cards, the card's plain-text line goes as a message instead.
  // Forwarding the same card twice in one turn is one message, as a repeated
  // `say` is.
  const forwardCard = async (card: AgentCardPart, cardId: string, from: ForwardedFrom) => {
    const { chatId, turnId } = currentTurn();
    const key = sayKey(`card:${cardId}`, undefined);
    const repeated = service.saidInTurn(turnId, key);
    if (repeated) return repeated;
    const task = await tasks.repo.findBySession(from.chatId);
    const start = await startMessageOf(task?.id);
    let id: string;
    if (context.widgets === "card") {
      const issued = agentCardPart(card.ui, card.text, `forward-${randomUUID()}`);
      if ("problems" in issued) {
        throw new Error(
          `The task chat's card cannot be shown: ${issued.problems.join("; ")}. Nothing was sent. Tell the result yourself with say, replying to the task's start message.`,
        );
      }
      ({ id } = await webchatRepo.addBackendMessage(
        chatId,
        turnId,
        [{ ...issued.part, forwardedFrom: from }],
        start ? { replyTo: start.id } : {},
      ));
    } else {
      id = await addMessage([{ type: "text", content: card.text, format: "long" }], start);
    }
    // Only a result the guardian was shown counts as said.
    if (task) {
      service.noteSaid(task.id);
      await writeStatus("settle", () => tasks.resultSaid(task.id));
    }
    await settleAnswered(undefined, task?.id);
    // The push shows the task's title and a preview of the card's line (the
    // guardian's call, 2026-11-14). A secret is kept off the lock screen only
    // by `say … private`.
    said(chatId, turnId, task?.title ? `${task.title}: ${pushBody(card.text)}` : card.text);
    service.keepSaid(turnId, key, id);
    return id;
  };

  const tools: RomeTool[] = [
    {
      name: "say",
      description: onConnection
        ? "Send one message to this chat. This is the only way anyone here hears you: text you write outside this tool is private. " +
          "One call is one message. This chat has no private messages, so private is refused."
        : "Send the guardian one message. This is the only way the guardian hears you: text you write outside this tool is private. " +
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
          replyTo: REPLY_TO_PARAMETER,
        },
      },
      handler: (input) =>
        runTool("say", input, async (args) => {
          const said = await say(
            requireString(args, "text"),
            args.format === "long" ? "long" : "bubble",
            args.private === true,
            optionalString(args, "replyTo"),
          );
          return {
            sent: onConnection
              ? "Sent to this chat. Call say again only for a new message."
              : "The guardian sees it. Call say again only for a new message.",
            messageId: said.id,
          };
        }),
    },
    {
      name: "react",
      description: onConnection
        ? "React to the message of this turn with an emoji. It cannot be taken back here."
        : "React to one guardian message with an emoji, or clear its reaction. A reaction never rings the phone and never answers the message. A message holds one reaction; a new one replaces it, and it stays until you change it.",
      inputSchema: onConnection
        ? {
            type: "object",
            required: ["emoji"],
            properties: {
              emoji: {
                type: "string",
                enum: [...CONCIERGE_REACTIONS],
                description: "The reaction.",
              },
            },
          }
        : {
            type: "object",
            required: ["emoji"],
            properties: {
              emoji: {
                type: ["string", "null"],
                enum: [...CONCIERGE_REACTIONS, null],
                description: "The reaction, or null to clear the message's reaction.",
              },
              message_id: {
                type: "string",
                description:
                  "The message_id of the guardian message, from its <chat_thread> line. Leave it out when this turn holds one guardian message: it reacts to that one. Required when the turn carries several.",
              },
            },
          },
      handler: (input) =>
        runTool("react", input, async (args) => {
          if (onConnection) return reactOnConnection(args);
          const { chatId } = currentTurn();
          // Only a Concierge chat, the main chat or a topic chat, takes a reaction.
          if (!(await service.conciergeChat(chatId))) {
            throw new Error(`No Concierge chat ${chatId}`);
          }
          const { emoji } = args;
          if (emoji !== null && !(CONCIERGE_REACTIONS as readonly unknown[]).includes(emoji)) {
            throw new Error(`emoji must be one of ${CONCIERGE_REACTIONS.join(" ")}, or null`);
          }
          const messageId = await reactionTarget(optionalString(args, "message_id"));
          // A message shows one emoji for its whole life: one that showed
          // working takes no reaction (docs/domains/chats.md#reaction).
          if (emoji !== null && (await tasks.repo.showedWorking(chatId, messageId))) {
            return "Not reacted: this message already showed 👀 working, and a message shows one emoji. Answer it in one short line with say instead.";
          }
          if (!(await webchatRepo.setMessageReaction(chatId, messageId, emoji as string | null))) {
            throw new Error(`Could not react to message ${messageId} in this chat.`);
          }
          // A reaction is how the turn handles the message, so it never shows
          // working (docs/domains/chats.md#status).
          if (emoji !== null) await service.messageStatus.reactedTo(chatId, messageId);
          // Taken back, the message is the turn's work again.
          else await service.messageStatus.reactionCleared(chatId, messageId);
          return emoji === null ? "Reaction cleared." : `Reacted ${emoji}.`;
        }),
    },
    {
      name: "chat_start",
      description:
        "Start a task chat: a normal chat with another agent (main by default) that does the work while you keep talking. The task chat is the task: its id is the chatId this returns, and its name is its title. " +
        "Pass skill to invoke a catalog skill on its first turn. Its result comes back to you in a <task_events> batch, in the Concierge chat you start it from. " +
        'Returns JSON text, such as {"chatId":"…","link":"[name](#rome-task=…)"}: JSON.parse it before you read a field, in a script too. ' +
        "`link` is already the whole Markdown link: paste it as it is into the message that tells the guardian about it, never inside another [title](…). It shows as a chip with the task's live status.",
      inputSchema: {
        type: "object",
        required: ["title", "brief"],
        properties: {
          title: {
            type: "string",
            description: "A short name for the chat, which is the task's name.",
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
          model: {
            type: "string",
            enum: ["fast", "strong"],
            description:
              "How strong a model the task runs on. fast for a lookup, fetching and summarizing, or a reminder; strong for research, analysis, a plan or code. Defaults to strong.",
          },
          effort: {
            type: "string",
            enum: ["low", "high"],
            description:
              "How hard the task thinks. low with fast work, high with strong work. Defaults to high.",
          },
          project: {
            type: "string",
            description: `Project the chat works in, as a path relative to the projects root ${getWebchatProjectsRoot()}, such as "website" or "apps/notes". Defaults to "default".`,
          },
          messageId: {
            type: "string",
            description:
              "The message the task points to, as say returned it. Leave it out to use your latest message this turn.",
          },
          answers: {
            type: "string",
            description:
              "The message_id of the guardian message this task is for, from its <chat_thread> line, in this turn or an earlier one: the task starts at it. Required when this turn carries several guardian messages, its own or ones an interrupted turn handed on, or the task is for one from an earlier turn.",
          },
          schedule: SCHEDULE_PARAMETER,
        },
      },
      handler: (input) =>
        runTool("chat_start", input, async (args) => {
          const sender = context.captureTaskInput?.();
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
          // Settled before the chat starts, so a refusal leaves nothing running.
          // A chat on a connection keeps no dashboard message for the task to
          // point to.
          const sourceMessageId = onConnection
            ? undefined
            : await sourceMessageForTask(messageId, optionalString(args, "answers"));
          // The guardian message the task is for, if one can tell. Checked
          // before anything starts.
          const prompt = onConnection
            ? undefined
            : await promptFor(optionalString(args, "answers"), sourceMessageId);
          const { chatId: conciergeChatId, turnId } = currentTurn();
          // A retry may rename the task: a start counts as failed before by
          // its title or its brief.
          const startKeys = [title, `brief:${brief}`];
          const failedBefore = startKeys
            .map((key) => service.failedStart(conciergeChatId, turnId, key))
            .find((id) => id !== null);
          if (failedBefore) {
            throw new Error(
              `Task chat ${failedBefore} already failed to start this turn and ended failed. Do not start it again; tell the guardian.`,
            );
          }
          // The task chat is the owner's, private to them as their Concierge is.
          const strength = optionalEnum(args, "model", ["fast", "strong"] as const);
          const effort = optionalEnum(args, "effort", ["low", "high"] as const);
          // Left out, the task runs as a task chat always has: on its agent's
          // tier, at the dashboard's effort.
          const model = strength
            ? ((await service.taskModel(conciergeChatId, strength)) ?? undefined)
            : undefined;
          // The chat exists before its first turn runs, so a start that fails
          // is a task chat whose first turn failed: its owner opens it to read
          // what went wrong, and writes in it to try again.
          const chatId = await service.dashboard.chats.startChat(
            {
              agentName: optionalString(args, "agent"),
              projectPath: await taskProjectPath(optionalString(args, "project")),
              ...(model ? { model } : {}),
              ...(effort ? { reasoningEffort: effort } : {}),
            },
            await ownerHere(),
          );
          // The first message would rename the chat, so it is named again once
          // that is sent. The task already runs, so a failure here must not read
          // as a failed start that the agent retries.
          const nameChat = async () => {
            if (conversationTitleLength(title) > CONVERSATION_TITLE_MAX_LENGTH) {
              log.warn("task chat title too long to name the chat", { chatId });
              return;
            }
            await webchatRepo.updateSessionName(chatId, title).catch((error: unknown) =>
              log.warn("failed to name a task chat", {
                chatId,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
          };
          let made = false;
          try {
            // Marked before the first turn, so that turn's event already sees it.
            await webchatRepo.setSessionTrigger(chatId, {
              triggerKind: TASK_CHAT_TRIGGER_KIND,
              triggerName: title,
            });
            // Named before the first turn: the chat is the task, and its name
            // is the task's.
            await nameChat();
            // Its row exists before the first turn, so that turn's events find it.
            await tasks.repo.create(chatId, { chatId: conciergeChatId, sourceMessageId });
            made = true;
            if (schedule) {
              await service.deps.schedules?.set(
                { id: chatId, title, owner: await ownerHere() },
                schedule,
              );
            } else {
              await sendLinked(
                chatId,
                prompt,
                () => sendInput(sender, chatId, brief, skill?.name),
                { keepOnFailure: true },
              );
            }
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            if (!made) {
              // No task was made: no chat is left behind.
              await webchatRepo.deleteSession(chatId).catch((cleanup: unknown) =>
                log.warn("failed to remove a chat that did not become a task", {
                  chatId,
                  error: cleanup instanceof Error ? cleanup.message : String(cleanup),
                }),
              );
              throw error;
            }
            // A task chat whose first turn failed: it ended failed, and its
            // chat stays for its owner to read.
            await nameChat();
            await tasks.repo.markStartFailed(chatId);
            for (const key of startKeys) {
              service.noteFailedStart(conciergeChatId, turnId, key, chatId);
            }
            throw new Error(
              `${reason} Task chat ${chatId} did not start and ended failed; its owner can read the error there. Do not start it again; tell the guardian.`,
            );
          }
          await nameChat();
          const link = linkOf(title, chatId);
          if (schedule) {
            const view = await service.deps.schedules?.of(chatId);
            return {
              chatId,
              link,
              scheduled: view?.nextRunAt
                ? `First run ${new Date(view.nextRunAt).toISOString()}. Nothing runs before then.`
                : "Scheduled.",
            };
          }
          return { chatId, link };
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
          answers: {
            type: "string",
            description:
              "The message_id of the guardian message this follow-up passes on, from its <chat_thread> line, in this turn or an earlier one: it shows working while the task works for it, and becomes the task's start message. Required when this turn carries several guardian messages: without it the send links and moves nothing.",
          },
        },
      },
      handler: (input) =>
        runTool("chat_send", input, async (args) => {
          const sender = context.captureTaskInput?.();
          currentTurn();
          const chatId = requireString(args, "chatId");
          await requireOwnTaskChat(chatId);
          const task = await tasks.repo.findBySession(chatId);
          const text = requireString(args, "text");
          // The guardian message whose words go on. It shows working while
          // the task works for it, and it becomes the task's start message
          // once the task has taken it, so the result replies to this request
          // and not to the first one. Checked before anything is sent, so a
          // bad id sends nothing.
          const relayed = onConnection
            ? undefined
            : await relayedMessage(optionalString(args, "answers"));
          // New work for a task the guardian or you stopped takes it up again.
          if (task) await tasks.repo.resume(task.id);
          // A scheduled task's runs are no work for one message: it links and moves none.
          const scheduled = task ? await service.deps.schedules?.of(task.id) : null;
          if (task && !scheduled) {
            await sendLinked(task.id, relayed, () => sendInput(sender, chatId, text));
            if (relayed) await pointTaskTo(chatId, relayed);
          } else await sendInput(sender, chatId, text);
          return "Sent; the task chat takes it as input.";
        }),
    },
    {
      name: "chat_read",
      description:
        "Read a task chat's status (running, idle, waiting_input, or failed) and its latest messages, or the latest messages of another of your Concierge chats when the guardian's question needs what was said there. `from` names the person who wrote a message. A card in a task chat shows as a message with its plain-text line and a `cardId` that card_forward sends. While it runs, `plan` is its current turn's plan, each step with its status (completed, in_progress or pending): when there is one, report its progress by the plan." +
        " It also reads any other dashboard chat by its chatId.",
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
          const row =
            chat.triggerKind === TASK_CHAT_TRIGGER_KIND ? await tasks.repo.get(chatId) : null;
          const taskStatus = row ? (await tasks.statusOf([row])).get(chatId) : undefined;
          const running = service.dashboard.chats.isRunning(chatId);
          const plan = running ? service.dashboard.chats.turnPlan(chatId) : null;
          // A message keeps its writer's name, except the guardian's.
          const profile = await service.owners.profileOf(GUARDIAN_OWNER);
          const guardian = profile.name ?? profile.email ?? profile.role;
          const writerOf = (message: SaidMessage) =>
            message.senderName ??
            (message.saidBy?.account.id === GUARDIAN_OWNER ? guardian : undefined);
          return {
            chatId,
            title: chat.name,
            kind:
              chat.triggerKind === TASK_CHAT_TRIGGER_KIND
                ? "task chat"
                : isMainConciergeChat(chat)
                  ? "main chat"
                  : isConciergeChat(chat)
                    ? "topic chat"
                    : "dashboard chat",
            status: statusOf(running, await findListEntry(chatId)),
            ...(plan ? { plan: planForRead(plan) } : {}),
            ...(taskStatus
              ? {
                  taskStatus: taskStatus.status,
                  ...(taskStatus.endReason ? { endReason: taskStatus.endReason } : {}),
                }
              : {}),
            messages: said.map((message) => ({
              id: message.id,
              role: message.direction === "fromRome" ? "assistant" : "user",
              from: writerOf(message),
              text: message.body.text,
              // A task chat's card is its message, and its id is the one
              // `card_forward` takes.
              ...(message.card && chat.triggerKind === TASK_CHAT_TRIGGER_KIND
                ? { cardId: message.id }
                : {}),
              at: message.at.toISOString(),
            })),
          };
        }),
    },
    {
      name: "chat_stop",
      description:
        'Stop a task chat\'s work: its running work stops, its checks and schedule go, and the task ends stopped. The only way to stop a task. Only when the guardian clearly calls the task off ("never mind", "算了", "不用了"). A follow-up or a side question is not a reason.',
      inputSchema: {
        type: "object",
        required: ["chatId"],
        properties: { chatId: { type: "string" } },
      },
      handler: (input) =>
        runTool("chat_stop", input, async (args) => {
          const chatId = requireString(args, "chatId");
          await requireOwnTaskChat(chatId);
          // The task ends stopped, whether or not it was running.
          return { stopped: await stopTask(chatId) };
        }),
    },
    {
      name: "chat_update",
      description:
        "Change a task chat you started. name renames the chat, which is the task's name. note is what you keep for your later self about it: links, ids, what to check next (null clears it); the guardian never sees it. archived archives the chat, which stops its work if it is still open, or brings it back. schedule adds, changes or removes (null) its repeating schedule. Fields you leave out stay. To stop a task, use chat_stop.",
      inputSchema: {
        type: "object",
        required: ["chatId"],
        properties: {
          chatId: { type: "string" },
          name: { type: "string", description: "A few words naming the task." },
          note: {
            type: ["string", "null"],
            description:
              "What you keep for your later self about the task. The guardian never sees it.",
          },
          archived: { type: "boolean", description: "Archive the task chat, or bring it back." },
          schedule: {
            ...SCHEDULE_PARAMETER,
            description:
              "Add, change or remove (null) the task's repeating schedule. Only a task that is not stopped.",
          },
        },
      },
      handler: (input) =>
        runTool("chat_update", input, async (args) => {
          const chatId = requireString(args, "chatId");
          await requireOwnTaskChat(chatId);
          const name = args.name === undefined ? undefined : requireString(args, "name");
          if (name !== undefined && conversationTitleLength(name) > CONVERSATION_TITLE_MAX_LENGTH) {
            throw new Error(
              `name is too long: at most ${CONVERSATION_TITLE_MAX_LENGTH} characters`,
            );
          }
          let note: string | null | undefined;
          if (args.note !== undefined) {
            if (args.note !== null && typeof args.note !== "string") {
              throw new Error("note must be a string or null");
            }
            note = args.note === null ? null : args.note.trim() || null;
          }
          if (args.archived !== undefined && typeof args.archived !== "boolean") {
            throw new Error("archived must be a boolean");
          }
          const row = await tasks.repo.findBySession(chatId);
          if (!row)
            throw new Error(`No task chat ${chatId}. Use chat_list to find your task chats.`);
          // Checked before anything is written, so a refusal changes nothing.
          let schedule: ReturnType<typeof parseTaskSchedule> | undefined;
          if (args.schedule !== undefined) {
            if (row.stoppedAt) {
              throw new Error(
                `Task chat ${chatId} is stopped. Take it up again with chat_send first.`,
              );
            }
            if (args.archived === true) {
              throw new Error("A task chat cannot both be archived and scheduled");
            }
            if (!service.deps.schedules) throw new Error("Rome cannot schedule tasks here");
            const kept = args.schedule === null ? null : await service.deps.schedules.of(chatId);
            schedule = parseTaskSchedule(args.schedule, kept?.brief);
            // A changed schedule keeps the skill its runs were started with.
            if (schedule && kept?.skill) schedule.skill = kept.skill;
          }
          // A rename is the chat's: one name.
          if (name !== undefined) await webchatRepo.updateSessionName(chatId, name);
          // Touched even with only a rename, so the Tasks view hears the new name.
          await tasks.repo.write(chatId, note === undefined ? {} : { note });
          if (schedule !== undefined) {
            if (schedule === null) await service.deps.schedules?.remove(chatId);
            else {
              await service.deps.schedules?.set(
                { id: chatId, title: name ?? row.title, owner: ownerOf(row) },
                schedule,
              );
            }
          } else if (name !== undefined) {
            // A schedule shows its task's name on the Routines page.
            await service.deps.schedules?.rename?.(chatId, name);
          }
          if (args.archived === true) {
            // Archiving a task that is still open stops it, so nothing runs
            // hidden; an archived task has nothing left to check on.
            await service.endTaskChat(chatId, "archived");
          } else if (args.archived === false) {
            await webchatRepo.unarchiveSession(chatId);
          }
          const now = (await tasks.repo.getWithChat(chatId)) ?? null;
          const status = now ? (await tasks.statusOf([now.row])).get(chatId) : undefined;
          return {
            chatId,
            title: now?.chat.name ?? name ?? row.title,
            link: taskLink(now?.chat.name ?? name ?? row.title, chatId),
            ...(status ? { status: status.status } : {}),
            ...(status?.endReason ? { endReason: status.endReason } : {}),
          };
        }),
    },
    {
      name: "chat_list",
      description:
        "List your other chats, each with its kind: the main chat and your topic chats (kind main chat or topic chat), then the task chats you started (kind task chat), each with its chatId, title, link, the id of the Concierge chat it came from (from), and its status, which Rome keeps: needs_you, active, later, or ended (with endReason done, failed, stopped or no_response). Only the task chats that have not ended, unless you pass includeEnded, recentlyEnded or a status; an ended one says when (endedAt). Pass here for only the task chats started from the chat you are in. Check it before you start a task, so you do not start one twice. chat_read reads any of them." +
        (onConnection
          ? " Here it lists every member's chats: each person's main and topic chats with whose they are (owner), the other dashboard chats (kind dashboard chat), and every task chat."
          : ""),
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: [...CONCIERGE_TASK_STATUSES] },
          includeEnded: {
            type: "boolean",
            description:
              "Also list the task chats that ended, such as one to send a follow-up into.",
          },
          details: {
            type: "boolean",
            description:
              "Also answer each task chat's note, the one you wrote for your later self, its schedule's brief, and when it last changed.",
          },
          recentlyEnded: {
            type: "boolean",
            description: `Also list the task chats that ended in the last ${RECENTLY_ENDED_HOURS} hours, as a progress overview does.`,
          },
          here: {
            type: "boolean",
            description:
              "List only the task chats started from the chat you are in (their from is this chat), and no other chats.",
          },
        },
      },
      handler: (input) =>
        runTool("chat_list", input, async (args) => {
          const onlyHere = args.here === true;
          const wanted = CONCIERGE_TASK_STATUSES.find((status) => status === args.status);
          const { chatId: here } = currentTurn();
          const owner = await ownerHere();
          const allEnded = wanted !== undefined || args.includeEnded === true;
          const endedSince =
            !allEnded && args.recentlyEnded === true
              ? Date.now() - RECENTLY_ENDED_HOURS * 60 * 60 * 1000
              : null;
          const rows = await ownRows(allEnded || endedSince !== null);
          // Filter first, so a schedule is read only for a task that is listed.
          const listed = rows
            .filter((task) => !wanted || task.status?.status === wanted)
            .filter((task) => !onlyHere || task.conciergeChat.id === here)
            // An ended task counts as recent by when it ended, else when it last changed.
            .filter(
              (task) =>
                endedSince === null ||
                task.status?.status !== "ended" ||
                (task.row.endedAt ?? task.row.updatedAt).getTime() >= endedSince,
            );
          const schedules = await Promise.all(
            listed.map((task) => service.deps.schedules?.of(task.row.id) ?? null),
          );
          const taskChats = listed
            .map((task, index) =>
              compactTask(task, task.status, args.details === true, schedules[index]),
            )
            .map((task) =>
              onConnection ? { ...task, link: linkOf(task.title, task.chatId) } : task,
            )
            .sort((a, b) => a.chatId.localeCompare(b.chatId));
          const conciergeChats =
            wanted || onlyHere
              ? []
              : onConnection
                ? await everyChat(here)
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
      name: "card_forward",
      description:
        "Send the guardian one card a task chat showed, as it is, by its id: Rome copies the card, so you pass no content. The id is the `id` of a `card id=…` line in a task event, or the `cardId` of a message chat_read shows. Where this chat cannot show cards, the card's plain-text line goes instead. " +
        "A task's question card or approval goes as the card itself: the guardian answers or decides it here or in the task chat, and both show the one outcome. Only the guardian's tap on the card decides an approval, and a vault approval still asks for their PIN there; you never decide one. An approval already decided, or one this chat cannot show as a card, is refused and nothing is sent. " +
        "To send several cards, call it once for each: every card is a message of its own. Any card of a task chat started from this Concierge chat can go, from any turn. " +
        "An id that names no such card is refused and nothing is sent: then tell the result yourself with say, replying to the task's start message. " +
        "The message replies to the task's start message and leaves it where it is, so several cards all reply to the same one.",
      inputSchema: {
        type: "object",
        required: ["cardId"],
        properties: { cardId: { type: "string" } },
      },
      handler: (input) =>
        runTool("card_forward", input, async (args) => {
          const cardId = requireString(args, "cardId");
          currentTurn();
          const found = await messages.cardIn(cardId);
          const holder = found ? await webchatRepo.getSession(found.chatId) : undefined;
          // A task's question card or approval goes as itself: the same card,
          // answered or decided wherever it is.
          if (!found) {
            const question = await questionCardIn(cardId);
            if (question) {
              const chat = await requireOwnTaskChat(question.chatId);
              const waitedOn = {
                kind: "question" as const,
                id: question.toolUseId,
                messageId: cardId,
              };
              const messageId = await forwardAsk(
                question.chatId,
                waitedOn,
                cardId,
                chat.name,
                question.line,
              );
              return { forwarded: context.widgets === "card" ? "card" : "card_text", messageId };
            }
            const approval = await approvalIn(cardId);
            if (approval) {
              const chat = await requireOwnTaskChat(approval.chatId);
              if (!approval.pending) {
                throw new Error(
                  `Approval ${cardId} is already decided. Nothing was sent; its outcome reaches you as a task event.`,
                );
              }
              // Nothing here writes the approval: only the guardian's tap on the card decides it.
              if (context.widgets !== "card") {
                throw new Error(
                  "This chat cannot show cards, so the approval stays in its task chat. Nothing was sent. Say once, in one short line with the task's link, what it asks to do and that they decide it in the task chat.",
                );
              }
              const messageId = await forwardAsk(
                approval.chatId,
                { kind: "approval", id: cardId },
                cardId,
                chat.name,
                approval.line,
              );
              return { forwarded: "card", messageId };
            }
          }
          // Everything that can refuse comes before anything is said.
          if (!found || holder?.triggerKind !== TASK_CHAT_TRIGGER_KIND) {
            throw new Error(
              `No card ${cardId} in a task chat. Pass the id of a \`card id=…\` line from a task event, or a cardId from chat_read. Nothing was sent. To tell the result yourself, use say, replying to the task's start message: pass its start_message_id from chat_list as replyTo.`,
            );
          }
          const chat = await requireOwnTaskChat(found.chatId);
          const messageId = await forwardCard(found.card, cardId, {
            chatId: found.chatId,
            title: chat.name,
          });
          return { forwarded: context.widgets === "card" ? "card" : "card_text", messageId };
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
          // An agent may name a service as the guardian reads it: "slack" for
          // the entry labelled Slack, whose service is slack_app. Only a label
          // one service carries names it.
          const named = connectors.filter(
            (entry) => entry.label.toLowerCase() === wanted.toLowerCase(),
          );
          const connector =
            connectors.find((entry) => entry.service === wanted) ??
            (named.length === 1 ? named[0] : undefined);
          if (!connector) {
            throw new Error(
              named.length > 0
                ? `No service ${wanted}. Services labelled ${named[0].label}: ${named
                    .map((entry) => `${entry.service} (${entry.state ?? "not connected"})`)
                    .join(", ")}. Pass one of those.`
                : `No service ${wanted}. Use core:concierge_following_list for the service names.`,
            );
          }
          if (connector.state === "working") {
            return { connected: true, note: "Already connected; no card shown." };
          }
          const id = await service.addCard(chatId, turnId, {
            type: "connect_card",
            service: connector.service,
            label: connector.label,
            icon: connector.icon,
            // A service with no entry can only be connected from Settings.
            connect: connector.connect ?? { kind: "dashboard" },
          });
          said(chatId, turnId, `Connect ${connector.label}`);
          return { sent: "Shown; the guardian sees the card.", messageId: id };
        }),
    },
    {
      name: SHOW_CARD_TOOL,
      description: showCardDescription("say the content with `say`"),
      inputSchema: SHOW_CARD_INPUT_SCHEMA,
      handler: (input, call) =>
        runTool(SHOW_CARD_TOOL, input, async (args) => {
          const { chatId, turnId } = currentTurn();
          if (context.widgets !== "card") {
            throw new Error(
              "This chat cannot show cards. Nothing was shown: say the content with say instead.",
            );
          }
          const card = agentCardPart(args.ui, args.text, call?.toolUseId ?? `card-${randomUUID()}`);
          if ("problems" in card) {
            throw new Error(
              `The card was not shown: ${card.problems.join("; ")}. Fix it and call show_card once more, or say the content with say instead.`,
            );
          }
          const { id } = await webchatRepo.addBackendMessage(chatId, turnId, [card.part]);
          said(chatId, turnId, card.part.text);
          await settleAnswered(undefined, undefined);
          return {
            sent: "Shown; the guardian sees the card. Send nothing that repeats it: at most one short line that adds what the card does not hold, or nothing.",
            messageId: id,
          };
        }),
    },
  ];
  if (!onConnection) return tools;
  return tools.filter((tool) => (CONNECTION_TOOLS as readonly string[]).includes(tool.name));
}
