import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";

// A batch steps in this many times at most; later bubbles share the last step.
const MAX_STEP = 2;

/**
 * `current` is true while a chat that was hidden and is shown again catches up
 * with what it missed. Messages that turn up in that window are history, not
 * arrivals. A ref, so that turning it on renders nothing.
 */
export const HoldArrivalsContext = createContext<{ readonly current: boolean }>({ current: false });

/** Props for a bubble: `data-arrival` marks one that enters (see globals.css). */
export type ArrivalProps = (id: string) => { "data-arrival"?: number };

/**
 * Marks the messages that arrive while the transcript is open, the guardian's
 * own and the agent's, so their bubbles fade in instead of appearing at once.
 * `ids` are the transcript's message ids, oldest first.
 *
 * The ids of the first non-empty list are the history and never enter. Later
 * ids enter only when they come after every id seen before, so a page of older
 * history and a refetch of the same messages appear in place. A list that
 * shares no id with the ones before it replaces the transcript (the newest page
 * after a gap), so it is history too. Each message gets its step in the batch
 * it came with, and keeps it.
 *
 * Hiding the chat (an `<Activity>`) forgets every step: a hidden element comes
 * back with its animation restarted, so a bubble that entered long ago would
 * enter again. `root` holds the bubbles; showing the chat again strips their
 * `data-arrival` before anything is painted. While {@link HoldArrivalsContext}
 * is held, new ids join the history instead of entering.
 */
export function useBubbleArrivals(
  ids: readonly string[],
  root: RefObject<HTMLElement | null>,
): ArrivalProps {
  const seen = useRef<Set<string> | null>(null);
  const arrived = useRef(new Map<string, number>());
  const hold = useContext(HoldArrivalsContext).current;
  const hidden = useRef(false);
  useLayoutEffect(() => {
    if (hidden.current) {
      hidden.current = false;
      // The DOM is edited, not rendered again: a render would rebuild every bubble.
      for (const bubble of root.current?.querySelectorAll("[data-arrival]") ?? []) {
        bubble.removeAttribute("data-arrival");
      }
    }
    const steps = arrived.current;
    return () => {
      steps.clear();
      hidden.current = true;
    };
  }, [root]);
  if (!seen.current) {
    if (ids.length > 0) seen.current = new Set(ids);
  } else {
    const known = seen.current;
    const lastKnown = ids.findLastIndex((id) => known.has(id));
    const replaced = lastKnown < 0 && ids.length > 0;
    let step = 0;
    ids.forEach((id, index) => {
      if (known.has(id)) return;
      known.add(id);
      if (!hold && !replaced && index > lastKnown)
        arrived.current.set(id, Math.min(step++, MAX_STEP));
    });
  }
  // One function for the life of the chat, so the bubbles it is passed to can
  // be memoized. It reads the steps when called, and a bubble already drawn
  // keeps its step, so the rows that skip a render lose nothing.
  return useCallback((id) => {
    const step = arrived.current.get(id);
    return step === undefined ? {} : { "data-arrival": step };
  }, []);
}
