import { describe, expect, it } from "@rstest/core";
import {
  adhocSessionKey,
  forkSessionKey,
  parseSessionKey,
  sessionKeyChannel,
  subagentSessionKey,
  webchatConversationOfKey,
  webchatSessionKey,
} from "./agent-session-key.js";

// Stored rows look sessions up by these exact strings, so a builder that
// changes its output strands every existing provider thread.
describe("agent session keys", () => {
  it("spells webchat keys as stored rows expect", () => {
    expect(webchatSessionKey("chat-1")).toBe("webchat:chat-1");
  });

  it("nests subagent and fork keys under their parent", () => {
    expect(subagentSessionKey("webchat:chat-1")).toMatch(/^webchat:chat-1:subagent:[0-9a-f-]{36}$/);
    expect(subagentSessionKey("webchat:chat-1")).not.toBe(subagentSessionKey("webchat:chat-1"));
    expect(forkSessionKey("webchat:chat-1", "fork-1")).toBe("webchat:chat-1#fork:fork-1");
  });

  it("gives each ad-hoc run a fresh key under its agent", () => {
    expect(adhocSessionKey("main")).toMatch(/^main:[0-9a-f-]{36}$/);
    expect(adhocSessionKey("main")).not.toBe(adhocSessionKey("main"));
  });
});

describe("parseSessionKey", () => {
  it("names a webchat chat's own key", () => {
    expect(parseSessionKey("webchat:chat-1")).toEqual({
      kind: "webchat",
      conversationId: "chat-1",
    });
    expect(webchatConversationOfKey("webchat:chat-1")).toBe("chat-1");
  });

  it("reads subagent and fork keys back to their parent", () => {
    const key = subagentSessionKey(forkSessionKey("webchat:chat-1", "fork-1"));
    const parsed = parseSessionKey(key);
    expect(parsed).toMatchObject({
      kind: "subagent",
      parent: {
        kind: "fork",
        forkSessionId: "fork-1",
        parent: { kind: "webchat", conversationId: "chat-1" },
      },
    });
    expect(webchatConversationOfKey(key)).toBeUndefined();
    expect(sessionKeyChannel(key)).toBe("webchat");
  });

  it("keeps a colon inside a messaging thread id", () => {
    expect(parseSessionKey("slack:C1:1700000000.1")).toEqual({
      kind: "channel",
      channel: "slack",
      threadId: "C1:1700000000.1",
    });
    expect(sessionKeyChannel("telegram:t1:subagent:abc")).toBe("telegram");
  });

  it("gives a sentinel no delivery channel", () => {
    expect(parseSessionKey("sentinel:telegram:t1")).toEqual({
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
