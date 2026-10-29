import { useCallback, useSyncExternalStore } from "react";
import type { TraceSegment, TraceSummary } from "@rome/api-types/trace-segments";
import { openTurnStream } from "@/lib/chat-api";
import {
  parseSSEEvents,
  STREAM_STALL_TIMEOUT_MS,
  TURN_RESUME_BASE_DELAY_MS,
  TURN_RESUME_MAX_DELAY_MS,
} from "@/lib/chat-sse";

export interface TurnStreamState {
  /** Segments in arrival order; an upsert replaces the segment with the same id. */
  segments: TraceSegment[];
  summary: TraceSummary | null;
  /**
   * The turn ended: the server sent `done`, the stream was gone (404), or the
   * request was refused (401/403). Then the stored trace is the record. A dropped
   * connection is not an end: the snapshot stays and the stream is reopened.
   */
  done: boolean;
}

const IDLE: TurnStreamState = { segments: [], summary: null, done: false };

interface Entry {
  state: TurnStreamState;
  /** Segment and summary events applied so far; a reconnect skips that many. */
  applied: number;
  listeners: Set<() => void>;
  controller: AbortController;
  releaseTimer: ReturnType<typeof setTimeout> | null;
}

// One connection per turn, shared by every mounted reader of that turn (a chip
// and a row showing the same subagent). It closes when the last reader leaves.
const entries = new Map<string, Entry>();

function setState(entry: Entry, next: TurnStreamState) {
  entry.state = next;
  for (const listener of entry.listeners) listener();
}

// A reconnect replays the turn from its start, and the server derives these
// events from the turn's append-only message list, so the replay repeats the
// events already applied, in order. Skipping that many resumes exactly.
function applyEvents(entry: Entry, events: { event: string; data: string }[], seen: number) {
  let { segments, summary, done } = entry.state;
  segments = segments.slice();
  for (const { event, data } of events) {
    if (event === "segment_upsert" || event === "summary_update") {
      seen += 1;
      if (seen <= entry.applied) continue;
      entry.applied = seen;
      const value = JSON.parse(data);
      if (event === "summary_update") summary = value as TraceSummary;
      else {
        const at = segments.findIndex((segment) => segment.id === value.id);
        if (at < 0) segments.push(value as TraceSegment);
        else segments[at] = value as TraceSegment;
      }
    } else if (event === "done" || event === "stream_error") {
      done = true;
    }
  }
  setState(entry, { segments, summary, done });
  return seen;
}

/** Reads one connection. True when the turn ended, false on a transport failure. */
async function readOnce(turnId: string, entry: Entry): Promise<boolean> {
  try {
    const response = await openTurnStream(turnId, entry.controller.signal);
    // Retrying cannot help after a 404 (stream gone) or a 401/403.
    if ([401, 403, 404].includes(response.status)) {
      void response.body?.cancel().catch(() => {});
      setState(entry, { ...entry.state, done: true });
      return true;
    }
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => {});
      return false;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let seen = 0;
    while (!entry.state.done) {
      // The same stall watchdog as Chat.consumeStream: a connection that went
      // quiet (mobile background, network swap) never rejects the read.
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<"stalled">((resolve) => {
          stallTimer = setTimeout(() => resolve("stalled"), STREAM_STALL_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(stallTimer));
      if (chunk === "stalled" || chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const boundary = buffer.lastIndexOf("\n\n");
      if (boundary < 0) continue;
      const complete = buffer.slice(0, boundary + 2);
      buffer = buffer.slice(boundary + 2);
      seen = applyEvents(entry, parseSSEEvents(complete), seen);
    }
    await reader.cancel().catch(() => {});
    return entry.state.done;
  } catch {
    return entry.state.done;
  }
}

// Follows the turn until it ends or the last reader leaves, reopening a dropped
// stream with the backoff of Chat.followTurn.
async function run(turnId: string, entry: Entry) {
  const { signal } = entry.controller;
  let delayMs = TURN_RESUME_BASE_DELAY_MS;
  while (!signal.aborted && !(await readOnce(turnId, entry))) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
    });
    delayMs = Math.min(delayMs * 2, TURN_RESUME_MAX_DELAY_MS);
  }
}

function acquire(turnId: string, listener: () => void): () => void {
  let entry = entries.get(turnId);
  if (!entry) {
    entry = {
      state: IDLE,
      applied: 0,
      listeners: new Set(),
      controller: new AbortController(),
      releaseTimer: null,
    };
    entries.set(turnId, entry);
    void run(turnId, entry);
  }
  if (entry.releaseTimer) clearTimeout(entry.releaseTimer);
  entry.releaseTimer = null;
  entry.listeners.add(listener);
  const held = entry;
  return () => {
    held.listeners.delete(listener);
    if (held.listeners.size > 0) return;
    // Zero-delay grace: a reader that remounts in the same commit keeps the stream.
    held.releaseTimer = setTimeout(() => {
      if (held.listeners.size > 0) return;
      held.controller.abort();
      if (entries.get(turnId) === held) entries.delete(turnId);
    }, 0);
  };
}

/** Follows a running turn over `GET /api/chat/turns/:id/stream`. Readers share one connection. */
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
