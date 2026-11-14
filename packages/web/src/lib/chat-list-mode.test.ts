import { describe, expect, it } from "@rstest/core";
import {
  type ChatListMode,
  chatListModeForRoute,
  initialChatListMode,
  modeOfChatKind,
  newChatShortcutForPlatform,
  newChatTarget,
  railChatHref,
} from "./chat-list-mode";
import type { ChatKind } from "./chat-session";

const kinds: Record<string, ChatKind> = {
  topic: "topic",
  task: "task",
  mine: "common",
  fork: "fork",
};
const route = (pathname: string, state: unknown = null, mainChatId: string | null = "main") =>
  chatListModeForRoute({ pathname, state, mainChatId, kindOf: (id) => kinds[id] ?? null });

describe("initialChatListMode", () => {
  it("starts on Chat for someone with an ordinary chat, else on Concierge", () => {
    expect(initialChatListMode(true)).toBe("chat");
    expect(initialChatListMode(false)).toBe("concierge");
  });
});

describe("modeOfChatKind", () => {
  it.each<[ChatKind, ChatListMode]>([
    ["main", "concierge"],
    ["topic", "concierge"],
    ["task", "concierge"],
    ["common", "chat"],
    ["fork", "chat"],
  ])("puts a %s chat in %s", (kind, mode) => {
    expect(modeOfChatKind(kind)).toBe(mode);
  });
});

describe("chatListModeForRoute", () => {
  it("puts the main chat's page in Concierge mode, with or without its id known", () => {
    expect(route("/message")).toEqual({ mode: "concierge" });
    expect(route("/message", null, null)).toEqual({ mode: "concierge" });
    expect(route("/chat/main")).toEqual({ mode: "concierge" });
  });

  it("puts a blank chat in Chat mode, and a blank topic chat in Concierge mode", () => {
    expect(route("/chat")).toEqual({ mode: "chat" });
    expect(route("/chat", { projectPath: "default" })).toEqual({ mode: "chat" });
    expect(route("/chat", { conciergeTopic: true })).toEqual({ mode: "concierge" });
  });

  it("follows the kind of the open chat, and names an ordinary one", () => {
    expect(route("/chat/topic")).toEqual({ mode: "concierge" });
    expect(route("/chat/task")).toEqual({ mode: "concierge" });
    expect(route("/chat/mine")).toEqual({ mode: "chat", ordinaryChatId: "mine" });
    expect(route("/chat/fork")).toEqual({ mode: "chat", ordinaryChatId: "fork" });
  });

  it("asks for nothing while the open chat's kind is unknown, and off the chat pages", () => {
    expect(route("/chat/unlisted")).toBeNull();
    expect(route("/settings")).toBeNull();
    expect(route("/apps/chat")).toBeNull();
  });

  it("reads an encoded chat id", () => {
    expect(
      chatListModeForRoute({
        pathname: "/chat/a%20b",
        state: null,
        mainChatId: null,
        kindOf: (id) => (id === "a b" ? "common" : null),
      }),
    ).toEqual({ mode: "chat", ordinaryChatId: "a b" });
  });
});

describe("railChatHref", () => {
  it("opens the main chat in Concierge mode", () => {
    expect(railChatHref("concierge", "mine", true)).toBe("/message");
  });

  it("opens the last ordinary chat in Chat mode, and a blank chat without one or once it is gone", () => {
    expect(railChatHref("chat", "mine", true)).toBe("/chat/mine");
    expect(railChatHref("chat", "a b", true)).toBe("/chat/a%20b");
    expect(railChatHref("chat", null, true)).toBe("/chat");
    expect(railChatHref("chat", "mine", false)).toBe("/chat");
  });
});

describe("newChatTarget", () => {
  it("opens a blank ordinary chat in Chat mode and a blank topic chat in Concierge mode", () => {
    expect(newChatTarget("chat")).toEqual({ to: "/chat" });
    expect(newChatTarget("concierge")).toEqual({ to: "/chat", state: { conciergeTopic: true } });
  });

  it("keeps a query the page carries", () => {
    expect(newChatTarget("chat", "?hideSidebar=1")).toEqual({ to: "/chat?hideSidebar=1" });
  });
});

describe("newChatShortcutForPlatform", () => {
  it("names the modifier of the platform", () => {
    expect(newChatShortcutForPlatform("MacIntel")).toBe("⌘ ⇧ O");
    expect(newChatShortcutForPlatform("Linux x86_64")).toBe("Ctrl ⇧ O");
  });
});
