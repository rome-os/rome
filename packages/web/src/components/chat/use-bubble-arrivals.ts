import { useRef } from "react";

// A batch steps in this many times at most; later bubbles share the last step.
const MAX_STEP = 2;

/** Props for a bubble: `data-arrival` marks one that enters (see globals.css). */
export type ArrivalProps = (id: string) => { "data-arrival"?: number };

/**
 * Marks the messages that arrive while the transcript is open, the guardian's
 * own and the agent's, so their bubbles fade in instead of appearing at once.
 * `ids` are the transcript's message ids, oldest first.
 *
 * The ids of the first non-empty list are the history and never enter. Later
 * ids enter only when they come after every id seen before, so a page of older
 * history and a refetch of the same messages appear in place. Each message
 * gets its step in the batch it came with, and keeps it.
 */
export function useBubbleArrivals(ids: readonly string[]): ArrivalProps {
  const seen = useRef<Set<string> | null>(null);
  const arrived = useRef(new Map<string, number>());
  if (!seen.current) {
    if (ids.length > 0) seen.current = new Set(ids);
  } else {
    const known = seen.current;
    const lastKnown = ids.findLastIndex((id) => known.has(id));
    let step = 0;
    ids.forEach((id, index) => {
      if (known.has(id)) return;
      known.add(id);
      if (index > lastKnown) arrived.current.set(id, Math.min(step++, MAX_STEP));
    });
  }
  const map = arrived.current;
  return (id) => {
    const step = map.get(id);
    return step === undefined ? {} : { "data-arrival": step };
  };
}
