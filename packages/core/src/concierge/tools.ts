// Concierge's facade tools: `say` is its only way to speak, and the `chat_*`
// tools run its task chats.

import type { ChatId } from "@rome-os/app-runtime";
import type { SaidMessage } from "../chats/message.js";
import { chatKey, placeIn, type Place } from "../chats/place.js";
import { WEBCHAT_CHANNEL } from "../channels/webchat-channel.js";
import { DASHBOARD_PLATFORM, type SendResult } from "../chats/send.js";
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

const log = createLogger("concierge-tools");

const TASK_STATUSES = ["running", "idle", "waiting_input"] as const;
type TaskStatus = (typeof TASK_STATUSES)[number];
const DEFAULT_READ_LIMIT = 6;
const MAX_READ_LIMIT = 30;

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

/** A task chat is a direct message on the dashboard, read through its channel. */
const DASHBOARD = { channel: WEBCHAT_CHANNEL };

function taskChatPlace(chatId: string): Place {
  return placeIn(chatKey(DASHBOARD_PLATFORM, chatId as ChatId));
}

function refusal(result: Exclude<SendResult, { ok: true }>): string {
  if ("error" in result) return result.error;
  if ("invalid" in result) return result.invalid;
  return `The task chat cannot take a message (${result.send})`;
}

const hasText = (message: SaidMessage) => message.body.text.trim() !== "";

/** The newest `limit` messages of a place that `keep` keeps, oldest first,
 *  paging back past the rest, such as messages that carry only cards. */
async function latestSaid(
  messages: ConciergeService["deps"]["messages"],
  place: Place,
  limit: number,
  keep: (message: SaidMessage) => boolean,
): Promise<SaidMessage[]> {
  const pageSize = Math.max(limit, MAX_READ_LIMIT);
  const found: SaidMessage[] = [];
  let page = await messages.recent(place, pageSize, DASHBOARD);
  for (;;) {
    found.unshift(...page.messages.filter(keep));
    if (found.length >= limit || !page.older) return found.slice(-limit);
    page = await messages.before(place, page.older, pageSize, DASHBOARD);
  }
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
  const { webchatRepo, messages } = service.deps;

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

  const findListEntry = async (chatId: string) =>
    (await webchatRepo.listSessions("all")).find((chat) => chat.id === chatId);

  const say = async (text: string, format: "bubble" | "long") => {
    const { chatId, turnId } = currentTurn();
    await webchatRepo.addBackendMessage(chatId, turnId, [
      { type: "text", content: text, ...(format === "long" ? { format } : {}) },
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
      name: "chat_start",
      description:
        "Start a task chat: a normal chat with another agent (main by default) that does the work while you keep talking. " +
        "Its result comes back to you as a <task_event>. Returns the chat's id.",
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
          const chatId = await service.dashboard.chats.startChat({
            agentName: optionalString(args, "agent"),
            projectPath: await taskProjectPath(optionalString(args, "project")),
          });
          // Marked before the first turn, so that turn's event already sees it.
          await webchatRepo.setSessionTrigger(chatId, {
            triggerKind: TASK_CHAT_TRIGGER_KIND,
            triggerName: title,
          });
          await sendInput(chatId, brief);
          // Named after the first turn: the first message would rename it.
          if (conversationTitleLength(title) <= CONVERSATION_TITLE_MAX_LENGTH) {
            await webchatRepo.updateSessionName(chatId, title);
          } else {
            log.warn("task chat title too long to name the chat", { chatId });
          }
          if (args.card === true) await showCard(chatId, title);
          return { chatId };
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
          await requireTaskChat(chatId);
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
          await requireTaskChat(chatId);
          const [latest] = await latestSaid(
            messages,
            taskChatPlace(chatId),
            1,
            (message) => message.direction === "fromRome" && hasText(message),
          );
          const answer = latest?.body.text ?? null;
          if (!answer) throw new Error("The task chat has no answer yet");
          const intro = optionalString(args, "intro");
          if (intro) await say(intro, "bubble");
          await say(answer, "long");
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
