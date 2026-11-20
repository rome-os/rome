import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { VoiceInputPreview } from "./use-voice-input";

// Spoken text arrives in bursts. It is shown a character at a time at a
// steady pace, each character fading in, so it reads as if written rather
// than pasted. The field is a textarea, which cannot style part of its text,
// and its value stays untouched while listening so its undo history survives.
// So while voice input is on, the field's own text is hidden and a copy drawn
// over it shows the field's text with the spoken part in.

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
  const step = Math.max(budget, behind - REVEAL_CHARS_PER_SECOND, 0);
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
    // From the first frame's own time: a frame's time can be earlier than a
    // `performance.now()` read before it.
    let last: number | null = null;
    let budget = 0;
    const tick = (now: number) => {
      budget += (Math.max(0, now - (last ?? now)) / 1000) * REVEAL_CHARS_PER_SECOND;
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
 * Draws `preview.value` over the textarea, with the characters from
 * `preview.start` to `preview.end` revealed and faded in, and grows the field
 * to fit it within the field's max height. Renders nothing while `preview` is
 * null. Render it as the textarea's sibling inside a `relative` wrapper: the
 * copy is laid out in that wrapper, so it clips, stacks and moves with the
 * field.
 */
export function VoiceInputSpokenText({
  textareaRef,
  preview,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  preview: VoiceInputPreview | null;
}) {
  if (!preview) return null;
  return <SpokenOverlay textareaRef={textareaRef} preview={preview} />;
}

function SpokenOverlay({
  textareaRef,
  preview: { value, start, end },
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  preview: VoiceInputPreview;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const lastRef = useRef<HTMLSpanElement>(null);
  const shown = useReveal(value.slice(start, end));

  // The field's own text and placeholder go invisible under the copy, and the
  // field's height is the copy's while it shows. All come back when the copy
  // goes, and the composer sizes the field again once the words go in.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const { color, height, overflowY } = el.style;
    el.style.color = "transparent";
    el.classList.add("voice-input-previewing");
    return () => {
      el.style.color = color;
      el.style.height = height;
      el.style.overflowY = overflowY;
      el.classList.remove("voice-input-previewing");
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

  // Each revealed character can make the copy taller. The field grows with
  // it up to its max height, and past that the copy scrolls to keep the
  // newest words in view, as the caret would in the field.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    const overlay = overlayRef.current;
    if (!el || !overlay) return;
    const computed = getComputedStyle(el);
    const borders =
      Number.parseFloat(computed.borderTopWidth) + Number.parseFloat(computed.borderBottomWidth);
    const content = overlay.scrollHeight + borders;
    if (content > el.offsetHeight) el.style.height = `${content}px`;
    overlay.scrollTop = el.scrollTop;
    const last = lastRef.current;
    if (!last) return;
    const below = last.offsetTop + last.offsetHeight - overlay.clientHeight;
    if (below > overlay.scrollTop) overlay.scrollTop = below;
  }, [textareaRef, shown]);

  const chars = Array.from(shown);
  return (
    <div
      ref={overlayRef}
      aria-hidden
      data-voice-input-spoken-text
      className="pointer-events-none absolute overflow-hidden text-foreground whitespace-pre-wrap break-words border-solid border-transparent [overflow-wrap:break-word]"
    >
      {value.slice(0, start)}
      {chars.map((char, i) => (
        <span
          // By position: a corrected character swaps in place without fading again.
          key={i}
          ref={i === chars.length - 1 ? lastRef : undefined}
          className="voice-input-char-in"
        >
          {char}
        </span>
      ))}
      {value.slice(end)}
      {/* A trailing newline needs a character after it to take up its line, as in the field. */}
      {value.endsWith("\n") ? "\u200b" : null}
    </div>
  );
}
