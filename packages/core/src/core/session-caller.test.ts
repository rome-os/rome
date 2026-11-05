import { describe, expect, it } from "@rstest/core";
import {
  adhocCaller,
  callerConnection,
  callerFromKey,
  callerKey,
  childCaller,
  type SessionCaller,
} from "./session-caller.js";

// Stored rows look sessions up by these exact strings, so a caller whose key
// changes strands every existing provider thread.
describe("session caller keys", () => {
  const chat: SessionCaller = { kind: "chat", chatId: "chat-1" };

  it("spells each kind as stored rows expect", () => {
    expect(callerKey(chat)).toBe("webchat:chat-1");
    expect(callerKey({ kind: "place", connection: "telegram", place: "t1" })).toBe("telegram:t1");
    expect(callerKey({ kind: "place", connection: "telegram", place: "t1", watcher: true })).toBe(
      "sentinel:telegram:t1",
    );
    expect(callerKey({ kind: "fork-point", source: chat, forkSessionId: "fork-1" })).toBe(
      "webchat:chat-1#fork:fork-1",
    );
    expect(callerKey(childCaller(chat))).toMatch(/^webchat:chat-1:subagent:[0-9a-f-]{36}$/);
    expect(callerKey(childCaller(chat))).not.toBe(callerKey(childCaller(chat)));
  });

  it("gives each ad-hoc run a fresh key under its agent", () => {
    expect(callerKey(adhocCaller("main"))).toMatch(/^main:[0-9a-f-]{36}$/);
    expect(callerKey(adhocCaller("main"))).not.toBe(callerKey(adhocCaller("main")));
  });

  it("reads every stored key back to the same key", () => {
    for (const key of [
      "webchat:chat-1",
      "telegram:t1",
      "slack:C1:1700000000.1",
      "sentinel:telegram:t1",
      "webchat:chat-1:subagent:abc",
      "webchat:chat-1#fork:f1:subagent:abc",
      "webchat:chat-1:extra",
      "plain",
    ]) {
      expect(callerKey(callerFromKey(key))).toBe(key);
    }
  });

  it("reads the kinds and the connection a key names", () => {
    expect(callerFromKey("webchat:chat-1")).toEqual(chat);
    expect(callerFromKey("slack:C1:1700000000.1")).toEqual({
      kind: "place",
      connection: "slack",
      place: "C1:1700000000.1",
    });
    expect(callerConnection(callerFromKey("telegram:t1:subagent:abc"))).toBe("telegram");
    expect(callerConnection(callerFromKey("sentinel:telegram:t1"))).toBeUndefined();
    expect(callerConnection(callerFromKey("webchat:chat-1:extra"))).toBe("webchat");
    expect(callerFromKey("webchat:chat-1:extra").kind).toBe("place");
  });
});
