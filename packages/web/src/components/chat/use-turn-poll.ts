import { useCallback, useEffect, useRef } from "react";

/** How long a visible chat waits between looks when no event asks for one. */
export const TURN_POLL_FALLBACK_MS = 30_000;
/** How soon a chat looks again after following a turn, for one queued behind it. */
export const TURN_POLL_AFTER_FOLLOW_MS = 2_000;

/**
 * What one look at a chat's turns found: nothing to follow, a turn this tab
 * already follows, or a turn it followed to its end.
 */
export type TurnPollOutcome = "idle" | "busy" | "followed";

/**
 * Looks at the chat's turns so it can follow one it did not start, such as a
 * backend continuation or a turn sent from another tab. It looks when it
 * starts, on each call of the returned `kick`, when the tab is shown again,
 * and every TURN_POLL_FALLBACK_MS while the tab is visible, in case an event
 * was lost. A hidden tab still looks on a kick and on start, which are one
 * request per turn, so a turn there still badges the tab.
 *
 * Nothing runs while `sessionId` is null or `paused` is true, and `kick` does
 * nothing then. A change of `sessionId`, `paused`, or `revision` starts over
 * with a look. Looks never overlap: a kick during one runs another after it.
 * A rejected `poll` counts as `idle`.
 */
export function useTurnPoll(
  sessionId: string | null,
  options: { paused: boolean; revision: number },
  poll: (sessionId: string, isCancelled: () => boolean) => Promise<TurnPollOutcome>,
): () => void {
  const { paused, revision } = options;
  const pollRef = useRef(poll);
  pollRef.current = poll;
  const kickRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!sessionId || paused) return;
    const id = sessionId;
    let cancelled = false;
    let inFlight = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const isCancelled = () => cancelled;
    const clearTimer = () => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
    };
    const wait = (outcome: TurnPollOutcome) => {
      clearTimer();
      if (outcome === "followed") {
        timer = setTimeout(look, TURN_POLL_AFTER_FOLLOW_MS);
      } else if (document.visibilityState !== "hidden") {
        timer = setTimeout(look, TURN_POLL_FALLBACK_MS);
      }
    };
    function look() {
      if (cancelled) return;
      if (inFlight) {
        again = true;
        return;
      }
      clearTimer();
      inFlight = true;
      void pollRef
        .current(id, isCancelled)
        .catch((): TurnPollOutcome => "idle")
        .then((outcome) => {
          inFlight = false;
          if (cancelled) return;
          if (again) {
            again = false;
            look();
          } else {
            wait(outcome);
          }
        });
    }
    const onVisibility = () => {
      if (document.visibilityState === "hidden") clearTimer();
      else look();
    };
    document.addEventListener("visibilitychange", onVisibility);
    kickRef.current = look;
    look();
    return () => {
      cancelled = true;
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibility);
      if (kickRef.current === look) kickRef.current = null;
    };
  }, [sessionId, paused, revision]);

  return useCallback(() => kickRef.current?.(), []);
}
