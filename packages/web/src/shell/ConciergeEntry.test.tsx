// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import * as conciergeModule from "@/hooks/use-concierge" with { rstest: "importActual" };
import type { ChatSession } from "@/lib/chat-types";
import { ConciergeChats } from "./ConciergeEntry";

const state = rs.hoisted(() => ({
  chats: [] as Array<{ id: string; name: string; main: boolean; unread: number }>,
  refresh: rs.fn(),
}));
rs.mock("@/hooks/use-concierge", () => ({
  ...conciergeModule,
  useConciergeChats: () => state.chats,
  useConciergeUnread: () => 0,
  useConciergeName: () => "Rome",
  useRefreshTopicChats: () => state.refresh,
  CONCIERGE_SESSION_QUERY_KEY: ["concierge-session"],
  CONCIERGE_UNREAD_CAP: 100,
}));
rs.mock("@/hooks/use-live-events", () => ({
  chatSessionTopic: (id: string) => id,
  useLiveEvents: () => {},
}));

const NOW = Date.parse("2026-11-22T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const OPEN_KEY = "rome-older-topic-chats-open";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
beforeEach(() => {
  rs.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  rs.restoreAllMocks();
  rs.unstubAllGlobals();
  state.chats = [];
});

function topic(id: string, days: number, extra: Partial<ChatSession> = {}): ChatSession {
  state.chats.push({ id, name: id, main: false, unread: 0 });
  return {
    id,
    name: id,
    activityAt: new Date(NOW - days * DAY).toISOString(),
    createdAt: new Date(NOW - 100 * DAY).toISOString(),
    pinnedAt: null,
    archivedAt: null,
    ...extra,
  } as ChatSession;
}

function mount(
  sessions: ChatSession[],
  active: string | null = null,
  status: "all" | "active" | "archived" = "active",
) {
  const queryClient = new QueryClient();
  const tree = (rows: ChatSession[]) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ConciergeChats
          mainChatId="main"
          activeSessionId={active}
          statusFilter={status}
          topicSessions={rows}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const result = render(tree(sessions));
  return { ...result, update: (rows: ChatSession[]) => result.rerender(tree(rows)) };
}

const ids = (root: ParentNode = document) =>
  [...root.querySelectorAll("[data-concierge-topic]")].map((row) =>
    row.getAttribute("data-concierge-topic"),
  );

describe("Older topic chats", () => {
  it("folds at seven days, not one millisecond before, and counts all older rows", async () => {
    const user = userEvent.setup();
    const sessions = [topic("boundary", 7), topic("recent", 7 - 1 / DAY), topic("oldest", 20)];
    mount(sessions);
    const toggle = screen.getByRole("button", { name: "Older · 2" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(ids()).toEqual(["recent"]);
    await user.click(toggle);
    expect(ids()).toEqual(["recent", "boundary", "oldest"]);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toBeTruthy();
  });

  it("remembers both expanded and collapsed states across remounts", async () => {
    const user = userEvent.setup();
    const sessions = [topic("old", 8)];
    const first = mount(sessions);
    await user.click(screen.getByRole("button", { name: "Older · 1" }));
    expect(localStorage.getItem(OPEN_KEY)).toBe("true");
    first.unmount();
    const second = mount(sessions);
    expect(screen.getByRole("link", { name: "old" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Older · 1" }));
    expect(localStorage.getItem(OPEN_KEY)).toBe("false");
    second.unmount();
    mount(sessions);
    expect(screen.queryByRole("link", { name: "old" })).toBeNull();
  });

  it("keeps pins, unread chats and only the open older chat outside the fold", async () => {
    const sessions = [
      topic("old", 30),
      topic("open", 40),
      topic("unread", 50),
      topic("pin", 60, { pinnedAt: new Date(NOW).toISOString() }),
    ];
    state.chats.find((chat) => chat.id === "unread")!.unread = 3;
    mount(sessions, "open");
    expect(ids()).toEqual(["pin", "open", "unread"]);
    expect(screen.getByRole("button", { name: "Older · 1" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(screen.queryByRole("link", { name: "old" })).toBeNull();
  });

  it("returns a read older chat to the fold when it is not open", () => {
    const old = topic("old", 8);
    state.chats = state.chats.map((chat) => ({ ...chat, unread: 1 }));
    const view = mount([old]);
    expect(ids()).toEqual(["old"]);
    state.chats = state.chats.map((chat) => ({ ...chat, unread: 0 }));
    view.update([old]);
    expect(ids()).toEqual([]);
    expect(screen.getByRole("button", { name: "Older · 1" })).toBeTruthy();
  });

  it("still toggles when browser storage is blocked", async () => {
    rs.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    rs.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    mount([topic("old", 8)]);
    const user = userEvent.setup();
    const toggle = screen.getByRole("button", { name: "Older · 1" });
    await user.click(toggle);
    expect(ids()).toEqual(["old"]);
    await user.click(toggle);
    expect(ids()).toEqual([]);
  });

  it("labels the group in Chinese and supports the keyboard", async () => {
    await i18n.changeLanguage("zh-CN");
    try {
      mount([topic("old", 8)]);
      const toggle = screen.getByRole("button", { name: "更早 · 1" });
      toggle.focus();
      const user = userEvent.setup();
      await user.keyboard("{Enter}");
      expect(ids()).toEqual(["old"]);
      await user.keyboard(" ");
      expect(ids()).toEqual([]);
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("keeps a chat with no session timestamp outside the fold", () => {
    state.chats.push({ id: "new", name: "new", main: false, unread: 0 });
    mount([]);
    expect(ids()).toEqual(["new"]);
    expect(screen.queryByRole("button", { name: /Older/ })).toBeNull();
  });

  it("pages recent and older rows independently without revealing intervening rows for the open chat", async () => {
    const observers: Array<{
      target?: Element;
      notify: (entries: Array<{ isIntersecting: boolean }>) => void;
    }> = [];
    rs.stubGlobal(
      "IntersectionObserver",
      class {
        item: (typeof observers)[number];
        constructor(notify: (entries: Array<{ isIntersecting: boolean }>) => void) {
          this.item = { notify };
          observers.push(this.item);
        }
        observe(target: Element) {
          this.item.target = target;
        }
        disconnect() {
          this.item.target = undefined;
        }
      },
    );
    const user = userEvent.setup();
    const sessions = [
      ...Array.from({ length: 65 }, (_, n) => topic(`recent-${n}`, n / 100)),
      ...Array.from({ length: 65 }, (_, n) => topic(`old-${n}`, 8 + n)),
    ];
    mount(sessions, "old-64");
    expect(ids()).toHaveLength(31);
    expect(ids()).toContain("old-64");
    expect(ids()).not.toContain("recent-30");
    expect(screen.getByRole("button", { name: "Older · 64" })).toBeTruthy();
    const reach = (selector: string) =>
      act(() => {
        const observer = observers.find((item) => item.target?.matches(selector));
        expect(observer).toBeTruthy();
        observer!.notify([{ isIntersecting: true }]);
      });
    reach("[data-topic-chats-end]");
    expect(ids()).toHaveLength(61);
    reach("[data-topic-chats-end]");
    expect(ids()).toHaveLength(66);
    await user.click(screen.getByRole("button", { name: "Older · 64" }));
    const group = document.getElementById(
      screen.getByRole("button", { name: "Older · 64" }).getAttribute("aria-controls")!,
    )!;
    expect(ids(group)).toHaveLength(30);
    reach("[data-older-topic-chats-end]");
    expect(ids(group)).toHaveLength(60);
    reach("[data-older-topic-chats-end]");
    expect(ids(group)).toHaveLength(64);
    expect(ids()).toHaveLength(130);
    expect(document.querySelector("[data-older-topic-chats-end]")).toBeNull();
  });

  it("moves a refreshed message above the fold but ignores running state", () => {
    const old = topic("old", 8);
    const other = topic("other", 9);
    const view = mount([old, other]);
    view.update([{ ...old, running: true }, other]);
    expect(ids()).toEqual([]);
    expect(screen.getByRole("button", { name: "Older · 2" })).toBeTruthy();
    view.update([{ ...old, activityAt: new Date(NOW).toISOString() }, other]);
    expect(ids()).toEqual(["old"]);
    expect(screen.getByRole("button", { name: "Older · 1" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "other" })).toBeNull();
  });

  it("applies the archived filter before grouping and does not treat archived pins as pins", async () => {
    const user = userEvent.setup();
    const old = topic("archived", 8, {
      archivedAt: new Date(NOW).toISOString(),
      pinnedAt: new Date(NOW).toISOString(),
    });
    topic("active", 1);
    mount([old], null, "archived");
    expect(screen.queryByRole("link", { name: "Main chat" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Older · 1" }));
    expect(ids()).toEqual(["archived"]);
    await user.click(screen.getByRole("button", { name: "Actions for archived" }));
    expect(within(screen.getByRole("menu")).queryByRole("menuitem", { name: "Pin" })).toBeNull();
  });
});
