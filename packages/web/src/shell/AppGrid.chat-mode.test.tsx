// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { LAST_CHAT_KEY, MODE_KEY, seedChatListMode } from "@/test/chat-list-mode";
import i18n from "@/i18n";
import { AppGrid, STORAGE_KEY } from "./AppGrid";

const SESSIONS_KEY = ["chat-sessions", "active", "mine"];

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  rs.stubGlobal(
    "fetch",
    rs.fn(async () => new Response(JSON.stringify({ apps: [], upgradable: [] }))),
  );
  localStorage.setItem(STORAGE_KEY, JSON.stringify([]));
});

afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
  localStorage.clear();
  seedChatListMode();
});

function chatTile(sessions?: Array<{ id: string }>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (sessions) queryClient.setQueryData(SESSIONS_KEY, sessions);
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/settings"]}>
        <AppGrid />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return screen.getByRole("link", { name: "Chat" });
}

describe("the rail's Chat entry", () => {
  it("opens the main chat in Concierge mode, as before the switch", () => {
    seedChatListMode({ mode: "concierge", lastChat: "mine" });
    expect(chatTile().getAttribute("href")).toBe("/message");
  });

  it("opens the main chat on a device that has not shown a mode", () => {
    expect(chatTile().getAttribute("href")).toBe("/message");
  });

  it("opens the last ordinary chat in Chat mode", () => {
    seedChatListMode({ mode: "chat", lastChat: "mine" });
    expect(chatTile().getAttribute("href")).toBe("/chat/mine");
  });

  it("opens a blank chat in Chat mode when there is no last chat", () => {
    seedChatListMode({ mode: "chat" });
    expect(chatTile().getAttribute("href")).toBe("/chat");
  });

  it("opens a blank chat once the last chat is gone from the lists this tab has", () => {
    seedChatListMode({ mode: "chat", lastChat: "deleted" });
    expect(chatTile([{ id: "other" }]).getAttribute("href")).toBe("/chat");
  });

  it("keeps the last chat while the lists still hold it", () => {
    seedChatListMode({ mode: "chat", lastChat: "mine" });
    expect(chatTile([{ id: "mine" }]).getAttribute("href")).toBe("/chat/mine");
  });
});
