import { useCallback, useSyncExternalStore } from "react";
import type { TraceSegment, TraceSummary } from "@rome/api-types/trace-segments";
import { openTurnStream } from "@/lib/chat-api";
import { parseSSEEvents } from "@/lib/chat-sse";

export interface TurnStreamState {
  /** Segments in arrival order; an upsert replaces the segment with the same id. */
  segments: TraceSegment[];
  summary: TraceSummary | null;
  /**
   * The turn has ended: the server sent `done`, or the turn's stream was gone
   * (404 after its retention window). Only then is the stored trace the record,
   * so a reader should fetch it. A dropped connection is not an end: the last
   * snapshot stays and the stream is reopened.
   */
  done: boolean;
  /** When `done` was applied (ms since epoch), so every reader shows the same end. */
  endedAt: number | null;
  /** The last transport failure, while the stream is being reopened. Never ends the turn. */
  error: string | null;
}

const IDLE: TurnStreamState = {
  segments: [],
  summary: null,
  done: false,
  endedAt: null,
  error: null,
};

// The same backoff as Chat's followTurn.
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 5_000;

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
  const endedAt = done && !state.done ? Date.now() : state.endedAt;
  return { ...state, segments, summary, done, endedAt };
}

function end(entry: Entry) {
  setState(entry, {
    ...entry.state,
    done: true,
    endedAt: entry.state.endedAt ?? Date.now(),
    error: null,
  });
}

/** Reads one connection. Resolves true when the turn ended, false on a transport failure. */
async function readOnce(turnId: string, entry: Entry): Promise<boolean> {
  const { signal } = entry.controller;
  try {
    const response = await openTurnStream(turnId, signal);
    if (response.status === 404) {
      end(entry);
      return true;
    }
    if (!response.ok || !response.body) {
      setState(entry, { ...entry.state, error: `HTTP ${response.status}` });
      return false;
    }
    if (entry.state.error) setState(entry, { ...entry.state, error: null });
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
    await reader.cancel().catch(() => {});
    if (entry.state.done) return true;
    // EOF without `done`: the connection dropped, the turn did not end.
    setState(entry, { ...entry.state, error: "Stream closed" });
    return false;
  } catch (err) {
    if (!signal.aborted) {
      setState(entry, {
        ...entry.state,
        error: err instanceof Error ? err.message : "Stream failed",
      });
    }
    return false;
  }
}

// Follows the turn until it ends or the last reader leaves. The server replays a
// turn from its start (and 404s once it is gone), so each reconnect gets a
// complete, definitive answer; the snapshot is kept meanwhile.
async function run(turnId: string, entry: Entry) {
  const { signal } = entry.controller;
  let delayMs = RETRY_BASE_DELAY_MS;
  while (!signal.aborted) {
    const openedAt = Date.now();
    if (await readOnce(turnId, entry)) return;
    if (signal.aborted) return;
    // Retry fast after a connection that held; keep backing off when streams
    // keep closing right away.
    if (Date.now() - openedAt >= RETRY_MAX_DELAY_MS) delayMs = RETRY_BASE_DELAY_MS;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    delayMs = Math.min(delayMs * 2, RETRY_MAX_DELAY_MS);
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
