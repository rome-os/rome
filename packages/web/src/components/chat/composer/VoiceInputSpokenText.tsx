import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

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
 * characters. Positions already shown take a corrected word's characters at
 * once, so a correction never fades in again; only new positions wait for
 * the budget. The shown text is never more than a second's worth of
 * characters behind. Counts characters, not UTF-16 units, so an emoji is
 * never split.
 */
export function nextReveal(current: string, goal: string, budget: number): string {
  const goalChars = Array.from(goal);
  const shownCount = Math.min(Array.from(current).length, goalChars.length);
  const behind = goalChars.length - shownCount;
  const step = Math.max(budget, behind - REVEAL_CHARS_PER_SECOND);
  return goalChars.slice(0, shownCount + Math.min(behind, step)).join("");
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
 * Render it as the textarea's sibling inside a `relative` wrapper: the copy is
 * laid out in that wrapper, so it clips, stacks and moves with the field.
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

  // Covers the field's box, less its scrollbar, so the copy wraps where the
  // field's text does, and follows the field's scroll position.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    const overlay = overlayRef.current;
    const parent = overlay?.offsetParent;
    if (!el || !overlay || !parent) return;
    const computed = getComputedStyle(el);
    for (const name of COPIED_STYLES) overlay.style[name] = computed[name];
    const place = () => {
      const box = el.getBoundingClientRect();
      const frame = parent.getBoundingClientRect();
      overlay.style.left = `${box.left - frame.left - parent.clientLeft}px`;
      overlay.style.top = `${box.top - frame.top - parent.clientTop}px`;
      // The client width leaves out a scrollbar; the borders go back in.
      const borders =
        Number.parseFloat(computed.borderLeftWidth) + Number.parseFloat(computed.borderRightWidth);
      overlay.style.width = `${el.clientWidth + borders}px`;
      overlay.style.height = `${el.offsetHeight}px`;
      overlay.scrollTop = el.scrollTop;
    };
    const scrolled = () => {
      overlay.scrollTop = el.scrollTop;
    };
    place();
    const resized = new ResizeObserver(place);
    resized.observe(el);
    resized.observe(parent);
    el.addEventListener("scroll", scrolled);
    return () => {
      resized.disconnect();
      el.removeEventListener("scroll", scrolled);
    };
  }, [textareaRef]);

  const chars = Array.from(shown);
  return (
    <div
      ref={overlayRef}
      aria-hidden
      data-voice-input-spoken-text
      className="pointer-events-none absolute overflow-hidden text-foreground whitespace-pre-wrap break-words border-solid border-transparent [overflow-wrap:break-word]"
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
      {value.endsWith("\n") ? "\u200b" : null}
    </div>
  );
}
