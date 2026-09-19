// @rstest-environment jsdom
import { describe, expect, it, rs } from "@rstest/core";
import type { ChatMessage } from "./chat-types";
import {
  ChatTranscriptCache,
  MAX_TRANSCRIPT_CACHE_BYTES,
  MAX_TRANSCRIPT_CACHE_ENTRIES,
  MAX_TRANSCRIPT_CACHE_ENTRY_BYTES,
} from "./chat-transcript-cache";

function message(sessionId: string, content = "message"): ChatMessage {
  return {
    id: `${sessionId}-message`,
    sessionId,
    role: "assistant",
    content,
    createdAt: "2026-09-19T00:00:00.000Z",
  };
}

describe("ChatTranscriptCache", () => {
  it("keeps five complete histories and evicts the least recently viewed inactive one", () => {
    const cache = new ChatTranscriptCache();
    const context = "instance-a|guardian-a";
    cache.activateContext(context);
    for (let index = 1; index <= MAX_TRANSCRIPT_CACHE_ENTRIES; index += 1) {
      expect(cache.putComplete(context, `session-${index}`, [message(`session-${index}`)])).toBe(
        true,
      );
    }
    cache.get(context, "session-1");
    cache.putComplete(context, "session-6", [message("session-6")]);

    expect(cache.snapshot().ids).toEqual([
      "session-3",
      "session-4",
      "session-5",
      "session-1",
      "session-6",
    ]);
    expect(cache.get(context, "session-2")).toBeUndefined();
  });

  it("does not evict a visible history", () => {
    const cache = new ChatTranscriptCache();
    const context = "instance-a|guardian-a";
    cache.activateContext(context);
    const owner = Symbol("visible-chat");
    cache.putComplete(context, "session-1", [message("session-1")]);
    cache.protect(context, "session-1", owner);
    for (let index = 2; index <= 6; index += 1) {
      cache.putComplete(context, `session-${index}`, [message(`session-${index}`)]);
    }

    expect(cache.get(context, "session-1")).toBeDefined();
    expect(cache.snapshot().ids).toHaveLength(MAX_TRANSCRIPT_CACHE_ENTRIES);
  });

  it("rejects a history over the entry budget", () => {
    const cache = new ChatTranscriptCache();
    const context = "instance-a|guardian-a";
    cache.activateContext(context);
    const oversized = "x".repeat(MAX_TRANSCRIPT_CACHE_ENTRY_BYTES + 1);

    expect(cache.putComplete(context, "large", [message("large", oversized)])).toBe(false);
    expect(cache.get(context, "large")).toBeUndefined();
  });

  it("enforces the total byte budget", () => {
    const cache = new ChatTranscriptCache();
    const context = "instance-a|guardian-a";
    cache.activateContext(context);
    const content = "x".repeat(9 * 1024 * 1024);
    cache.putComplete(context, "session-1", [message("session-1", content)]);
    cache.putComplete(context, "session-2", [message("session-2", content)]);
    cache.putComplete(context, "session-3", [message("session-3", content)]);

    expect(cache.snapshot().totalBytes).toBeLessThanOrEqual(MAX_TRANSCRIPT_CACHE_BYTES);
    expect(cache.snapshot().ids).toEqual(["session-2", "session-3"]);
  });

  it("clears histories and request ownership when the authenticated context changes", () => {
    const cache = new ChatTranscriptCache();
    cache.activateContext("instance-a|guardian-a");
    cache.putComplete("instance-a|guardian-a", "session-1", [message("session-1")]);
    const oldRequest = cache.beginRequest("instance-a|guardian-a", "session-1");
    cache.activateContext("instance-b|guardian-b");

    expect(cache.get("instance-b|guardian-b", "session-1")).toBeUndefined();
    expect(cache.snapshot().ids).toEqual([]);
    expect(cache.isRequestContextCurrent(oldRequest, "instance-b|guardian-b")).toBe(false);
  });

  it("rejects stale context activity without disturbing the active context", () => {
    const cache = new ChatTranscriptCache();
    const contextA = "instance|guardian-a";
    const contextB = "instance|guardian-b";
    cache.activateContext(contextA);
    cache.putComplete(contextA, "session-a", [message("session-a")]);
    cache.activateContext(contextB);
    cache.putComplete(contextB, "session-b", [message("session-b")]);
    const currentRequest = cache.beginRequest(contextB, "session-b");

    expect(cache.get(contextA, "session-a")).toBeUndefined();
    expect(cache.putComplete(contextA, "stale-write", [message("stale-write")])).toBe(false);
    cache.protect(contextA, "session-a", Symbol("stale-owner"));
    const staleRequest = cache.beginRequest(contextA, "session-b");

    expect(cache.isRequestContextCurrent(staleRequest, contextB)).toBe(false);
    expect(cache.canWriteComplete(currentRequest, contextB)).toBe(true);
    expect(cache.get(contextB, "session-b")?.map((entry) => entry.id)).toEqual([
      "session-b-message",
    ]);
    expect(cache.snapshot().ids).toEqual(["session-b"]);
  });

  it("revokes every session in only the active context until a fresh context activates", () => {
    const cache = new ChatTranscriptCache();
    const contextA = "instance|guardian-a";
    const contextB = "instance|guardian-b";
    const listener = rs.fn();
    cache.subscribeAuthorizationRevocations(listener);
    cache.activateContext(contextA);
    const staleRequest = cache.beginRequest(contextA, "session-1");
    cache.activateContext(contextB);
    cache.putComplete(contextB, "session-1", [message("session-1")]);
    cache.putComplete(contextB, "session-2", [message("session-2")]);
    const currentRequestA = cache.beginRequest(contextB, "session-1");
    const currentRequestB = cache.beginRequest(contextB, "session-2");
    const currentEventsB = cache.captureSession(contextB, "session-2");

    expect(cache.revokeAuthorization(contextA)).toBe(false);
    expect(cache.get(contextB, "session-1")).toBeDefined();
    expect(cache.get(contextB, "session-2")).toBeDefined();
    expect(listener).not.toHaveBeenCalled();

    expect(cache.revokeAuthorization(contextB)).toBe(true);
    expect(cache.snapshot().ids).toEqual([]);
    expect(cache.isRequestContextCurrent(staleRequest, contextB)).toBe(false);
    expect(cache.isRequestContextCurrent(currentRequestA, contextB)).toBe(false);
    expect(cache.isRequestContextCurrent(currentRequestB, contextB)).toBe(false);
    expect(cache.isSessionCurrent(currentEventsB, contextB)).toBe(false);
    expect(cache.isAuthorizationRevoked(contextB)).toBe(true);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ contextKey: contextB }));

    const blockedRequest = cache.beginRequest(contextB, "session-1");
    expect(cache.isRequestContextCurrent(blockedRequest, contextB)).toBe(false);
    expect(cache.putComplete(contextB, "session-1", [message("session-1")])).toBe(false);

    cache.activateContext(null);
    cache.activateContext(contextB);
    const freshRequest = cache.beginRequest(contextB, "session-1");
    expect(cache.isAuthorizationRevoked(contextB)).toBe(false);
    expect(cache.isRequestContextCurrent(freshRequest, contextB)).toBe(true);
    expect(cache.putComplete(contextB, "session-1", [message("session-1")])).toBe(true);
  });

  it("keeps an older complete result as fallback only while a newer request is pending", () => {
    const cache = new ChatTranscriptCache();
    cache.activateContext("context");
    const first = cache.beginRequest("context", "session-1");
    const second = cache.beginRequest("context", "session-1");

    expect(cache.canWriteComplete(first, "context")).toBe(true);
    expect(cache.canWriteComplete(second, "context")).toBe(true);
    cache.finishRequest(second);
    expect(cache.canWriteComplete(second, "context")).toBe(false);
    expect(cache.canWriteComplete(first, "context")).toBe(false);
  });

  it("restores cache-write ownership to an in-flight request when a newer request fails", () => {
    const cache = new ChatTranscriptCache();
    cache.activateContext("context");
    const first = cache.beginRequest("context", "session-1");
    const second = cache.beginRequest("context", "session-1");

    cache.finishRequest(second, { failed: true });

    expect(cache.canWriteComplete(first, "context")).toBe(true);
    cache.finishRequest(first);
    expect(cache.canWriteComplete(first, "context")).toBe(false);
  });

  it("keeps a pending-identity request current through initial explicit activation", () => {
    const cache = new ChatTranscriptCache();
    const request = cache.beginRequest(null, "session-1");

    cache.activateContext("context");

    expect(cache.isRequestContextCurrent(request, null)).toBe(true);
    expect(cache.canWriteComplete(request, "context")).toBe(true);
  });

  it("accounts for live inserts without serializing the full transcript", () => {
    const cache = new ChatTranscriptCache();
    const context = "context";
    cache.activateContext(context);
    const first = message("session-1", "first");
    const second = { ...message("session-1", "你好"), id: "second" };
    cache.putComplete(context, "session-1", [first]);
    const stringify = rs.spyOn(JSON, "stringify");

    cache.upsertMessageIfPresent(context, "session-1", second, (messages) => [...messages, second]);

    expect(stringify.mock.calls.some(([value]) => Array.isArray(value))).toBe(false);
    expect(cache.snapshot().totalBytes).toBe(
      new TextEncoder().encode(JSON.stringify([first, second])).byteLength,
    );
  });

  it("drops a live-updated history as soon as it exceeds the entry budget", () => {
    const cache = new ChatTranscriptCache();
    const context = "context";
    cache.activateContext(context);
    cache.putComplete(context, "session-1", [message("session-1")]);
    const oversized = {
      ...message("session-1", "x".repeat(MAX_TRANSCRIPT_CACHE_ENTRY_BYTES)),
      id: "oversized",
    };

    cache.upsertMessageIfPresent(context, "session-1", oversized, (messages) => [
      ...messages,
      oversized,
    ]);

    expect(cache.get(context, "session-1")).toBeUndefined();
  });

  it("stays in one memory instance and never writes browser persistence", () => {
    const setItem = rs.spyOn(Storage.prototype, "setItem");
    const cache = new ChatTranscriptCache();
    cache.activateContext("context");
    cache.putComplete("context", "session-1", [message("session-1")]);

    expect(new ChatTranscriptCache().get("context", "session-1")).toBeUndefined();
    expect(setItem).not.toHaveBeenCalled();
  });
});
