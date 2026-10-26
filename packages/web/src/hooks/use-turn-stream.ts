import { useCallback, useSyncExternalStore } from "react";
import type { TraceSegment, TraceSummary } from "@rome/api-types/trace-segments";
import { openTurnStream } from "@/lib/chat-api";
import { parseSSEEvents } from "@/lib/chat-sse";

export interface TurnStreamState {
  /** Segments in arrival order; an upsert replaces the segment with the same id. */
  segments: TraceSegment[];
  summary: TraceSummary | null;
  /**
   * The stream has ended: the server sent `done`, the turn's stream was gone
   * (404 after its retention window), or the connection failed or closed.
   * After this the stored trace is the record, so a reader should fetch it.
   */
  done: boolean;
  /** Set when the stream could not be read. A gone stream (404) is not an error. */
  error: string | null;
}

const IDLE: TurnStreamState = { segments: [], summary: null, done: false, error: null };

interface Entry {
  state: TurnStreamState;
  listeners: Set<() => void>;
  controller: AbortController;
  releaseTimer: ReturnType<typeof setTimeout> | null;
}

// One connection per turn, shared by every mounted reader of that turn (a chip
// and a row showing the same subagent). The entry lives while a reader is
// mounted and closes the connection when the last one leaves.
const entries = new Map<string, Entry>();

function setState(entry: Entry, next: TurnStreamState) {
  entry.state = next;
  for (const listener of entry.listeners) listener();
}

function applyEvents(state: TurnStreamState, events: { event: string; data: string }[]) {
  let segments = state.segments;
  let summary = state.summary;
  let done = state.done;
  let copied = false;
  for (const { event, data } of events) {
    if (event === "segment_upsert") {
      const segment = JSON.parse(data) as TraceSegment;
      if (!copied) {
        segments = segments.slice();
        copied = true;
      }
      const at = segments.findIndex((existing) => existing.id === segment.id);
      if (at < 0) segments.push(segment);
      else segments[at] = segment;
    } else if (event === "summary_update") {
      summary = JSON.parse(data) as TraceSummary;
    } else if (event === "done" || event === "stream_error") {
      done = true;
    }
  }
  return { ...state, segments, summary, done };
}

async function run(turnId: string, entry: Entry) {
  const { signal } = entry.controller;
  try {
    const response = await openTurnStream(turnId, signal);
    if (!response.ok || !response.body) {
      setState(entry, {
        ...entry.state,
        done: true,
        error: response.status === 404 ? null : `HTTP ${response.status}`,
      });
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!entry.state.done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const boundary = buffer.lastIndexOf("\n\n");
      if (boundary < 0) continue;
      const complete = buffer.slice(0, boundary + 2);
      buffer = buffer.slice(boundary + 2);
      setState(entry, applyEvents(entry.state, parseSSEEvents(complete)));
    }
    if (!entry.state.done) setState(entry, { ...entry.state, done: true });
    await reader.cancel().catch(() => {});
  } catch (err) {
    if (signal.aborted) return;
    setState(entry, {
      ...entry.state,
      done: true,
      error: err instanceof Error ? err.message : "Stream failed",
    });
  }
}

function acquire(turnId: string, listener: () => void): () => void {
  let entry = entries.get(turnId);
  if (!entry) {
    entry = {
      state: IDLE,
      listeners: new Set(),
      controller: new AbortController(),
      releaseTimer: null,
    };
    entries.set(turnId, entry);
    void run(turnId, entry);
  }
  if (entry.releaseTimer) {
    clearTimeout(entry.releaseTimer);
    entry.releaseTimer = null;
  }
  entry.listeners.add(listener);
  const held = entry;
  return () => {
    held.listeners.delete(listener);
    if (held.listeners.size > 0) return;
    // A zero-delay grace absorbs a reader that unmounts and remounts in the
    // same commit (StrictMode, a keyed re-render) without reopening the stream.
    held.releaseTimer = setTimeout(() => {
      if (held.listeners.size > 0) return;
      held.controller.abort();
      if (entries.get(turnId) === held) entries.delete(turnId);
    }, 0);
  };
}

/**
 * Follows a running agent turn's trace over `GET /api/chat/turns/:id/stream`.
 * The server replays the turn from its start, so the state is complete from
 * the first read. Pass `enabled: false` (or a null turn) to hold no connection.
 * Readers of one turn share a single connection.
 */
export function useTurnStream(
  turnId: string | null | undefined,
  { enabled = true }: { enabled?: boolean } = {},
): TurnStreamState {
  const active = enabled && !!turnId;
  const subscribe = useCallback(
    (listener: () => void) => (active && turnId ? acquire(turnId, listener) : () => {}),
    [active, turnId],
  );
  const getSnapshot = useCallback(
    () => (active && turnId ? (entries.get(turnId)?.state ?? IDLE) : IDLE),
    [active, turnId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => IDLE);
}
