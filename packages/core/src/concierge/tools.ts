// Concierge's facade tools: `say` is its only way to speak, and the `chat_*`
// tools run its task chats.

import type { ForwardedFrom } from "@rome/api-types/chat";
import {
  CONCIERGE_TASK_STATES,
  CONCIERGE_TASK_SUMMARY_MAX_LENGTH,
  type ConciergeTaskState,
} from "@rome/api-types/concierge";
import type { SaidMessage } from "../chats/message.js";
import type { SendResult } from "../chats/send.js";
import type {
  ConciergeTaskWithChat,
  ConciergeTaskWrite,
} from "../db/repositories/concierge-tasks.js";
import {
  CONVERSATION_TITLE_MAX_LENGTH,
  conversationTitleLength,
} from "../core/conversation-title.js";
import type { FacadeToolDef } from "../core/mcp-facade.js";
import { runFacadeTool } from "../core/mcp-facade.js";
import type { SessionToolContext } from "../core/session-tools.js";
import { createLogger } from "../logger.js";
import { getWebchatProjectsRoot, resolveAgentProjectPath } from "../webchat/projects.js";
import {
  CONCIERGE_ACCOUNT,
  type ConciergeService,
  isConciergeAgent,
  TASK_CHAT_TRIGGER_KIND,
} from "./service.js";
import { hasText, latestSaid, MAX_READ_LIMIT, taskChatPlace } from "./task-chat.js";

const log = createLogger("concierge-tools");

const TASK_STATUSES = ["running", "idle", "waiting_input"] as const;
type TaskStatus = (typeof TASK_STATUSES)[number];
const DEFAULT_READ_LIMIT = 6;

function requireString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function statusOf(running: boolean, chat: { awaitingGuardian: boolean } | undefined): TaskStatus {
  if (running) return "running";
  return chat?.awaitingGuardian ? "waiting_input" : "idle";
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
 * Concierge's or the setting is off. Each handler acts on the session's
 * running turn and fails when none runs.
 */
export async function buildConciergeTools(
  service: ConciergeService,
  context: SessionToolContext,
): Promise<FacadeToolDef[]> {
  if (!isConciergeAgent(context.agentName) || context.isSubagent) return [];
  if (!(await service.isEnabled())) return [];
  const { webchatRepo, messages, tasks } = service.deps;

  const currentTurn = (): { chatId: string; turnId: string } => {
    const turnId = context.getTurnId();
    const thread = context.getThreadContext();
    if (!turnId || thread?.channel !== "webchat" || !thread.threadId) {
      throw new Error("This tool works only during a turn in the Concierge chat");
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

  const requireTaskChat = async (chatId: string) => {
    const chat = await webchatRepo.getSession(chatId);
    if (!chat || chat.triggerKind !== TASK_CHAT_TRIGGER_KIND) {
      throw new Error(`No task chat ${chatId}. Use chat_list to find your task chats.`);
    }
    return chat;
  };

  // Said as Concierge's account, so the task event reads who asked off the
  // message.
  const sendInput = async (chatId: string, text: string) => {
    const sent = await service.dashboard.send(taskChatPlace(chatId), { text }, CONCIERGE_ACCOUNT);
    if (!sent.ok) throw new Error(refusal(sent));
  };

  // A task chat always has a row. One from before the todo list gets its row
  // when the Concierge next works with it.
  const ensureTaskRow = async (chat: { id: string; name: string; triggerName?: string | null }) => {
    if (await tasks.repo.findBySession(chat.id)) return;
    await tasks.repo.upsertMany([
      { title: chat.triggerName ?? chat.name, state: "doing", sessionId: chat.id },
    ]);
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
    if (raw.id !== undefined) write.id = requireString(raw, "id");
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
    if (!write.id) {
      if (!write.title) throw new Error(`${where}.title is required to create a row`);
      write.state ??= write.sessionId ? "doing" : "next";
    }
    return write;
  };

  const findListEntry = async (chatId: string) =>
    (await webchatRepo.listSessions("all")).find((chat) => chat.id === chatId);

  const say = async (text: string, format: "bubble" | "long") => {
    const { chatId, turnId } = currentTurn();
    await webchatRepo.addBackendMessage(chatId, turnId, [
      { type: "text", content: text, ...(format === "long" ? { format } : {}) },
    ]);
  };

  // One message, so the lead-in and the report always arrive together. The
  // transcript still shows them as two bubbles.
  const forward = async (text: string, from: ForwardedFrom, intro?: string) => {
    const { chatId, turnId } = currentTurn();
    await webchatRepo.addBackendMessage(chatId, turnId, [
      ...(intro ? [{ type: "text" as const, content: intro }] : []),
      { type: "text", content: text, format: "long", forwardedFrom: from },
    ]);
  };

  // A card that opens the task chat; it reads the chat's live status itself.
  const showCard = async (chatId: string, title: string) => {
    const { chatId: conciergeChatId, turnId } = currentTurn();
    await webchatRepo.addBackendMessage(conciergeChatId, turnId, [
      { type: "task_chat", chatId, title },
    ]);
  };

  return [
    {
      name: "say",
      description:
        "Send the guardian one message. This is the only way the guardian hears you: text you write outside this tool is private. " +
        "One call is one message. Use format bubble (default) for a short chat line, and long for one long message with content the guardian asked for.",
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
        },
      },
      handler: (input) =>
        runFacadeTool("say", input, async (args) => {
          await say(requireString(args, "text"), args.format === "long" ? "long" : "bubble");
          return "Sent; the guardian sees it. Call say again only for a new message.";
        }),
    },
    {
      name: "task_upsert",
      description:
        "Write your task list, the guardian's panel of what you are busy with. Batch only: one call writes every row that changed. " +
        "An entry without id creates a row (title required); an entry with id updates it, and fields you leave out stay. " +
        "Returns each row's id.",
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
              },
            },
          },
        },
      },
      handler: (input) =>
        runFacadeTool("task_upsert", input, async (args) => {
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
          return { tasks: rows.map((row) => ({ id: row.id, title: row.title, state: row.state })) };
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
        runFacadeTool("task_list", input, async (args) => ({
          tasks: (await tasks.repo.listForAgent(args.includeDone === true)).map(compactTask),
        })),
    },
    {
      name: "chat_start",
      description:
        "Start a task chat: a normal chat with another agent (main by default) that does the work while you keep talking. " +
        "Its result comes back to you in a <task_events> batch. Every task chat has a row on your task list: this call creates one (or links taskId). Returns the chat's id and the row's id.",
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
          card: {
            type: "boolean",
            description:
              "Also show the guardian a card that opens the task chat. The task runs either way. Decide by complexity: on for complex or long-running work they may want to watch, such as code, a PR, or research across many sources; off for a simple task that will finish quickly.",
          },
        },
      },
      handler: (input) =>
        runFacadeTool("chat_start", input, async (args) => {
          currentTurn();
          const title = requireString(args, "title");
          const brief = requireString(args, "brief");
          const taskId = optionalString(args, "taskId");
          if (taskId) {
            const planned = await tasks.repo.get(taskId);
            if (!planned) throw new Error(`No task ${taskId}. Use task_list to find it.`);
            if (planned.sessionId) {
              throw new Error(
                `Task ${taskId} already has chat ${planned.sessionId}. Use chat_send to continue it.`,
              );
            }
          }
          const chatId = await service.dashboard.chats.startChat({
            agentName: optionalString(args, "agent"),
            projectPath: await taskProjectPath(optionalString(args, "project")),
          });
          // Marked before the first turn, so that turn's event already sees it.
          await webchatRepo.setSessionTrigger(chatId, {
            triggerKind: TASK_CHAT_TRIGGER_KIND,
            triggerName: title,
          });
          // Linked before the first turn, so that turn's events find the row.
          const [task] = await tasks.repo.upsertMany([
            taskId
              ? { id: taskId, sessionId: chatId, state: "doing", waitingOn: null }
              : { title, state: "doing", sessionId: chatId },
          ]);
          await sendInput(chatId, brief);
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
        },
      },
      handler: (input) =>
        runFacadeTool("chat_send", input, async (args) => {
          currentTurn();
          const chatId = requireString(args, "chatId");
          const chat = await requireTaskChat(chatId);
          await ensureTaskRow(chat);
          await sendInput(chatId, requireString(args, "text"));
          return "Sent; the task chat takes it as input.";
        }),
    },
    {
      name: "chat_read",
      description:
        "Read a task chat's status (running, idle, or waiting_input) and its latest messages.",
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
        runFacadeTool("chat_read", input, async (args) => {
          const chatId = requireString(args, "chatId");
          const chat = await requireTaskChat(chatId);
          const limit =
            typeof args.last === "number"
              ? Math.min(MAX_READ_LIMIT, Math.max(1, Math.floor(args.last)))
              : DEFAULT_READ_LIMIT;
          const said = await latestSaid(messages, taskChatPlace(chatId), limit, hasText);
          return {
            chatId,
            title: chat.name,
            status: statusOf(
              service.dashboard.chats.isRunning(chatId),
              await findListEntry(chatId),
            ),
            messages: said.map((message) => ({
              role: message.direction === "fromRome" ? "assistant" : "user",
              text: message.body.text,
              at: message.at.toISOString(),
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
        runFacadeTool("chat_stop", input, async (args) => {
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
      description: "List the task chats you started, newest first, with their status.",
      inputSchema: {
        type: "object",
        properties: { status: { type: "string", enum: [...TASK_STATUSES] } },
      },
      handler: (input) =>
        runFacadeTool("chat_list", input, async (args) => {
          const wanted = TASK_STATUSES.find((status) => status === args.status);
          const { chats } = service.dashboard;
          return (await webchatRepo.listSessions("all"))
            .filter((chat) => chat.triggerKind === TASK_CHAT_TRIGGER_KIND && !chat.archivedAt)
            .map((chat) => ({
              chatId: chat.id,
              title: chat.name,
              status: statusOf(chats.isRunning(chat.id), chat),
            }))
            .filter((chat) => !wanted || chat.status === wanted);
        }),
    },
    {
      name: "chat_forward",
      description:
        "Send the guardian a task chat's latest answer as one long message, word for word, without retyping it. " +
        "Use it for long content the guardian asked for.",
      inputSchema: {
        type: "object",
        required: ["chatId"],
        properties: {
          chatId: { type: "string" },
          intro: { type: "string", description: "Optional short line sent before it." },
        },
      },
      handler: (input) =>
        runFacadeTool("chat_forward", input, async (args) => {
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
          await forward(answer, { chatId, title: chat.name }, optionalString(args, "intro"));
          return { forwardedChars: answer.length };
        }),
    },
    {
      name: "chat_card",
      description:
        "Show the guardian a card that opens a task chat and shows its live status. " +
        "Use it when they want to open or find a task chat, instead of sending its id.",
      inputSchema: {
        type: "object",
        required: ["chatId"],
        properties: { chatId: { type: "string" } },
      },
      handler: (input) =>
        runFacadeTool("chat_card", input, async (args) => {
          const chatId = requireString(args, "chatId");
          const chat = await requireTaskChat(chatId);
          await showCard(chatId, chat.name);
          return "Shown; the guardian sees the card.";
        }),
    },
  ];
}
