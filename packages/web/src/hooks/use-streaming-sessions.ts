import { useCallback, useRef, useState } from "react";
import type { TraceSnapshot } from "@rome/api-types/trace-segments";

export type SessionStreamState = {
  turnId: string;
  snapshot: TraceSnapshot | null;
  // Live preview of the CURRENT in-flight assistant text block (server
  // `assistant_text` SSE events, `{blockId?, blockIx, text}`). Each completed block
  // becomes its own persisted message in the transcript, so the live tail only
  // ever holds the block being typed right now; the server clears it (emits an
  // empty text at the next blockIx) once a block commits. Empty until the first
  // block streams.
  assistantText: string;
  /** Provider block identity when the stream supplies one. */
  assistantBlockId?: string;
  assistantBlockIx: number;
  thinkingTextByBlockId: ReadonlyMap<string, string>;
  toolOutputTextByToolUseId: ReadonlyMap<string, string>;
  /** Trace activity at or before this ordinal was superseded by text. */
  textThroughOrdinal: number;
};

export type StreamingSessionMap = ReadonlyMap<string, SessionStreamState>;

export function startStream(
  prev: StreamingSessionMap,
  sessionId: string,
  turnId: string,
): StreamingSessionMap {
  if (prev.get(sessionId)?.turnId === turnId) return prev;
  const next = new Map(prev);
  next.set(sessionId, {
    turnId,
    snapshot: null,
    assistantText: "",
    assistantBlockIx: 0,
    thinkingTextByBlockId: new Map(),
    toolOutputTextByToolUseId: new Map(),
    textThroughOrdinal: -1,
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

// Turn-guarded like updateSnapshot. Block-guarded too: SSE events arrive in
// order, so a lower blockIx than the one on screen is a stale legacy frame — never
// regress to an earlier block. A higher blockIx replaces the current block: the
// completed block is now its own persisted message, and the server has already
// cleared the live tail (empty text at the new blockIx), so the tail only holds
// the block being typed now.
export function updateAssistantText(
  prev: StreamingSessionMap,
  sessionId: string,
  turnId: string,
  blockIx: number | undefined,
  assistantText: string,
  blockId?: string,
): StreamingSessionMap {
  const existing = prev.get(sessionId);
  if (!existing || existing.turnId !== turnId) return prev;
  // A provider id is the primary identity. The index remains only for old
  // rows/streams with no id, where its monotonic ordering rejects stale frames.
  if (!blockId && (blockIx ?? 0) < existing.assistantBlockIx) return prev;
  if (
    blockId === existing.assistantBlockId &&
    (blockId !== undefined || blockIx === existing.assistantBlockIx) &&
    existing.assistantText === assistantText
  ) {
    return prev;
  }
  const next = new Map(prev);
  next.set(sessionId, {
    ...existing,
    assistantText,
    ...(blockId ? { assistantBlockId: blockId } : { assistantBlockId: undefined }),
    assistantBlockIx: blockIx ?? existing.assistantBlockIx,
    // Empty block-boundary events must not erase newer thinking. Retain the
    // watermark after text commits so summary updates cannot revive it.
    textThroughOrdinal: assistantText.trim()
      ? Math.max(existing.textThroughOrdinal, existing.snapshot?.segments.at(-1)?.ordinal ?? -1)
      : existing.textThroughOrdinal,
  });
  return next;
}

function updatePreviewText(
  prev: StreamingSessionMap,
  sessionId: string,
  turnId: string,
  field: "thinkingTextByBlockId" | "toolOutputTextByToolUseId",
  id: string,
  text: string,
): StreamingSessionMap {
  const existing = prev.get(sessionId);
  if (!existing || existing.turnId !== turnId) return prev;
  const nextValues = new Map(existing[field]);
  if (text) nextValues.set(id, text);
  else nextValues.delete(id);
  const next = new Map(prev);
  next.set(sessionId, { ...existing, [field]: nextValues });
  return next;
}

export function updateThinkingText(
  prev: StreamingSessionMap,
  sessionId: string,
  turnId: string,
  blockId: string,
  text: string,
): StreamingSessionMap {
  return updatePreviewText(prev, sessionId, turnId, "thinkingTextByBlockId", blockId, text);
}

export function updateToolOutputText(
  prev: StreamingSessionMap,
  sessionId: string,
  turnId: string,
  toolUseId: string,
  text: string,
): StreamingSessionMap {
  return updatePreviewText(prev, sessionId, turnId, "toolOutputTextByToolUseId", toolUseId, text);
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

  const start = useCallback((sessionId: string, turnId: string) => {
    setStreams((prev) => startStream(prev, sessionId, turnId));
  }, []);
  const update = useCallback((sessionId: string, turnId: string, snapshot: TraceSnapshot) => {
    setStreams((prev) => updateSnapshot(prev, sessionId, turnId, snapshot));
  }, []);
  const updateText = useCallback(
    (
      sessionId: string,
      turnId: string,
      blockIx: number | undefined,
      assistantText: string,
      blockId?: string,
    ) => {
      setStreams((prev) =>
        updateAssistantText(prev, sessionId, turnId, blockIx, assistantText, blockId),
      );
    },
    [],
  );
  const updateThinking = useCallback(
    (sessionId: string, turnId: string, blockId: string, text: string) => {
      setStreams((prev) => updateThinkingText(prev, sessionId, turnId, blockId, text));
    },
    [],
  );
  const updateToolOutput = useCallback(
    (sessionId: string, turnId: string, toolUseId: string, text: string) => {
      setStreams((prev) => updateToolOutputText(prev, sessionId, turnId, toolUseId, text));
    },
    [],
  );
  const end = useCallback((sessionId: string, turnId: string) => {
    setStreams((prev) => endStream(prev, sessionId, turnId));
  }, []);

  return { streams, streamsRef, start, update, updateText, updateThinking, updateToolOutput, end };
}
