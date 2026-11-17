// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import type { InitialEntry } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { readChatListMode, readLastOrdinaryChatId, writeChatListMode } from "@/lib/chat-list-mode";
import { LAST_CHAT_KEY, MODE_KEY, seedChatListMode } from "@/test/chat-list-mode";
import "@/i18n";
import * as conciergeModule from "@/hooks/use-concierge" with { rstest: "importActual" };

// The chat list is not mounted: the shell alone keeps the mode with the open chat.
rs.mock("@/hooks/use-concierge", () => ({
  ...conciergeModule,
  useConciergeChat: () => ({ chatId: "concierge", loading: false, failed: false, retry: () => {} }),
}));
rs.mock("./RecentChats", () => ({ RecentChats: () => null }));
rs.mock("./AppGrid", () => ({ AppGrid: () => null }));
rs.mock("./DesktopTitlebar", () => ({ DesktopTitlebar: () => null }));
rs.mock("./ProfileMenu", () => ({ ProfileMenu: () => null }));
rs.mock("./use-chat-peek", () => ({
  useChatPeek: () => ({ tile: undefined, open: false, onEnter: () => {}, onLeave: () => {} }),
}));
rs.mock("../components/upgrade-countdown-banner", () => ({ UpgradeCountdownBanner: () => null }));
rs.mock("./UpgradeIndicator", () => ({ UpgradeIndicator: () => null }));
rs.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({ data: {} }),
  useInvalidateSettings: () => () => Promise.resolve(),
}));
rs.mock("@/hooks/use-desktop", () => ({ useDesktop: () => false }));

import { SlotProvider } from "../components/slot";
import { RomeShellLayout } from "./RomeShellLayout";

const CONCIERGE_AGENT = "core:concierge";
// What the server answers for each chat id, as `GET /api/chat/sessions/:id`.
const sessions: Record<string, Record<string, unknown>> = {
  topic: { id: "topic", agentName: CONCIERGE_AGENT },
  task: { id: "task", triggerKind: "concierge" },
  mine: { id: "mine" },
  fork: { id: "fork", parentSessionId: "mine" },
};
let fetched: string[] = [];

beforeEach(() => {
  fetched = [];
  rs.stubGlobal(
    "matchMedia",
    rs.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: rs.fn(),
      removeEventListener: rs.fn(),
    })),
  );
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    const id = url.match(/^\/api\/chat\/sessions\/([^/?]+)$/)?.[1];
    if (id && sessions[id]) return Response.json(sessions[id]);
    return new Response("not found", { status: 404 });
  }) as typeof fetch);
});
afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
  rs.unstubAllGlobals();
  localStorage.clear();
  seedChatListMode();
});

let go: (to: InitialEntry | number) => void = () => {};
function Navigator() {
  const navigate = useNavigate();
  go = (to) =>
    typeof to === "number"
      ? navigate(to)
      : typeof to === "string"
        ? navigate(to)
        : navigate(to.pathname ?? "/", { state: to.state });
  return null;
}

function openShell(entry: InitialEntry, queryClient = new QueryClient()) {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <SlotProvider>
          <Routes>
            <Route element={<RomeShellLayout />}>
              <Route path="*" element={<Navigator />} />
            </Route>
          </Routes>
        </SlotProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("the shell keeps the chat list's mode with the open chat", () => {
  const cases: Array<[string, InitialEntry, "chat" | "concierge", string | null]> = [
    ["the main chat", "/message", "concierge", null],
    ["the main chat by its id", "/chat/concierge", "concierge", null],
    [
      "a blank topic chat",
      { pathname: "/chat", state: { conciergeTopic: true } },
      "concierge",
      null,
    ],
    ["a blank chat", "/chat", "chat", null],
    ["a topic chat", "/chat/topic", "concierge", null],
    ["a task chat", "/chat/task", "concierge", null],
    ["a common chat", "/chat/mine", "chat", "mine"],
    ["a fork chat", "/chat/fork", "chat", "fork"],
  ];
  it.each(
    cases,
  )("opening %s from another page, with no chat list loaded", async (_, entry, mode, last) => {
    // The other mode, so the navigation has to move it.
    seedChatListMode({ mode: mode === "chat" ? "concierge" : "chat" });
    openShell("/apps");
    act(() => go(entry));
    await waitFor(() => expect(localStorage.getItem(MODE_KEY)).toBe(mode));
    expect(readChatListMode()).toBe(mode);
    expect(readLastOrdinaryChatId()).toBe(last);
  });

  it("keeps the stored mode on a refresh, whatever chat it reopens", async () => {
    for (const entry of ["/message", "/chat/task", "/chat/topic"]) {
      seedChatListMode({ mode: "chat" });
      openShell(entry);
      await act(async () => {});
      expect(readChatListMode()).toBe("chat");
      cleanup();
    }
    seedChatListMode({ mode: "concierge" });
    openShell("/chat/mine");
    await act(async () => {});
    expect(readChatListMode()).toBe("concierge");
  });

  it("starts in Chat on a device with none stored, on a refresh at the main chat too", async () => {
    openShell("/message");
    await act(async () => {});
    expect(readChatListMode()).toBeNull();
  });

  it("moves from Chat to Agent when a navigation goes into the Concierge", async () => {
    seedChatListMode({ mode: "chat" });
    openShell("/chat/mine");
    await act(async () => {});
    expect(readChatListMode()).toBe("chat");
    act(() => go("/message"));
    await waitFor(() => expect(readChatListMode()).toBe("concierge"));
    expect(localStorage.getItem(MODE_KEY)).toBe("concierge");
  });

  it("resolves a cold navigation through the chat's own session, and no other request", async () => {
    seedChatListMode({ mode: "chat" });
    openShell("/apps");
    act(() => go("/chat/task"));
    expect(readChatListMode()).toBe("chat");
    await waitFor(() => expect(readChatListMode()).toBe("concierge"));
    expect(fetched).toEqual(["/api/chat/sessions/task"]);
  });

  it("remembers the last ordinary chat from a refresh, and not a Concierge chat", async () => {
    openShell("/chat/mine");
    await waitFor(() => expect(localStorage.getItem(LAST_CHAT_KEY)).toBe("mine"));
    act(() => go("/chat/topic"));
    await waitFor(() => expect(readChatListMode()).toBe("concierge"));
    expect(localStorage.getItem(LAST_CHAT_KEY)).toBe("mine");
  });

  it("asks nothing for a chat a loaded chat list holds", async () => {
    seedChatListMode({ mode: "chat" });
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      ["chat-sessions", "active", "mine"],
      [{ id: "listed-task", triggerKind: "concierge" }],
    );
    openShell("/apps", queryClient);
    act(() => go("/chat/listed-task"));
    await waitFor(() => expect(readChatListMode()).toBe("concierge"));
    expect(fetched).toEqual([]);
  });

  it("asks nothing for a topic chat the Concierge's chat list holds", async () => {
    seedChatListMode({ mode: "chat" });
    const queryClient = new QueryClient();
    queryClient.setQueryData(["concierge-chats"], {
      chats: [{ id: "listed-topic", name: "Calendar", main: false, unread: 0 }],
    });
    openShell("/apps", queryClient);
    act(() => go("/chat/listed-topic"));
    await waitFor(() => expect(readChatListMode()).toBe("concierge"));
    expect(fetched).toEqual([]);
  });

  it("keeps the mode when the open chat does not exist", async () => {
    seedChatListMode({ mode: "chat" });
    openShell("/apps");
    act(() => go("/chat/missing"));
    await waitFor(() => expect(fetched).toEqual(["/api/chat/sessions/missing"]));
    await act(async () => {});
    expect(readChatListMode()).toBe("chat");
  });

  it("applies a navigation once: a switch made on the page stands", async () => {
    seedChatListMode({ mode: "chat" });
    openShell("/chat/mine");
    await act(async () => {});
    act(() => writeChatListMode("concierge"));
    await act(async () => {});
    expect(readChatListMode()).toBe("concierge");

    act(() => go("/chat/task"));
    await waitFor(() => expect(readChatListMode()).toBe("concierge"));
    act(() => go("/chat/fork"));
    await waitFor(() => expect(readChatListMode()).toBe("chat"));
  });

  it("applies the open chat's mode again when Back returns to it from another page", async () => {
    seedChatListMode({ mode: "chat" });
    openShell("/chat/mine");
    await act(async () => {});
    act(() => writeChatListMode("concierge"));
    act(() => go("/apps"));
    await act(async () => {});
    // The other page leaves the mode as the guardian set it.
    expect(readChatListMode()).toBe("concierge");

    act(() => go(-1));
    await waitFor(() => expect(readChatListMode()).toBe("chat"));
  });

  it("does not read another tab's change", async () => {
    seedChatListMode({ mode: "chat" });
    openShell("/chat/mine");
    await waitFor(() => expect(readChatListMode()).toBe("chat"));
    localStorage.setItem(MODE_KEY, "concierge");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: MODE_KEY, newValue: "concierge" }));
    });
    await act(async () => {});
    expect(readChatListMode()).toBe("chat");
  });
});
