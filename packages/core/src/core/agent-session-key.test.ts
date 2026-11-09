import { describe, expect, it } from "@rstest/core";
import { storeForkParent, storeSubagentParent, walkToRoot } from "../agent/index.js";
import {
  adhocSessionKey,
  parseSessionKey,
  sessionKeyChannel,
  webchatConversationOfKey,
  webchatSessionKey,
} from "./agent-session-key.js";

// Stored rows look sessions up by these exact strings, so a builder that
// changes its output strands every existing model thread.
describe("agent session keys", () => {
  it("spells webchat keys as stored rows expect", () => {
    expect(webchatSessionKey("chat-1")).toBe("webchat:chat-1");
  });

  it("gives each ad-hoc run a fresh key under its agent", () => {
    expect(adhocSessionKey("main")).toMatch(/^main:[0-9a-f-]{36}$/);
    expect(adhocSessionKey("main")).not.toBe(adhocSessionKey("main"));
  });
});

describe("parseSessionKey", () => {
  it("names a webchat chat's own key", () => {
    expect(parseSessionKey(walkToRoot("webchat:chat-1"))).toEqual({
      kind: "webchat",
      chatId: "chat-1",
    });
    expect(webchatConversationOfKey("webchat:chat-1")).toBe("chat-1");
  });

  it("gives a subagent's or a fork's session its root's channel, and no conversation of its own", () => {
    const key = storeSubagentParent(storeForkParent("webchat:chat-1", "fork-1"));
    expect(webchatConversationOfKey(key)).toBeUndefined();
    expect(sessionKeyChannel(key)).toBe("webchat");
  });

  it("keeps a colon inside a messaging thread id", () => {
    expect(parseSessionKey(walkToRoot("slack:C1:1700000000.1"))).toEqual({
      kind: "channel",
      channel: "slack",
      threadId: "C1:1700000000.1",
    });
    expect(sessionKeyChannel("telegram:t1:subagent:abc")).toBe("telegram");
  });

  it("gives a sentinel no delivery channel", () => {
    expect(parseSessionKey(walkToRoot("sentinel:telegram:t1"))).toEqual({
      kind: "sentinel",
      watched: { kind: "channel", channel: "telegram", threadId: "t1" },
    });
    expect(sessionKeyChannel("sentinel:telegram:t1")).toBeUndefined();
  });

  it("treats a webchat key with extra parts as a plain channel key", () => {
    expect(webchatConversationOfKey("webchat:chat-1:extra")).toBeUndefined();
    expect(sessionKeyChannel("webchat:chat-1:extra")).toBe("webchat");
  });
});
