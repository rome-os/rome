import { describe, expect, it } from "@rstest/core";
import type { TraceSegment, TraceSnapshot } from "@rome/api-types/trace-segments";
import {
  endStream,
  startStream,
  updateAssistantText,
  updateSnapshot,
  type StreamingSessionMap,
} from "./use-streaming-sessions";

const snapshotFor = (id: string): TraceSnapshot => ({
  segments: [{ id } as unknown as TraceSegment],
  summary: { distinctApps: [], totalSteps: 0, invocationCounts: {} },
});

const segmentIdAt = (state: StreamingSessionMap, sessionId: string): string | undefined => {
  const seg = state.get(sessionId)?.snapshot?.segments[0];
  return seg?.id;
};

describe("streaming-sessions state", () => {
  it("preserves the live tail and trace when another input joins the same turn", () => {
    let state = startStream(new Map(), "session", "turn");
    state = updateSnapshot(state, "session", "turn", snapshotFor("trace"));
    state = updateAssistantText(state, "session", "turn", 0, "Still working");
    expect(startStream(state, "session", "turn")).toBe(state);
    expect(state.get("session")?.assistantText).toBe("Still working");
  });
  it("isolates per-session snapshots when concurrent streams update each other", () => {
    let state: StreamingSessionMap = new Map();
    state = startStream(state, "A", "turn-A");
    state = startStream(state, "B", "turn-B");

    state = updateSnapshot(state, "A", "turn-A", snapshotFor("a1"));
    expect(state.get("B")?.snapshot).toBeNull();

    state = updateSnapshot(state, "B", "turn-B", snapshotFor("b1"));
    expect(segmentIdAt(state, "A")).toBe("a1");
    expect(segmentIdAt(state, "B")).toBe("b1");

    state = updateSnapshot(state, "A", "turn-A", snapshotFor("a2"));
    expect(segmentIdAt(state, "A")).toBe("a2");
    expect(segmentIdAt(state, "B")).toBe("b1");
  });

  it("ignores snapshot updates for sessions with no active stream", () => {
    const empty: StreamingSessionMap = new Map();
    const after = updateSnapshot(empty, "ghost", "turn-x", snapshotFor("x"));
    expect(after.has("ghost")).toBe(false);
  });

  it("endStream removes only the target session", () => {
    let state: StreamingSessionMap = new Map();
    state = startStream(state, "A", "turn-A");
    state = startStream(state, "B", "turn-B");
    state = endStream(state, "A", "turn-A");
    expect(state.has("A")).toBe(false);
    expect(state.get("B")?.turnId).toBe("turn-B");
  });

  it("starting a new turn on the same session resets that session's snapshot", () => {
    let state: StreamingSessionMap = new Map();
    state = startStream(state, "A", "turn-A");
    state = updateSnapshot(state, "A", "turn-A", snapshotFor("a1"));
    state = startStream(state, "A", "turn-A-2");
    expect(state.get("A")?.turnId).toBe("turn-A-2");
    expect(state.get("A")?.snapshot).toBeNull();
  });

  it("endStream is a no-op on unknown sessions and returns the same reference", () => {
    const state: StreamingSessionMap = startStream(new Map(), "A", "turn-A");
    expect(endStream(state, "missing", "turn-x")).toBe(state);
  });

  it("updateSnapshot ignores writes from a stale reader after the turn was promoted", () => {
    let state: StreamingSessionMap = startStream(new Map(), "A", "turn-1");
    state = startStream(state, "A", "turn-2");
    const after = updateSnapshot(state, "A", "turn-1", snapshotFor("stale"));
    expect(after).toBe(state);
    expect(state.get("A")?.turnId).toBe("turn-2");
    expect(state.get("A")?.snapshot).toBeNull();
  });

  it("endStream from a stale reader does not evict a newer turn's entry", () => {
    let state: StreamingSessionMap = startStream(new Map(), "A", "turn-1");
    state = startStream(state, "A", "turn-2");
    const after = endStream(state, "A", "turn-1");
    expect(after).toBe(state);
    expect(state.get("A")?.turnId).toBe("turn-2");
  });

  it("updateAssistantText accumulates within a block and replaces on a higher blockIx", () => {
    let state: StreamingSessionMap = startStream(new Map(), "A", "turn-1");
    state = updateAssistantText(state, "A", "turn-1", 0, "Hel");
    state = updateAssistantText(state, "A", "turn-1", 0, "Hello");
    expect(state.get("A")?.assistantText).toBe("Hello");
    expect(state.get("A")?.assistantBlockIx).toBe(0);
    // Higher blockIx: the completed block is now its own message; the live tail
    // moves to the new block (the server clears it with an empty text first).
    state = updateAssistantText(state, "A", "turn-1", 1, "");
    expect(state.get("A")?.assistantText).toBe("");
    expect(state.get("A")?.assistantBlockIx).toBe(1);
    state = updateAssistantText(state, "A", "turn-1", 1, "Final answer");
    expect(state.get("A")?.assistantText).toBe("Final answer");
  });

  it("updateAssistantText never regresses to an earlier block", () => {
    let state: StreamingSessionMap = startStream(new Map(), "A", "turn-1");
    state = updateAssistantText(state, "A", "turn-1", 1, "current block");
    const after = updateAssistantText(state, "A", "turn-1", 0, "stale block");
    expect(after).toBe(state);
    expect(state.get("A")?.assistantText).toBe("current block");
  });

  it("updateAssistantText ignores writes from a stale turn", () => {
    let state: StreamingSessionMap = startStream(new Map(), "A", "turn-1");
    state = startStream(state, "A", "turn-2");
    const after = updateAssistantText(state, "A", "turn-1", 0, "stale");
    expect(after).toBe(state);
    expect(state.get("A")?.assistantText).toBe("");
  });
});
