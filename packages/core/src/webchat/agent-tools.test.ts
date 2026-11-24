import { describe, expect, it, rs } from "@rstest/core";
import {
  approvalOf,
  callTool,
  GUARDIAN_TURN,
  whoMayAskSuite,
} from "../apps/actions/agent-tool-contract.js";
import {
  type ChatPage,
  type ChatPageAnswer,
  type ChatToolDeps,
  changeChat,
  type ListedChat,
  startChat,
} from "./agent-tools.js";

whoMayAskSuite(startChat, {});
whoMayAskSuite(changeChat, { name: "Taxes" });
whoMayAskSuite(changeChat, { delete: true });

// A chat as the page's routes answer it, with the fields the agent does not get.
const chat = (fields: Record<string, unknown> = {}): ChatPageAnswer => ({
  status: 200,
  body: {
    id: "chat-1",
    name: "New chat",
    personaId: null,
    largeModelSelection: null,
    followsDefault: true,
    projectName: "default",
    projectPath: "default",
    deviceFolder: null,
    agentName: null,
    archivedAt: null,
    pinnedAt: null,
    createdAt: "2026-11-24T00:00:00.000Z",
    unread: false,
    messageCount: 0,
    ...fields,
  },
});
const refused = (status: number, error: string): ChatPageAnswer => ({ status, body: { error } });

// The guardian's chats as the page lists them, latest activity first.
const listed: ListedChat[] = [
  { id: "c-taxes", name: "Taxes", activityAt: "2026-11-24T09:00:00.000Z" },
  { id: "c-lisbon", name: "Trip to Lisbon", activityAt: "2026-11-23T09:00:00.000Z" },
  { id: "c-groceries", name: "Groceries", activityAt: "2026-11-22T09:00:00.000Z" },
  { id: "c-plan-1", name: "Plan", activityAt: "2026-11-21T09:00:00.000Z" },
  { id: "c-plan-2", name: "plan ", activityAt: "2026-11-20T09:00:00.000Z" },
  { id: "c-recipes", name: "Recipes", activityAt: "2026-11-19T09:00:00.000Z" },
  { id: "c-porto", name: "Trip to Porto", activityAt: "2026-11-18T09:00:00.000Z" },
  { id: "c-books", name: "Books", activityAt: "2026-11-17T09:00:00.000Z" },
];

function chatPage(overrides: Partial<ChatPage> = {}) {
  const page = {
    startChat: rs.fn(async () => chat()),
    sendAsGuardian: rs.fn(async () => {}),
    renameChat: rs.fn(async (_id: string, name: string) => chat({ name })),
    pinChat: rs.fn(async () => chat({ pinnedAt: "2026-11-24T01:00:00.000Z" })),
    archiveChat: rs.fn(async (_id: string, archived: boolean) =>
      chat({ archivedAt: archived ? "2026-11-24T01:00:00.000Z" : null }),
    ),
    pickChatModel: rs.fn(async (_id: string, model: string) =>
      chat({ largeModelSelection: model }),
    ),
    setChatProject: rs.fn(async (_id: string, projectPath: string) => chat({ projectPath })),
    deleteChat: rs.fn(async () => ({ status: 200, body: { ok: true } })),
    chatName: rs.fn(async () => "Trip plan"),
    listChats: rs.fn(async (): Promise<ListedChat[]> => listed),
  };
  // The defaults stay typed as mocks; a test reads the mock of none it overrides.
  Object.assign(page, overrides);
  const deps: ChatToolDeps = { page: () => page };
  return { page, deps };
}

describe("starting a chat", () => {
  it("starts it through the page's New chat, and answers its id and link", async () => {
    const { page, deps } = chatPage();

    const result = await callTool(startChat, deps, {
      agent: "coder",
      project: "website",
      model: "claude-sonnet",
    });

    expect(page.startChat).toHaveBeenCalledWith({
      agentName: "coder",
      projectPath: "website",
      largeModelSelection: "claude-sonnet",
    });
    expect(result).toEqual({
      status: "ok",
      data: {
        chatId: "chat-1",
        name: "New chat",
        agent: "main",
        project: "default",
        pinned: false,
        archived: false,
        model: "auto",
        link: "/chat/chat-1",
        firstMessageSent: false,
      },
    });
  });

  it("works in a folder on one of the guardian's computers", async () => {
    const { page, deps } = chatPage();

    await callTool(startChat, deps, { folder: { deviceId: "mac", path: "/code" } });

    expect(page.startChat).toHaveBeenCalledWith({
      deviceFolder: { deviceId: "mac", path: "/code" },
    });
  });

  it("sends the first message as the guardian's own, then names the chat", async () => {
    const { page, deps } = chatPage();

    const result = await callTool(startChat, deps, {
      name: "Trip",
      firstMessage: "Plan a week in Kyoto",
    });

    expect(page.sendAsGuardian).toHaveBeenCalledWith("chat-1", "Plan a week in Kyoto");
    expect(page.renameChat).toHaveBeenCalledWith("chat-1", "Trip");
    expect(page.sendAsGuardian.mock.invocationCallOrder[0]).toBeLessThan(
      page.renameChat.mock.invocationCallOrder[0] ?? 0,
    );
    expect(result).toMatchObject({ status: "ok", data: { firstMessageSent: true } });
  });

  it("says the chat started when its first message could not be sent", async () => {
    const { deps } = chatPage({
      sendAsGuardian: rs.fn(async () => {
        throw new Error("Session is busy");
      }),
    });

    const result = await callTool(startChat, deps, { firstMessage: "Hi" });

    expect(result).toEqual({
      status: "error",
      error: expect.stringContaining("Chat chat-1 started, but its first message was not sent"),
    });
  });

  it("answers the page's refusal, and starts nothing", async () => {
    const { page, deps } = chatPage({
      startChat: rs.fn(async () => refused(400, 'Agent "nope" not found')),
    });

    const result = await callTool(startChat, deps, { agent: "nope", firstMessage: "Hi" });

    expect(result).toEqual({
      status: "error",
      error: 'Agent "nope" not found. Nothing was started; tell the guardian why.',
    });
    expect(page.sendAsGuardian).not.toHaveBeenCalled();
  });

  it("refuses a model the page does not offer", async () => {
    const { page, deps } = chatPage();

    const result = await callTool(startChat, deps, { model: "gpt-1" });

    expect(result).toMatchObject({ status: "error" });
    expect(page.startChat).not.toHaveBeenCalled();
  });
});

describe("changing a chat", () => {
  it("changes the chat the guardian is talking in when none is named", async () => {
    const { page, deps } = chatPage();

    const result = await callTool(changeChat, deps, { name: "Taxes" });

    expect(page.renameChat).toHaveBeenCalledWith(GUARDIAN_TURN.channelContext?.threadId, "Taxes");
    expect(result).toMatchObject({ status: "ok", data: { chatId: "chat-1", name: "Taxes" } });
  });

  it("makes each change through the page's own operation, archiving last", async () => {
    const { page, deps } = chatPage();

    const result = await callTool(changeChat, deps, {
      chatId: "chat-1",
      archived: true,
      pinned: true,
      model: "auto",
      project: "website",
      name: "Taxes",
    });

    expect(page.renameChat).toHaveBeenCalledWith("chat-1", "Taxes");
    expect(page.pinChat).toHaveBeenCalledWith("chat-1", true);
    expect(page.pickChatModel).toHaveBeenCalledWith("chat-1", "auto");
    expect(page.setChatProject).toHaveBeenCalledWith("chat-1", "website");
    expect(page.archiveChat).toHaveBeenCalledWith("chat-1", true);
    const archivedAt = page.archiveChat.mock.invocationCallOrder[0] ?? 0;
    for (const op of [page.renameChat, page.pinChat, page.pickChatModel, page.setChatProject]) {
      expect(op.mock.invocationCallOrder[0]).toBeLessThan(archivedAt);
    }
    expect(result).toMatchObject({ status: "ok", data: { archived: true } });
  });

  it("brings a chat back before renaming it", async () => {
    const { page, deps } = chatPage();

    await callTool(changeChat, deps, { chatId: "chat-1", archived: false, name: "Taxes" });

    expect(page.archiveChat).toHaveBeenCalledWith("chat-1", false);
    expect(page.archiveChat.mock.invocationCallOrder[0]).toBeLessThan(
      page.renameChat.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("answers what the page turns down, and says what was already changed", async () => {
    const { deps } = chatPage({
      pickChatModel: rs.fn(async () => refused(409, "The model selector is turned off")),
    });

    const result = await callTool(changeChat, deps, {
      chatId: "chat-1",
      name: "Taxes",
      model: "auto",
    });

    expect(result).toEqual({
      status: "error",
      error:
        "The model selector is turned off. The changes before it were made. Tell the guardian why.",
    });
  });

  it("says when no chat has the id", async () => {
    const { deps } = chatPage({ pinChat: rs.fn(async () => refused(404, "Session not found")) });

    const result = await callTool(changeChat, deps, { chatId: "gone", pinned: true });

    expect(result).toEqual({
      status: "error",
      error: expect.stringContaining('No chat found with id "gone"'),
    });
  });

  it("asks for a change when none is passed", async () => {
    const { deps } = chatPage();

    expect(await callTool(changeChat, deps, { chatId: "chat-1" })).toEqual({
      status: "error",
      error: "Nothing to change: pass name, pinned, archived, model, project or delete.",
    });
  });

  it("asks for the chat's id in a turn outside a dashboard chat", async () => {
    const { page, deps } = chatPage();

    // A tool reads the chat from its turn, not its deps, so a turn on a
    // connection has no chat to default to.
    const turn = { ...GUARDIAN_TURN, channelContext: { channel: "slack", threadId: "C1" } };
    const result = await callTool(changeChat, deps, { name: "Taxes" }, turn);

    expect(result).toMatchObject({ status: "error", error: expect.stringContaining("chatId") });
    expect(page.renameChat).not.toHaveBeenCalled();
  });

  it("says so while the dashboard is not up", async () => {
    const deps: ChatToolDeps = { page: () => null };

    expect(await callTool(changeChat, deps, { name: "Taxes" })).toMatchObject({
      status: "error",
      error: expect.stringContaining("not up yet"),
    });
  });
});

describe("naming a chat", () => {
  it("changes the one chat with the name, whatever its case and the spaces around it", async () => {
    const { page, deps } = chatPage();

    const result = await callTool(changeChat, deps, {
      chatName: "  trip TO lisbon ",
      pinned: true,
    });

    expect(page.pinChat).toHaveBeenCalledWith("c-lisbon", true);
    expect(result).toMatchObject({ status: "ok" });
  });

  it("names the closest chats, then the most recent, when no chat has the name", async () => {
    const { page, deps } = chatPage();

    const result = await callTool(changeChat, deps, { chatName: "Trip", name: "Holiday" });

    expect(result).toEqual({
      status: "error",
      error:
        'No chat is named "Trip", so nothing was changed. The chats with the closest names, then the most recent: "Trip to Lisbon", "Trip to Porto", "Taxes", "Groceries", "Plan". Ask the guardian which chat they mean.',
    });
    expect(page.renameChat).not.toHaveBeenCalled();
  });

  it("lists every chat with the name, and changes none, when several have it", async () => {
    const { page, deps } = chatPage();

    const result = await callTool(changeChat, deps, { chatName: "plan", archived: true });

    expect(result).toEqual({
      status: "error",
      error:
        '2 chats are named "plan", so nothing was changed: "Plan" (last active 2026-11-21T09:00:00.000Z, id c-plan-1); "plan " (last active 2026-11-20T09:00:00.000Z, id c-plan-2). Ask the guardian which one they mean, then pass its chatId.',
    });
    expect(page.archiveChat).not.toHaveBeenCalled();
  });

  it("takes the id when the id and the name agree, even among chats of one name", async () => {
    const { page, deps } = chatPage();

    await callTool(changeChat, deps, { chatId: "c-plan-2", chatName: "Plan", pinned: true });

    expect(page.pinChat).toHaveBeenCalledWith("c-plan-2", true);
  });

  it("changes nothing when the id and the name are of different chats", async () => {
    const { page, deps } = chatPage();

    const result = await callTool(changeChat, deps, {
      chatId: "c-taxes",
      chatName: "Trip to Lisbon",
      pinned: true,
    });

    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining('The chat with id "c-taxes" is not named "Trip to Lisbon"'),
    });
    expect(page.pinChat).not.toHaveBeenCalled();
  });

  it("finds no chat the page does not list", async () => {
    const { page, deps } = chatPage();

    // The page lists only chats the guardian may open, so another person's
    // Concierge chat is not among them, whatever its name.
    const result = await callTool(changeChat, deps, { chatName: "Concierge", delete: true });

    expect(result).toMatchObject({ status: "error", error: expect.stringContaining("No chat") });
    expect(page.deleteChat).not.toHaveBeenCalled();
  });
});

describe("deleting a chat", () => {
  it("is approved on a card that names the chat its name found", async () => {
    const { deps } = chatPage();

    expect(
      await approvalOf(changeChat, deps, { chatName: "trip to lisbon", delete: true }),
    ).toEqual({
      kind: "generic",
      title: 'Delete the chat "Trip to Lisbon"',
      summary: "Deletes the chat and all its messages. This cannot be undone.",
    });
  });

  it("shows no card, and does not run, for a name that finds no one chat", async () => {
    const { deps } = chatPage();

    for (const chatName of ["Trip", "Plan"]) {
      await expect(approvalOf(changeChat, deps, { chatName, delete: true })).rejects.toThrow(
        "so nothing was changed",
      );
    }
  });

  it("deletes the chat its name found through the page's delete", async () => {
    const { page, deps } = chatPage();

    const result = await callTool(changeChat, deps, { chatName: "Groceries", delete: true });

    expect(page.deleteChat).toHaveBeenCalledWith("c-groceries");
    expect(result).toMatchObject({ status: "ok", data: { chatId: "c-groceries", deleted: true } });
  });

  it("is approved by the guardian on a card that names the chat", async () => {
    const { deps } = chatPage();

    expect(await approvalOf(changeChat, deps, { chatId: "chat-1", delete: true })).toEqual({
      kind: "generic",
      title: 'Delete the chat "Trip plan"',
      summary: "Deletes the chat and all its messages. This cannot be undone.",
    });
  });

  it("asks no approval for any other change", async () => {
    const { deps } = chatPage();

    for (const input of [
      { chatId: "chat-1", name: "Taxes" },
      { chatId: "chat-1", pinned: true, archived: true, model: "auto" },
      { chatId: "chat-1", delete: false, project: "website" },
    ]) {
      expect(await approvalOf(changeChat, deps, input)).toBeUndefined();
    }
  });

  it("deletes it through the page's delete", async () => {
    const { page, deps } = chatPage();

    const result = await callTool(changeChat, deps, { chatId: "chat-1", delete: true });

    expect(page.deleteChat).toHaveBeenCalledWith("chat-1");
    expect(result).toEqual({
      status: "ok",
      data: { chatId: "chat-1", name: "Trip plan", deleted: true },
    });
  });

  it("answers what the page turns down", async () => {
    const { deps } = chatPage({
      deleteChat: rs.fn(async () => refused(409, "The main Concierge chat cannot be deleted")),
    });

    expect(await callTool(changeChat, deps, { delete: true })).toEqual({
      status: "error",
      error:
        "The main Concierge chat cannot be deleted. Nothing was deleted; tell the guardian why.",
    });
  });

  it("takes no other change with a delete, and does nothing", async () => {
    const { page, deps } = chatPage();

    const result = await callTool(changeChat, deps, { chatId: "chat-1", delete: true, name: "X" });

    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("takes no other change"),
    });
    expect(page.deleteChat).not.toHaveBeenCalled();
    expect(page.renameChat).not.toHaveBeenCalled();
  });
});
