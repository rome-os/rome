import { describe, expect, it } from "@rstest/core";
import {
  activeSessionFromPath,
  chatKind,
  chatPath,
  isChatPath,
  isProjectChat,
  MAIN_CHAT_PATH,
} from "./chat-session";

describe("chatKind", () => {
  const chat = (fields: Record<string, string | null>) => ({ id: "c1", ...fields });

  it("tells the main, topic, task, fork and common chats apart", () => {
    const concierge = { agentName: "core:concierge" };
    expect(chatKind(chat({ ...concierge, id: "concierge" }), "concierge")).toBe("main");
    expect(chatKind(chat(concierge), "concierge")).toBe("topic");
    expect(chatKind(chat({ triggerKind: "concierge" }), "concierge")).toBe("task");
    expect(chatKind(chat({ parentSessionId: "c0" }), "concierge")).toBe("fork");
    expect(chatKind(chat({ agentName: null }), "concierge")).toBe("common");
    expect(chatKind(chat({ agentName: "replay" }), "concierge")).toBe("common");
  });

  it("counts a fork of a Concierge chat as a topic chat, which is neither listed in Projects nor forkable", () => {
    const fork = chat({ agentName: "core:concierge", parentSessionId: "topic-1" });
    expect(chatKind(fork, "concierge")).toBe("topic");
    expect(isProjectChat(chatKind(fork, "concierge"))).toBe(false);
  });

  it("lists and forks only common chats and fork chats", () => {
    expect(
      (["main", "topic", "task", "fork", "common"] as const).filter((kind) => isProjectChat(kind)),
    ).toEqual(["fork", "common"]);
  });
});

describe("activeSessionFromPath", () => {
  it("reads the id from /chat/<id>, decoded", () => {
    expect(activeSessionFromPath("/chat/topic-1")).toBe("topic-1");
    expect(activeSessionFromPath("/chat/a%20b/extra")).toBe("a b");
    expect(activeSessionFromPath("/chat")).toBeNull();
    expect(activeSessionFromPath("/sessions")).toBeNull();
  });

  it("reads /message as the main chat, once its id is known", () => {
    expect(activeSessionFromPath("/message", "concierge")).toBe("concierge");
    expect(activeSessionFromPath("/message", "visitor-main")).toBe("visitor-main");
    expect(activeSessionFromPath("/message")).toBeNull();
    expect(activeSessionFromPath("/chat/topic-1", "concierge")).toBe("topic-1");
  });
});

describe("chatPath", () => {
  it("sends the main chat to /message and any other chat to /chat/<id>", () => {
    expect(MAIN_CHAT_PATH).toBe("/message");
    expect(chatPath("concierge", "concierge")).toBe("/message");
    expect(chatPath("visitor-main", "visitor-main")).toBe("/message");
    expect(chatPath("topic-1", "concierge")).toBe("/chat/topic-1");
    expect(chatPath("concierge")).toBe("/chat/concierge");
    expect(chatPath("a b", null)).toBe("/chat/a%20b");
  });
});

describe("isChatPath", () => {
  it("is true for a new chat, an open chat and the main chat", () => {
    for (const path of ["/chat", "/chat/topic-1", "/message"]) expect(isChatPath(path)).toBe(true);
    for (const path of ["/", "/chatter", "/messages", "/sessions", "/message/x"]) {
      expect(isChatPath(path)).toBe(false);
    }
  });
});
