// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { InitialEntry } from "react-router-dom";
import { MODE_KEY, seedChatListMode } from "@/test/chat-list-mode";
import i18n from "@/i18n";
import * as conciergeModule from "@/hooks/use-concierge" with { rstest: "importActual" };
import { RecentChats } from "./RecentChats";

const concierge = rs.hoisted(() => ({
  chatId: "concierge" as string | null,
  chats: [] as Array<{ id: string; name: string; main: boolean; unread: number }>,
}));
rs.mock("@/hooks/use-concierge", () => ({
  ...conciergeModule,
  useConciergeChatId: () => concierge.chatId,
  useConciergeChats: () => concierge.chats,
}));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  seedChatListMode();
  rs.restoreAllMocks();
  rs.unstubAllGlobals();
  concierge.chatId = "concierge";
  concierge.chats = [];
});

interface Row {
  id: string;
  name: string;
  activityAt?: string;
  running?: boolean;
  agentName?: string;
  triggerKind?: string;
  parentSessionId?: string;
}

const CONCIERGE_AGENT = "core:concierge";

function chat(id: string, name: string, extra: Partial<Row> = {}): Row {
  return { id, name, ...extra };
}
const mainChat = () => chat("concierge", "Concierge", { agentName: CONCIERGE_AGENT });
const topic = (id: string, name: string) => chat(id, name, { agentName: CONCIERGE_AGENT });
const task = (id: string, name: string, extra: Partial<Row> = {}) =>
  chat(id, name, { triggerKind: "concierge", ...extra });

function serve(rows: Row[], settings: Record<string, unknown> = {}) {
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/settings") return Response.json(settings);
    if (url.startsWith("/api/chat/sessions")) {
      return Response.json(
        rows.map((row) => ({
          createdAt: "2026-07-01T00:00:00.000Z",
          activityAt: "2026-07-02T00:00:00.000Z",
          lastSeenActivityAt: null,
          unread: false,
          projectName: "default",
          projectPath: "default",
          ...row,
        })),
      );
    }
    if (url === "/api/concierge/session") return Response.json({ id: "concierge", unread: 0 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch);
}

function Probe() {
  const location = useLocation();
  return (
    <>
      <output data-testid="path">{location.pathname}</output>
      <output data-testid="state">{JSON.stringify(location.state)}</output>
    </>
  );
}

function open(entry: InitialEntry) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={[entry]}>
        <RecentChats />
        <Probe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Not "New chat in this project", which a project row offers.
const NEW_CHAT = /^New chat(?! in )/;
const radio = (name: string) => screen.getByRole("radio", { name: new RegExp(`^${name}`) });
const stored = () => localStorage.getItem(MODE_KEY);

describe("the Chat / Concierge switch", () => {
  it("has an icon-only radio for each mode, with an accessible name and a tooltip text", async () => {
    serve([chat("mine", "My chat")]);
    open("/chat/mine");
    await screen.findByRole("link", { name: "My chat" });
    const group = screen.getByRole("radiogroup", { name: "Chat list mode" });
    const [first, second] = within(group).getAllByRole("radio");
    expect([first.textContent, second.textContent]).toEqual(["Chat", "Concierge"]);
    expect(first.getAttribute("aria-checked")).toBe("true");
    expect(first.querySelector("svg")).toBeTruthy();
    expect(second.querySelector("svg")).toBeTruthy();
  });

  it("is absent without a Concierge, and the list keeps task chats under their project", async () => {
    concierge.chatId = null;
    serve([task("task-1", "Find flights"), chat("mine", "My chat")]);
    open("/chat/mine");
    await screen.findByRole("link", { name: "My chat" });
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByRole("link", { name: /Find flights/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: NEW_CHAT }).getAttribute("href")).toBe("/chat");
    expect(screen.queryByRole("link", { name: "New topic" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Projects" })).toBeTruthy();
    expect(screen.getByText("Chats")).toBeTruthy();
  });

  describe("which mode shows", () => {
    it("starts on Chat for someone with an ordinary chat, and remembers it", async () => {
      serve([mainChat(), chat("mine", "My chat")]);
      open("/chat/unlisted");
      await screen.findByRole("link", { name: "My chat" });
      expect(radio("Chat").getAttribute("aria-checked")).toBe("true");
      await waitFor(() => expect(stored()).toBe("chat"));
    });

    it("starts on Concierge for someone with only Concierge chats, and remembers it", async () => {
      serve([mainChat(), topic("topic-1", "Calendar"), task("task-1", "Find flights")]);
      concierge.chats = [
        { id: "concierge", name: "Concierge", main: true, unread: 0 },
        { id: "topic-1", name: "Calendar", main: false, unread: 0 },
      ];
      open("/chat/unlisted");
      await screen.findByRole("link", { name: "Main chat" });
      expect(radio("Concierge").getAttribute("aria-checked")).toBe("true");
      await waitFor(() => expect(stored()).toBe("concierge"));
    });

    it("uses the stored mode over the chats it has", async () => {
      seedChatListMode({ mode: "concierge" });
      serve([mainChat(), chat("mine", "My chat")]);
      open("/chat/unlisted");
      await screen.findByRole("link", { name: "Main chat" });
      expect(screen.queryByRole("link", { name: "My chat" })).toBeNull();
    });

    it("follows a click on the other segment, and keeps it", async () => {
      seedChatListMode({ mode: "chat" });
      serve([mainChat(), chat("mine", "My chat")]);
      const user = userEvent.setup();
      open("/chat/mine");
      await screen.findByRole("link", { name: "My chat" });
      await user.click(radio("Concierge"));
      await screen.findByRole("link", { name: "Main chat" });
      expect(screen.queryByRole("link", { name: "My chat" })).toBeNull();
      expect(stored()).toBe("concierge");
      // The open chat is an ordinary one, and a switch is not a navigation.
      expect(screen.getByTestId("path").textContent).toBe("/chat/mine");
    });
  });

  describe("the guardian's own switch", () => {
    it("holds when the list mounts again on the same page, as the collapse toggle, the peek and the phone list do", async () => {
      seedChatListMode({ mode: "chat" });
      serve([mainChat(), chat("mine", "My chat")]);
      const user = userEvent.setup();
      const first = open("/chat/mine");
      await screen.findByRole("link", { name: "My chat" });
      await user.click(radio("Concierge"));
      await screen.findByRole("link", { name: "Main chat" });
      first.unmount();

      open("/chat/mine");
      await screen.findByRole("link", { name: "Main chat" });
      expect(radio("Concierge").getAttribute("aria-checked")).toBe("true");
      expect(screen.queryByRole("link", { name: "My chat" })).toBeNull();
    });

    it("does not follow the page itself: the shell owns that", async () => {
      seedChatListMode({ mode: "concierge" });
      serve([mainChat(), chat("mine", "My chat")]);
      open("/chat/mine");
      await screen.findByRole("link", { name: "Main chat" });
      expect(stored()).toBe("concierge");
    });

    it("stays on this tab's mode when another tab changes the stored one", async () => {
      seedChatListMode({ mode: "chat" });
      serve([mainChat(), chat("mine", "My chat")]);
      open("/chat/mine");
      await screen.findByRole("link", { name: "My chat" });

      localStorage.setItem(MODE_KEY, "concierge");
      act(() => {
        window.dispatchEvent(new StorageEvent("storage", { key: MODE_KEY, newValue: "concierge" }));
      });
      await act(async () => {});
      expect(radio("Chat").getAttribute("aria-checked")).toBe("true");
      expect(screen.getByRole("link", { name: "My chat" })).toBeTruthy();
    });

    it("starts a new tab from the last stored mode", async () => {
      serve([mainChat(), chat("mine", "My chat")]);
      const user = userEvent.setup();
      seedChatListMode({ mode: "chat" });
      const view = open("/chat/mine");
      await screen.findByRole("link", { name: "My chat" });
      await user.click(radio("Concierge"));
      expect(stored()).toBe("concierge");
      view.unmount();

      // A page load reads the device's store again.
      seedChatListMode({ mode: localStorage.getItem(MODE_KEY) ?? undefined });
      open("/chat/unlisted");
      await screen.findByRole("link", { name: "Main chat" });
    });
  });
});

describe("Chat mode", () => {
  it("leads with a New chat row that opens a blank ordinary chat, then lists only common and fork chats", async () => {
    seedChatListMode({ mode: "chat" });
    serve([
      mainChat(),
      topic("topic-1", "Calendar"),
      task("task-1", "Find flights"),
      chat("mine", "My chat"),
      chat("fork-1", "A fork", { parentSessionId: "mine" }),
    ]);
    const user = userEvent.setup();
    open("/chat/mine");
    await screen.findByRole("link", { name: "My chat" });
    expect(screen.getByRole("link", { name: "A fork" })).toBeTruthy();
    for (const hidden of [/Find flights/, "Calendar", "Main chat"]) {
      expect(screen.queryByRole("link", { name: hidden })).toBeNull();
    }
    expect(screen.queryByRole("region", { name: /^Tasks/ })).toBeNull();
    expect(document.querySelector("hr")).toBeNull();
    expect(screen.getByRole("heading", { name: "Projects" })).toBeTruthy();

    const row = screen.getByRole("link", { name: NEW_CHAT });
    expect(screen.getAllByRole("link")[0]).toBe(row);
    await user.click(row);
    expect(screen.getByTestId("path").textContent).toBe("/chat");
    expect(screen.getByTestId("state").textContent).toBe("null");
  });

  it("titles the list Chats", async () => {
    seedChatListMode({ mode: "chat" });
    serve([chat("mine", "My chat")]);
    open("/chat/mine");
    expect(await screen.findByText("Chats")).toBeTruthy();
  });

  it("shows the shortcut hint where there is a wide window and a fine pointer, and not on touch", async () => {
    seedChatListMode({ mode: "chat" });
    serve([chat("mine", "My chat")]);
    const stub = (...matching: string[]) =>
      rs.stubGlobal("matchMedia", (query: string) => ({
        matches: matching.includes(query),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }));
    stub("(min-width: 48rem)");
    const view = open("/chat/mine");
    await screen.findByRole("link", { name: "My chat" });
    expect(screen.getByRole("link", { name: NEW_CHAT }).querySelector("kbd")?.textContent).toMatch(
      /^(Ctrl|⌘) ⇧ O$/,
    );
    view.unmount();

    stub("(min-width: 48rem)", "(hover: none) and (pointer: coarse)");
    open("/chat/mine");
    await screen.findByRole("link", { name: "My chat" });
    expect(screen.getByRole("link", { name: NEW_CHAT }).querySelector("kbd")).toBeNull();
  });
});

describe("Concierge mode", () => {
  const topics = [
    { id: "concierge", name: "Concierge", main: true, unread: 0 },
    { id: "topic-1", name: "Calendar", main: false, unread: 0 },
  ];

  it("leads with a New topic row that opens a blank topic chat, then the main chat and the topic chats", async () => {
    seedChatListMode({ mode: "concierge" });
    concierge.chats = topics;
    serve([mainChat(), topic("topic-1", "Calendar"), chat("mine", "My chat")]);
    const user = userEvent.setup();
    open("/chat/unlisted");
    await screen.findByRole("link", { name: "Main chat" });
    const row = screen.getByRole("link", { name: "New topic" });
    const links = screen.getAllByRole("link");
    expect(links.slice(0, 3)).toEqual([
      row,
      screen.getByRole("link", { name: "Main chat" }),
      screen.getByRole("link", { name: "Calendar" }),
    ]);
    // The row replaced the plus that used to sit beside the main chat.
    expect(screen.queryByRole("button", { name: /New topic/ })).toBeNull();
    expect(screen.queryByRole("region", { name: "Projects" })).toBeNull();
    expect(screen.queryByRole("link", { name: "My chat" })).toBeNull();

    await user.click(row);
    expect(screen.getByTestId("path").textContent).toBe("/chat");
    expect(screen.getByTestId("state").textContent).toBe('{"conciergeTopic":true}');
  });

  it("titles the list Concierge, not the name the guardian gave their agent", async () => {
    seedChatListMode({ mode: "concierge" });
    serve([mainChat()], { agentName: "Milo" });
    open("/chat/unlisted");
    await screen.findByRole("link", { name: "Main chat" });
    expect(document.querySelector(".text-section")?.textContent).toBe("Concierge");
    expect(screen.queryByText("Milo")).toBeNull();
  });

  describe("Tasks", () => {
    const at = (day: number) => new Date(Date.UTC(2026, 6, day)).toISOString();

    it("lists the task chats latest first, five of them and a More row for the rest", async () => {
      seedChatListMode({ mode: "concierge" });
      concierge.chats = topics;
      serve([
        mainChat(),
        ...[1, 2, 3, 4, 5, 6, 7].map((day) =>
          task(`t${day}`, `Task ${day}`, { activityAt: at(day) }),
        ),
        chat("mine", "My chat"),
      ]);
      const user = userEvent.setup();
      open("/chat/unlisted");
      const section = await screen.findByRole("region", { name: /^Tasks/ });
      const names = () =>
        within(section)
          .getAllByRole("link")
          .map((link) => link.textContent);
      expect(names()).toEqual(["Task 7", "Task 6", "Task 5", "Task 4", "Task 3"]);
      await user.click(within(section).getByRole("button", { name: "2 more" }));
      expect(names()).toHaveLength(7);
      expect(names().at(-1)).toBe("Task 1");
    });

    it("gives a task row the chat row's menu, and a status mark while it runs", async () => {
      seedChatListMode({ mode: "concierge" });
      concierge.chats = topics;
      serve([mainChat(), task("t1", "Find flights", { running: true })]);
      const user = userEvent.setup();
      open("/chat/unlisted");
      const link = await screen.findByRole("link", { name: /Find flights/ });
      const row = link.closest<HTMLElement>("[data-chat-row]") as HTMLElement;
      expect(within(row).getByRole("img", { name: "Replying now" })).toBeTruthy();
      await user.click(within(row).getByRole("button", { name: "Chat actions" }));
      expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
        "RenameR",
        "ArchiveA",
        "Delete",
      ]);
    });

    it("keeps the open task chat in view, even past the first five", async () => {
      seedChatListMode({ mode: "concierge" });
      concierge.chats = topics;
      serve([
        mainChat(),
        ...[1, 2, 3, 4, 5, 6, 7].map((day) =>
          task(`t${day}`, `Task ${day}`, { activityAt: at(day) }),
        ),
      ]);
      open("/chat/t1");
      const section = await screen.findByRole("region", { name: /^Tasks/ });
      await within(section).findByRole("link", { name: /^Task 1/ });
      expect(within(section).queryByRole("button", { name: /more/ })).toBeNull();
    });

    it("has no Tasks section, nor its separator, when there are no task chats", async () => {
      seedChatListMode({ mode: "concierge" });
      concierge.chats = topics;
      serve([mainChat(), chat("mine", "My chat")]);
      open("/chat/unlisted");
      await screen.findByRole("link", { name: "Main chat" });
      expect(screen.queryByRole("region", { name: /^Tasks/ })).toBeNull();
      expect(document.querySelector("hr")).toBeNull();
    });

    it("counts the running tasks beside the heading", async () => {
      seedChatListMode({ mode: "concierge" });
      concierge.chats = topics;
      serve([
        mainChat(),
        task("t1", "One", { running: true }),
        task("t2", "Two", { running: true }),
        task("t3", "Three"),
      ]);
      open("/chat/unlisted");
      const section = await screen.findByRole("region", { name: /^Tasks/ });
      expect(within(section).getByText("2 running")).toBeTruthy();
    });
  });
});

describe("the dots on the switch", () => {
  const unreadChats = (main: number, topicUnread: number) => [
    { id: "concierge", name: "Concierge", main: true, unread: main },
    { id: "topic-1", name: "Calendar", main: false, unread: topicUnread },
  ];

  it("puts a red dot on Concierge in Chat mode while a Concierge chat has unread messages", async () => {
    seedChatListMode({ mode: "chat" });
    for (const [main, topicUnread] of [
      [2, 0],
      [0, 3],
    ]) {
      concierge.chats = unreadChats(main, topicUnread);
      serve([chat("mine", "My chat")]);
      const view = open("/chat/mine");
      await screen.findByRole("link", { name: "My chat" });
      const dot = within(radio("Concierge")).getByRole("img", {
        name: "Unread Concierge messages",
      });
      expect(dot.className).toContain("bg-destructive");
      view.unmount();
    }
  });

  it("shows no dot when nothing is unread, nor on the Chat segment", async () => {
    seedChatListMode({ mode: "chat" });
    concierge.chats = unreadChats(0, 0);
    serve([chat("mine", "My chat", { running: true })]);
    open("/chat/mine");
    await screen.findByRole("link", { name: "My chat" });
    expect(screen.queryAllByRole("img", { name: /Unread Concierge|replying/ })).toEqual([]);
  });

  it("puts a primary dot on Chat in Concierge mode while an ordinary chat is replying", async () => {
    seedChatListMode({ mode: "concierge" });
    concierge.chats = unreadChats(0, 0);
    serve([mainChat(), chat("mine", "My chat", { running: true })]);
    open("/chat/unlisted");
    await screen.findByRole("link", { name: "Main chat" });
    const dot = await within(radio("Chat")).findByRole("img", { name: "A chat is replying" });
    expect(dot.className).toContain("bg-primary");
    // Concierge's own unread dot belongs to the other mode.
    expect(screen.queryByRole("img", { name: "Unread Concierge messages" })).toBeNull();
  });

  it("ignores a task chat or a topic chat that is replying", async () => {
    seedChatListMode({ mode: "concierge" });
    concierge.chats = unreadChats(0, 0);
    serve([
      mainChat(),
      { ...topic("topic-1", "Calendar"), running: true },
      task("t1", "Find flights", { running: true }),
      chat("mine", "My chat"),
    ]);
    open("/chat/unlisted");
    await screen.findByRole("link", { name: "Main chat" });
    await act(async () => {});
    expect(screen.queryByRole("img", { name: "A chat is replying" })).toBeNull();
  });
});
