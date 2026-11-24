// What agents do on the Chat page: start a chat, and change or delete one.
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
  /** Every chat the guardian may open, archived ones included, as the page's
   * sidebar lists them (`GET /chat/sessions?status=all`): latest activity first. */
  listChats(): Promise<ListedChat[]>;
}

/** What the tools read of a chat in the page's list. `activityAt` is an ISO time. */
export interface ListedChat {
  id: string;
  name: string;
  activityAt: string;
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
    "The chat's id, such as one system:start_chat returned. Leave it and chatName out for the chat you are talking in.",
  );

const chatName = z
  .string()
  .optional()
  .describe(
    'The name of the chat to change, as the guardian says it, such as "Trip to Lisbon", when you do not have its id. Case and spaces around it do not matter, and archived chats count.',
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
    if (started.status >= 400)
      return toolError(`${errorOf(started)}. Nothing was started; tell the guardian why.`);
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
    'Change a chat on the dashboard, as its menu does: rename it, pin or unpin it, archive or unarchive it, pick the model it runs on, move a chat with no message yet to another project, or delete it. Use it when the guardian asks, such as "rename this chat to Taxes", "pin this chat", "archive the chat you started", "delete this chat" or "delete my chat called Trip to Lisbon". Name the chat by its id, by its name, or neither for the chat you are talking in. When no chat or several have the name, it changes nothing and answers names to ask the guardian about. Pass only what changes. A chat\'s agent stays the one it started with. Deleting removes the chat and all its messages for good and takes no other change; the guardian approves it on a card first. To keep a chat out of the list instead, archive it. Only in the guardian\'s private chat, in a turn their own message started',
  sideEffects: "write",
  input: z.object({
    chatId,
    chatName,
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
    delete: z
      .boolean()
      .optional()
      .describe(
        "true to delete the chat and all its messages for good, only when the guardian asks to delete it. Pass no other change with it.",
      ),
  }),
  // Only a delete is approved. A delete that finds no one chat throws, so it
  // shows no card and does not run.
  approval: async (input, { deps, turn }) => {
    if (input.delete !== true) return undefined;
    const page = deps.page();
    if (!page) throw new Error(NOT_UP);
    const found = await findChat(page, input, turn);
    if ("error" in found) throw new Error(found.error);
    const name = found.name ?? (await page.chatName(found.id));
    return {
      title: name ? `Delete the chat "${name}"` : "Delete a chat",
      summary: "Deletes the chat and all its messages. This cannot be undone.",
    };
  },
  run: async (input, { deps, turn }) => {
    const page = deps.page();
    if (!page) return toolError(NOT_UP);
    const found = await findChat(page, input, turn);
    if ("error" in found) return toolError(found.error);
    const id = found.id;
    const { name, pinned, archived, model, project } = input;
    if (input.delete === true) {
      const others = [name, pinned, archived, model, project].some((v) => v !== undefined);
      if (others) {
        return toolError(
          "Deleting a chat takes no other change, so nothing was done. Delete it alone, or change it without delete.",
        );
      }
      return deleteChat(page, id);
    }
    const changes: Array<() => Promise<ChatPageAnswer>> = [];
    // Unarchived first and archived last, as an archived chat is not renamed.
    if (archived === false) changes.push(() => page.archiveChat(id, false));
    if (name !== undefined) changes.push(() => page.renameChat(id, name));
    if (pinned !== undefined) changes.push(() => page.pinChat(id, pinned));
    if (model !== undefined) changes.push(() => page.pickChatModel(id, model));
    if (project !== undefined) changes.push(() => page.setChatProject(id, project));
    if (archived === true) changes.push(() => page.archiveChat(id, true));
    if (changes.length === 0) {
      return toolError("Nothing to change: pass name, pinned, archived, model, project or delete.");
    }
    let last: ChatPageAnswer | null = null;
    for (const change of changes) {
      const answer = await change();
      if (answer.status === 404) return toolError(notFound(id));
      if (answer.status >= 400) {
        const done = last ? " The changes before it were made." : "";
        return toolError(`${errorOf(answer)}.${done} Tell the guardian why.`);
      }
      last = answer;
    }
    return last ? view(last.body) : toolError(notFound(id));
  },
});

async function deleteChat(page: ChatPage, id: string) {
  const name = await page.chatName(id);
  const deleted = await page.deleteChat(id);
  if (deleted.status === 404) return toolError(notFound(id));
  if (deleted.status >= 400)
    return toolError(`${errorOf(deleted)}. Nothing was deleted; tell the guardian why.`);
  return { chatId: id, name, deleted: true };
}

/** The Chat page's agent tools. */
export const chatTools = [startChat, changeChat];

const NO_CHAT =
  "Pass the chat's id as chatId or its name as chatName: this turn is not in a dashboard chat to default to.";

/** How many chat names an error offers the agent to ask the guardian about. */
const NAMES_OFFERED = 5;

/** The chat a call names: by chatId, by chatName among the chats the page
 * lists, else the dashboard chat the turn runs in. `name` is set when the
 * chat was found by its name. */
async function findChat(
  page: ChatPage,
  named: { chatId?: string; chatName?: string },
  turn: ToolTurn,
): Promise<{ id: string; name?: string } | { error: string }> {
  const id = named.chatId?.trim();
  const wanted = named.chatName?.trim();
  if (!wanted) {
    const chat = id || turnChat(turn);
    return chat ? { id: chat } : { error: NO_CHAT };
  }
  const chats = await page.listChats();
  const matches = chats.filter((chat) => sameName(chat.name, wanted));
  if (id) {
    const agreed = matches.find((chat) => chat.id === id);
    if (agreed) return { id, name: agreed.name };
    return {
      error: `The chat with id "${id}" is not named "${wanted}", so nothing was changed. Ask the guardian which chat they mean, and pass only its chatId or its chatName.`,
    };
  }
  const [first] = matches;
  if (first && matches.length === 1) return { id: first.id, name: first.name };
  if (first) {
    const listed = matches
      .map((chat) => `"${chat.name}" (last active ${chat.activityAt}, id ${chat.id})`)
      .join("; ");
    return {
      error: `${matches.length} chats are named "${wanted}", so nothing was changed: ${listed}. Ask the guardian which one they mean, then pass its chatId.`,
    };
  }
  const offered = closestNames(chats, wanted).map((name) => `"${name}"`);
  const offer = offered.length
    ? ` The chats with the closest names, then the most recent: ${offered.join(", ")}.`
    : " The guardian has no chats.";
  return {
    error: `No chat is named "${wanted}", so nothing was changed.${offer} Ask the guardian which chat they mean.`,
  };
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Up to NAMES_OFFERED names: those holding `wanted` or held in it first, then
 * those sharing a word with it, each group in the list's order, latest first. */
function closestNames(chats: ListedChat[], wanted: string): string[] {
  const key = wanted.toLowerCase();
  const words = new Set(key.split(/\s+/));
  const nearness = (name: string) => {
    const own = name.trim().toLowerCase();
    if (own && (own.includes(key) || key.includes(own))) return 0;
    return own.split(/\s+/).some((word) => words.has(word)) ? 1 : 2;
  };
  return chats
    .map((chat, order) => ({ name: chat.name, near: nearness(chat.name), order }))
    .sort((a, b) => a.near - b.near || a.order - b.order)
    .slice(0, NAMES_OFFERED)
    .map((chat) => chat.name);
}

/** The dashboard chat the turn runs in, or null outside one. */
function turnChat(turn: ToolTurn): string | null {
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
  return `No chat found with id "${id}". Ask the guardian which chat they mean, then pass its name as chatName, or leave chatId out for this chat.`;
}
