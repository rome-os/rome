import { useEffect, useRef, useState } from "react";
import { splitGraphemes } from "@/lib/graphemes";

// Typewriter pacing for the live assistant bubble. The server streams the
// accumulated text of the current block in provider-sized chunks (often whole
// sentences), so rendering each snapshot directly makes the bubble jump.
// Instead we reveal grapheme clusters at a steady base rate and scale the
// rate with the backlog, so a burst of text clears quickly while short
// appends still read as typing.
const BASE_GRAPHEMES_PER_SEC = 120;
// Extra reveal speed per backlog grapheme: a burst of N clusters drains at
// N * CATCH_UP_PER_SEC per second, i.e. within ~1/CATCH_UP_PER_SEC seconds.
const CATCH_UP_PER_SEC = 4;
// Clamp per-frame dt so a backgrounded tab (paused rAF) doesn't dump the
// whole backlog in one frame when it resumes.
const MAX_FRAME_SECONDS = 0.1;

/** One reveal step: how many graphemes to show after `dtSeconds` elapsed.
 *  `carry` holds the fractional budget between frames. Pure so the pacing is
 *  unit-testable without rAF. */
export function advanceReveal(
  shown: number,
  carry: number,
  targetLength: number,
  dtSeconds: number,
): { shown: number; carry: number } {
  const backlog = targetLength - shown;
  if (backlog <= 0) return { shown: targetLength, carry: 0 };
  const rate = Math.max(BASE_GRAPHEMES_PER_SEC, backlog * CATCH_UP_PER_SEC);
  const budget = carry + rate * dtSeconds;
  const step = Math.min(backlog, Math.floor(budget));
  // Cap the leftover fraction at one grapheme so a long stall can't bank a
  // burst that defeats the pacing on the next frame.
  return { shown: shown + step, carry: Math.min(budget - step, 1) };
}

/** Smooths a server-chunked accumulating string into a grapheme-by-grapheme
 *  typewriter reveal, returning the currently revealed prefix of `target`.
 *
 *  `resetKey` names the text's identity (e.g. `${turnId}:${blockIx}`). While
 *  it is stable, target growth types through smoothly. When it changes, the
 *  reveal restarts from zero — the new block is genuinely unseen content, so
 *  retyping it is honest (and an SSE replay after reload sweeps out quickly
 *  via the catch-up rate). Within a stable key the target should only grow;
 *  if it ever doesn't (defensive), we snap rather than animate. */
export function useSmoothText(target: string, resetKey: string): string {
  const [displayed, setDisplayed] = useState("");
  const segmentsRef = useRef<string[]>([]);
  const shownRef = useRef(0);
  const keyRef = useRef(resetKey);
  const carryRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef(0);

  useEffect(() => {
    const shownText = segmentsRef.current.slice(0, shownRef.current).join("");
    if (keyRef.current !== resetKey) {
      keyRef.current = resetKey;
      segmentsRef.current = splitGraphemes(target);
      shownRef.current = 0;
      carryRef.current = 0;
      setDisplayed("");
    } else if (!target.startsWith(shownText)) {
      segmentsRef.current = splitGraphemes(target);
      shownRef.current = segmentsRef.current.length;
      carryRef.current = 0;
      setDisplayed(target);
      return;
    } else {
      // Append within the same block. Re-segment the whole target: a chunk
      // boundary can extend the final shown grapheme (e.g. a ZWJ arriving in
      // the next frame), in which case the re-render completes it in place.
      segmentsRef.current = splitGraphemes(target);
      if (shownRef.current > segmentsRef.current.length) {
        shownRef.current = segmentsRef.current.length;
      }
    }
    if (shownRef.current >= segmentsRef.current.length || rafRef.current !== null) return;

    lastTickRef.current = performance.now();
    const tick = (now: number) => {
      rafRef.current = null;
      const segments = segmentsRef.current;
      const dt = Math.min((now - lastTickRef.current) / 1000, MAX_FRAME_SECONDS);
      lastTickRef.current = now;
      const next = advanceReveal(shownRef.current, carryRef.current, segments.length, dt);
      carryRef.current = next.carry;
      if (next.shown !== shownRef.current) {
        shownRef.current = next.shown;
        setDisplayed(segments.slice(0, next.shown).join(""));
      }
      if (shownRef.current < segments.length) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [target, resetKey]);

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  return displayed;
}
