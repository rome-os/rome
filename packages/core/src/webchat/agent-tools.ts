// What agents do on the Chat page: start a chat, change one, and delete one.
// Each tool runs the page's own operation, which its route runs too
// (api/routes/webchat.ts). How a tool is declared:
// docs/concepts/actions.md#core-agent-tools.

import { z } from "zod";
import { agentToolsOf, type ToolTurn, toolError } from "../apps/actions/agent-tool.js";
import { MODEL_SELECTIONS } from "../agent/index.js";

/** A Chat page operation's answer, as its route gives it: the chat as the page
 * shows it, or `{ error }` with a status of 400 or more. */
export interface ChatPageAnswer {
  status: number;
  body: Record<string, unknown>;
}

/** A chat to start, as the page's New chat takes it. */
export interface NewChat {
  name?: string;
  agentName?: string;
  projectPath?: string;
  largeModelSelection?: string;
  deviceFolder?: { deviceId: string; path: string };
}

/** The Chat page's operations, for the guardian: a chat the guardian may not
 * open on the dashboard answers 404, as its route does. */
export interface ChatPage {
  /** Starts a chat for the guardian, as `POST /chat/sessions` does. */
  startChat(chat: NewChat): Promise<ChatPageAnswer>;
  /** Sends `text` into the chat as the guardian's own message, as their composer does. Throws the route's error. */
  sendAsGuardian(chatId: string, text: string): Promise<void>;
  renameChat(chatId: string, name: string): Promise<ChatPageAnswer>;
  pinChat(chatId: string, pinned: boolean): Promise<ChatPageAnswer>;
  archiveChat(chatId: string, archived: boolean): Promise<ChatPageAnswer>;
  /** Picks the model the chat runs on; "auto" leaves it to Rome. */
  pickChatModel(chatId: string, model: string): Promise<ChatPageAnswer>;
  /** Moves a chat that has no message yet to another project. */
  setChatProject(chatId: string, projectPath: string): Promise<ChatPageAnswer>;
  deleteChat(chatId: string): Promise<ChatPageAnswer>;
  /** The chat's name, or null for a chat the guardian may not open. */
  chatName(chatId: string): Promise<string | null>;
}

export interface ChatToolDeps {
  /** The Chat page, or null while the dashboard is not up. */
  page: () => ChatPage | null;
}

const agentTool = agentToolsOf<ChatToolDeps>();

const MODELS = ["auto", ...Object.keys(MODEL_SELECTIONS)] as [string, ...string[]];

const chatId = z
  .string()
  .optional()
  .describe(
    "The chat's id, such as one system:start_chat returned. Leave it out for the chat you are talking in.",
  );

const NOT_UP = "The dashboard is not up yet, so chats cannot be changed now. Tell the guardian.";

export const startChat = agentTool({
  name: "system:start_chat",
  description:
    'Start a new chat on the dashboard, as its New chat button does: with an agent, in a project or a folder on one of the guardian\'s computers, on a model, and with a first message if the guardian gives one. Use it when the guardian asks for a new chat, such as "open a new chat with the coder agent in the website project" or "start a chat and ask it to plan my trip". It answers the new chat\'s id and its link; give the guardian the link. Only in the guardian\'s private chat, in a turn their own message started',
  sideEffects: "write",
  input: z.object({
    name: z
      .string()
      .optional()
      .describe("The chat's name. Leave it out to have it named from its first message."),
    agent: z
      .string()
      .optional()
      .describe('The agent the chat is with, such as "main". Default main.'),
    project: z
      .string()
      .optional()
      .describe('The project the chat works in, such as "website". Default the default project.'),
    folder: z
      .object({
        deviceId: z.string().describe("The computer's id, from `rome-node device`."),
        path: z.string().describe("The folder's path on that computer."),
      })
      .optional()
      .describe("A folder on one of the guardian's computers to work in, instead of a project."),
    model: z
      .enum(MODELS)
      .optional()
      .describe('The model the chat runs on. Default "auto", which leaves it to Rome.'),
    firstMessage: z
      .string()
      .optional()
      .describe("A first message to send in the chat, as the guardian's own, in their words."),
  }),
  run: async (input, { deps }) => {
    const page = deps.page();
    if (!page) return toolError(NOT_UP);
    const name = input.name?.trim();
    const started = await page.startChat({
      ...(name ? { name } : {}),
      ...(input.agent?.trim() ? { agentName: input.agent.trim() } : {}),
      ...(input.project?.trim() ? { projectPath: input.project.trim() } : {}),
      ...(input.folder ? { deviceFolder: input.folder } : {}),
      ...(input.model ? { largeModelSelection: input.model } : {}),
    });
    if (started.status >= 400) return toolError(`${errorOf(started)}. Nothing was started.`);
    const id = String(started.body.id);
    const text = input.firstMessage?.trim();
    if (text) {
      try {
        await page.sendAsGuardian(id, text);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return toolError(
          `Chat ${id} started, but its first message was not sent: ${reason}. Give the guardian the link /chat/${id} to send it there.`,
        );
      }
      // The first message names the chat, so the guardian's name goes on after it.
      if (name) await page.renameChat(id, name);
    }
    return { ...view(started.body), link: `/chat/${id}`, firstMessageSent: Boolean(text) };
  },
});

export const changeChat = agentTool({
  name: "system:change_chat",
  description:
    'Change a chat on the dashboard, as its menu does: rename it, pin or unpin it, archive or unarchive it, pick the model it runs on, or move a chat with no message yet to another project. Use it when the guardian asks, such as "rename this chat to Taxes", "pin this chat" or "archive the chat you started". Pass only what changes. A chat\'s agent stays the one it started with. To delete a chat, use system:delete_chat. Only in the guardian\'s private chat, in a turn their own message started',
  sideEffects: "write",
  input: z.object({
    chatId,
    name: z.string().optional().describe("The chat's new name."),
    pinned: z
      .boolean()
      .optional()
      .describe("true to pin the chat at the top of the list, false to unpin it."),
    archived: z.boolean().optional().describe("true to archive the chat, false to bring it back."),
    model: z
      .enum(MODELS)
      .optional()
      .describe('The model the chat runs on from its next message. "auto" leaves it to Rome.'),
    project: z
      .string()
      .optional()
      .describe('The project a chat with no message yet works in, such as "website".'),
  }),
  run: async (input, { deps, turn }) => {
    const page = deps.page();
    if (!page) return toolError(NOT_UP);
    const id = chatOf(input.chatId, turn);
    if (!id) return toolError(NO_CHAT);
    const { name, pinned, archived, model, project } = input;
    const changes: Array<() => Promise<ChatPageAnswer>> = [];
    // Unarchived first and archived last, as an archived chat is not renamed.
    if (archived === false) changes.push(() => page.archiveChat(id, false));
    if (name !== undefined) changes.push(() => page.renameChat(id, name));
    if (pinned !== undefined) changes.push(() => page.pinChat(id, pinned));
    if (model !== undefined) changes.push(() => page.pickChatModel(id, model));
    if (project !== undefined) changes.push(() => page.setChatProject(id, project));
    if (archived === true) changes.push(() => page.archiveChat(id, true));
    if (changes.length === 0) {
      return toolError("Nothing to change: pass name, pinned, archived, model or project.");
    }
    let last: ChatPageAnswer | null = null;
    for (const change of changes) {
      const answer = await change();
      if (answer.status === 404) return toolError(notFound(id));
      if (answer.status >= 400) {
        const done = last ? " The changes before it were made." : "";
        return toolError(`${errorOf(answer)}.${done}`);
      }
      last = answer;
    }
    return last ? view(last.body) : toolError(notFound(id));
  },
});

export const deleteChat = agentTool({
  name: "system:delete_chat",
  description:
    'Delete a chat on the dashboard and all its messages, for good. Use it only when the guardian asks to delete a chat, such as "delete this chat"; to keep it out of the list instead, archive it with system:change_chat. The guardian approves the delete on a card first. Only in the guardian\'s private chat, in a turn their own message started',
  sideEffects: "write",
  input: z.object({ chatId }),
  approval: async (input, { deps, turn }) => {
    const id = chatOf(input.chatId, turn);
    const name = id ? await deps.page()?.chatName(id) : null;
    return {
      title: name ? `Delete the chat "${name}"` : "Delete a chat",
      summary: "Deletes the chat and all its messages. This cannot be undone.",
    };
  },
  run: async (input, { deps, turn }) => {
    const page = deps.page();
    if (!page) return toolError(NOT_UP);
    const id = chatOf(input.chatId, turn);
    if (!id) return toolError(NO_CHAT);
    const name = await page.chatName(id);
    const deleted = await page.deleteChat(id);
    if (deleted.status === 404) return toolError(notFound(id));
    if (deleted.status >= 400) return toolError(`${errorOf(deleted)}.`);
    return { chatId: id, name, deleted: true };
  },
});

/** The Chat page's agent tools. */
export const chatTools = [startChat, changeChat, deleteChat];

const NO_CHAT = "Pass the chat's id as chatId: this turn is not in a dashboard chat to default to.";

/** The chat a tool names, else the dashboard chat the turn runs in. */
function chatOf(named: string | undefined, turn: ToolTurn): string | null {
  const id = named?.trim();
  if (id) return id;
  const thread = turn.channelContext;
  return thread?.channel === "webchat" && thread.threadId ? thread.threadId : null;
}

/** What the agent needs of a chat the page answered. */
function view(chat: Record<string, unknown>) {
  return {
    chatId: chat.id,
    name: chat.name,
    ...("agentName" in chat ? { agent: chat.agentName ?? "main" } : {}),
    ...("projectPath" in chat ? { project: chat.projectPath } : {}),
    ...("pinnedAt" in chat ? { pinned: chat.pinnedAt !== null } : {}),
    ...("archivedAt" in chat ? { archived: chat.archivedAt !== null } : {}),
    ...("largeModelSelection" in chat ? { model: chat.largeModelSelection ?? "auto" } : {}),
  };
}

function errorOf(answer: ChatPageAnswer): string {
  const { error } = answer.body;
  return typeof error === "string" && error ? error : `The dashboard answered ${answer.status}`;
}

function notFound(id: string): string {
  return `No chat found with id "${id}". Ask the guardian which chat they mean, or leave chatId out for this chat.`;
}
