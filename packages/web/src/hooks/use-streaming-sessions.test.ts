import { describe, expect, it } from "@rstest/core";
import type { TraceSegment, TraceSnapshot } from "@rome/api-types/trace-segments";
import {
  adoptAgentTurnId,
  endStream,
  runningTurnIdOf,
  startStream,
  updateAssistantBlock,
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
  it("preserves the live block and trace when another input joins the same turn", () => {
    let state = startStream(new Map(), "session", "turn");
    state = updateSnapshot(state, "session", "turn", snapshotFor("trace"));
    state = updateAssistantBlock(state, "session", "turn", 0, true);
    expect(startStream(state, "session", "turn")).toBe(state);
    expect(segmentIdAt(state, "session")).toBe("trace");
    expect(state.get("session")?.assistantBlockIx).toBe(0);
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

  it("updateAssistantBlock moves to a higher blockIx and stays put for more text in a block", () => {
    let state: StreamingSessionMap = startStream(new Map(), "A", "turn-1");
    state = updateSnapshot(state, "A", "turn-1", snapshotFor("trace"));
    state = updateAssistantBlock(state, "A", "turn-1", 0, true);
    expect(state.get("A")?.assistantBlockIx).toBe(0);
    // More text in the same block changes nothing the chat draws from state.
    expect(updateAssistantBlock(state, "A", "turn-1", 0, true)).toBe(state);
    // Higher blockIx: the completed block is now its own message; the live tail
    // moves to the new block (the server clears it with an empty text first).
    state = updateAssistantBlock(state, "A", "turn-1", 1, false);
    expect(state.get("A")?.assistantBlockIx).toBe(1);
  });

  it("updateAssistantBlock keeps the thinking watermark through an empty block boundary", () => {
    let state: StreamingSessionMap = startStream(new Map(), "A", "turn-1");
    state = updateSnapshot(state, "A", "turn-1", {
      segments: [{ id: "s", ordinal: 4 } as unknown as TraceSegment],
      summary: { distinctApps: [], totalSteps: 0, invocationCounts: {} },
    });
    state = updateAssistantBlock(state, "A", "turn-1", 0, true);
    expect(state.get("A")?.textThroughOrdinal).toBe(4);
    state = updateAssistantBlock(state, "A", "turn-1", 1, false);
    expect(state.get("A")?.textThroughOrdinal).toBe(4);
  });

  it("updateAssistantBlock never regresses to an earlier block", () => {
    let state: StreamingSessionMap = startStream(new Map(), "A", "turn-1");
    state = updateAssistantBlock(state, "A", "turn-1", 1, true);
    const after = updateAssistantBlock(state, "A", "turn-1", 0, true);
    expect(after).toBe(state);
    expect(state.get("A")?.assistantBlockIx).toBe(1);
  });

  it("names the running turn by its agent turn id while keeping the stream's turnId", () => {
    let state: StreamingSessionMap = startStream(new Map(), "A", "backend:wake");
    state = updateSnapshot(state, "A", "backend:wake", snapshotFor("live"));
    expect(runningTurnIdOf(state.get("A"))).toBe("backend:wake");

    state = adoptAgentTurnId(state, "A", "backend:wake", "turn-real");
    expect(state.get("A")?.turnId).toBe("backend:wake");
    expect(segmentIdAt(state, "A")).toBe("live");
    expect(runningTurnIdOf(state.get("A"))).toBe("turn-real");
    // Updates and the end still go through the turnId the stream was opened under.
    state = updateSnapshot(state, "A", "backend:wake", snapshotFor("next"));
    expect(segmentIdAt(state, "A")).toBe("next");
    expect(endStream(state, "A", "backend:wake").has("A")).toBe(false);
    expect(runningTurnIdOf(undefined)).toBeNull();
  });

  it("adoptAgentTurnId ignores a stale turn and a repeated id", () => {
    let state: StreamingSessionMap = startStream(new Map(), "A", "turn-1");
    state = startStream(state, "A", "turn-2");
    expect(adoptAgentTurnId(state, "A", "turn-1", "turn-real")).toBe(state);
    state = adoptAgentTurnId(state, "A", "turn-2", "turn-real");
    expect(adoptAgentTurnId(state, "A", "turn-2", "turn-real")).toBe(state);
  });

  it("updateAssistantBlock ignores writes from a stale turn", () => {
    let state: StreamingSessionMap = startStream(new Map(), "A", "turn-1");
    state = startStream(state, "A", "turn-2");
    const after = updateAssistantBlock(state, "A", "turn-1", 3, true);
    expect(after).toBe(state);
    expect(state.get("A")?.assistantBlockIx).toBe(0);
  });
});
