import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Spoken text arrives in bursts. It is shown a character at a time at a
// steady pace, each character fading in, so it reads as if written rather
// than pasted. The field is a textarea, which cannot style part of its text,
// so while voice input is on the field's own text is hidden and a copy drawn
// over it shows the spoken part this way.

/** Characters shown per second while spoken text arrives. */
export const REVEAL_CHARS_PER_SECOND = 20;
// Each character fades in over 280 ms: `.voice-input-char-in` in globals.css.

/**
 * The text to show after `current`, moving toward `goal` by `budget`
 * characters. A corrected word takes back what no longer matches, and the
 * shown text is never more than a second's worth of characters behind.
 */
export function nextReveal(current: string, goal: string, budget: number): string {
  let common = 0;
  while (common < current.length && common < goal.length && current[common] === goal[common]) {
    common += 1;
  }
  const behind = goal.length - common;
  const step = Math.max(budget, behind - REVEAL_CHARS_PER_SECOND);
  return goal.slice(0, common + Math.min(behind, step));
}

function useReveal(goal: string): string {
  const reduce =
    typeof window !== "undefined" &&
    (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  const [shown, setShown] = useState("");
  const goalRef = useRef(goal);
  goalRef.current = goal;
  useEffect(() => {
    if (reduce) return;
    let frame = 0;
    let last = performance.now();
    let budget = 0;
    const tick = (now: number) => {
      budget += ((now - last) / 1000) * REVEAL_CHARS_PER_SECOND;
      last = now;
      const whole = Math.floor(budget);
      budget -= whole;
      setShown((current) => nextReveal(current, goalRef.current, whole));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [reduce]);
  return reduce ? goal : shown;
}

// The textarea's own text layout, so the copy wraps at the same places.
const COPIED_STYLES = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "textIndent",
  "textTransform",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "tabSize",
] as const;

/**
 * Draws `value` over the textarea, with the characters in `spoken` (a range
 * of `value`) revealed and faded in. Renders nothing while `spoken` is null.
 */
export function VoiceInputSpokenText({
  textareaRef,
  value,
  spoken,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  spoken: { start: number; end: number } | null;
}) {
  if (!spoken) return null;
  return <SpokenOverlay textareaRef={textareaRef} value={value} spoken={spoken} />;
}

function SpokenOverlay({
  textareaRef,
  value,
  spoken,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  spoken: { start: number; end: number };
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const shown = useReveal(value.slice(spoken.start, spoken.end));

  // The field's own text goes invisible under the copy, and comes back when
  // the copy goes.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const color = el.style.color;
    el.style.color = "transparent";
    return () => {
      el.style.color = color;
    };
  }, [textareaRef]);

  // Follows the field wherever it is drawn, and its scroll position.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    const overlay = overlayRef.current;
    if (!el || !overlay) return;
    const computed = getComputedStyle(el);
    for (const name of COPIED_STYLES) overlay.style[name] = computed[name];
    let frame = 0;
    const follow = () => {
      const box = el.getBoundingClientRect();
      overlay.style.transform = `translate(${box.left}px, ${box.top}px)`;
      overlay.style.width = `${box.width}px`;
      overlay.style.height = `${box.height}px`;
      overlay.style.visibility = box.width > 0 ? "visible" : "hidden";
      overlay.scrollTop = el.scrollTop;
      frame = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(frame);
  }, [textareaRef]);

  const chars = Array.from(shown);
  return createPortal(
    <div
      ref={overlayRef}
      aria-hidden
      data-voice-input-spoken-text
      className="pointer-events-none fixed top-0 left-0 z-50 overflow-hidden text-foreground whitespace-pre-wrap break-words border-solid border-transparent [overflow-wrap:break-word]"
    >
      {value.slice(0, spoken.start)}
      {chars.map((char, i) => (
        <span
          // By position: a corrected character swaps in place without fading again.
          key={i}
          className="voice-input-char-in"
        >
          {char}
        </span>
      ))}
      {value.slice(spoken.end)}
      {/* A trailing newline needs a character after it to take up its line, as in the field. */}
      {value.endsWith("\n") ? "​" : null}
    </div>,
    document.body,
  );
}
