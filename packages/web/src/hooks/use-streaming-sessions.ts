import { useCallback, useRef, useState } from "react";
import type { TraceSnapshot } from "@rome/api-types/trace-segments";
import { createLiveTextSource, type LiveTextSource, type LiveTextStore } from "./live-text";

export type SessionStreamState = {
  /** The id the stream was opened under. Keys its follower, controller and Stop. */
  turnId: string;
  /**
   * The agent's own turn id, when it differs from the `turnId` the stream was
   * opened under (a backend task's synthetic `backend:` id). The turn's saved
   * trace and reply carry this id.
   */
  agentTurnId?: string;
  snapshot: TraceSnapshot | null;
  // The CURRENT in-flight assistant text block (server `assistant_text` SSE
  // events, `{blockIx, text}`). Each completed block becomes its own persisted
  // message in the transcript, so the live tail only ever holds the block being
  // typed right now; the server clears it (emits an empty text at the next
  // blockIx) once a block commits. The text itself lives in the session's
  // live-text source, not here: it arrives many times a second, and a state
  // change renders the whole chat.
  assistantBlockIx: number;
  /** Trace activity at or before this ordinal was superseded by text. */
  textThroughOrdinal: number;
  /** A backend turn that is housekeeping for the agent: the Concierge chat
   *  shows no typing indicator for it until the agent speaks. */
  quiet?: boolean;
};

export type StreamingSessionMap = ReadonlyMap<string, SessionStreamState>;

export function startStream(
  prev: StreamingSessionMap,
  sessionId: string,
  turnId: string,
  quiet = false,
): StreamingSessionMap {
  if (prev.get(sessionId)?.turnId === turnId) return prev;
  const next = new Map(prev);
  next.set(sessionId, {
    turnId,
    snapshot: null,
    assistantBlockIx: 0,
    textThroughOrdinal: -1,
    ...(quiet ? { quiet } : {}),
  });
  return next;
}

// Turn-guarded: stale readers from a turn that was already promoted or
// replaced must not clobber the newer turn's snapshot for the same session.
export function updateSnapshot(
  prev: StreamingSessionMap,
  sessionId: string,
  turnId: string,
  snapshot: TraceSnapshot,
): StreamingSessionMap {
  const existing = prev.get(sessionId);
  if (!existing || existing.turnId !== turnId) return prev;
  const next = new Map(prev);
  next.set(sessionId, { ...existing, snapshot });
  return next;
}

// Turn-guarded like updateSnapshot. The entry stays under the id its stream
// was opened with, so its follower and Stop keep finding it.
export function adoptAgentTurnId(
  prev: StreamingSessionMap,
  sessionId: string,
  turnId: string,
  agentTurnId: string,
): StreamingSessionMap {
  const existing = prev.get(sessionId);
  if (!existing || existing.turnId !== turnId || existing.agentTurnId === agentTurnId) return prev;
  const next = new Map(prev);
  next.set(sessionId, { ...existing, agentTurnId });
  return next;
}

/** The id the transcript knows the running turn by. */
export function runningTurnIdOf(state: SessionStreamState | null | undefined): string | null {
  return state?.agentTurnId ?? state?.turnId ?? null;
}

// Turn-guarded like updateSnapshot. Block-guarded too: SSE events arrive in
// order, so a lower blockIx than the one on screen is a stale frame — never
// regress to an earlier block. A higher blockIx replaces the current block: the
// completed block is now its own persisted message, and the server has already
// cleared the live tail (empty text at the new blockIx), so the tail only holds
// the block being typed now. Returns `prev` while the block and the watermark
// stand, which is every delivery after a block's first: the text is not state.
export function updateAssistantBlock(
  prev: StreamingSessionMap,
  sessionId: string,
  turnId: string,
  blockIx: number,
  hasText: boolean,
): StreamingSessionMap {
  const existing = prev.get(sessionId);
  if (!existing || existing.turnId !== turnId) return prev;
  if (blockIx < existing.assistantBlockIx) return prev;
  // Empty block-boundary events must not erase newer thinking. Retain the
  // watermark after text commits so summary updates cannot revive it.
  const textThroughOrdinal = hasText
    ? Math.max(existing.textThroughOrdinal, existing.snapshot?.segments.at(-1)?.ordinal ?? -1)
    : existing.textThroughOrdinal;
  if (blockIx === existing.assistantBlockIx && textThroughOrdinal === existing.textThroughOrdinal) {
    return prev;
  }
  const next = new Map(prev);
  next.set(sessionId, { ...existing, assistantBlockIx: blockIx, textThroughOrdinal });
  return next;
}

// Turn-guarded: a stale reattach finalizer must not evict an entry that a
// newer turn (foreground send or fresh reattach) has since installed.
export function endStream(
  prev: StreamingSessionMap,
  sessionId: string,
  turnId: string,
): StreamingSessionMap {
  const existing = prev.get(sessionId);
  if (!existing || existing.turnId !== turnId) return prev;
  const next = new Map(prev);
  next.delete(sessionId);
  return next;
}

// Per-session streaming state. Each ongoing chat keeps its own turnId and live
// trace snapshot so concurrent streams cannot clobber each other's data.
export function useStreamingSessions() {
  const [streams, setStreams] = useState<StreamingSessionMap>(() => new Map());
  const streamsRef = useRef(streams);
  streamsRef.current = streams;
  const liveTexts = useRef(new Map<string, LiveTextSource>());

  const liveSource = useCallback((sessionId: string): LiveTextSource => {
    let source = liveTexts.current.get(sessionId);
    if (!source) {
      source = createLiveTextSource();
      liveTexts.current.set(sessionId, source);
    }
    return source;
  }, []);
  /** The session's live text, one store for as long as the chat lives. */
  const liveText = useCallback(
    (sessionId: string): LiveTextStore => liveSource(sessionId),
    [liveSource],
  );

  const start = useCallback(
    (sessionId: string, turnId: string, quiet?: boolean) => {
      liveSource(sessionId).open(turnId);
      setStreams((prev) => startStream(prev, sessionId, turnId, quiet));
    },
    [liveSource],
  );
  const update = useCallback((sessionId: string, turnId: string, snapshot: TraceSnapshot) => {
    setStreams((prev) => updateSnapshot(prev, sessionId, turnId, snapshot));
  }, []);
  const updateText = useCallback(
    (sessionId: string, turnId: string, blockIx: number, assistantText: string) => {
      liveSource(sessionId).set(turnId, blockIx, assistantText);
      setStreams((prev) =>
        updateAssistantBlock(prev, sessionId, turnId, blockIx, assistantText.trim() !== ""),
      );
    },
    [liveSource],
  );
  const adoptAgentTurn = useCallback((sessionId: string, turnId: string, agentTurnId: string) => {
    setStreams((prev) => adoptAgentTurnId(prev, sessionId, turnId, agentTurnId));
  }, []);
  const end = useCallback(
    (sessionId: string, turnId: string) => {
      liveSource(sessionId).close(turnId);
      setStreams((prev) => endStream(prev, sessionId, turnId));
    },
    [liveSource],
  );

  return { streams, streamsRef, liveText, start, update, updateText, adoptAgentTurn, end };
}
