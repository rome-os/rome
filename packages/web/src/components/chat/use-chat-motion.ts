// Entry motion for transcript rows that arrive while the guardian watches: the
// bubble they just sent, and the agent row that starts answering it.
//
// A row arriving at the pinned bottom lifts the transcript by its height in one
// frame. The transcript is drawn back down by that amount and glides to rest,
// as one compositor transform on the transcript element. A sent bubble flies
// as a ghost: a copy drawn above the composer, posed against the glide, which
// hands over to the real bubble once it lands. The copy is needed because the
// real bubble sits inside the transformed transcript, under the sticky
// composer it has to rise out of. Every frame writes transforms and opacity
// only, so no frame lays out the transcript.

import { type RefObject, useLayoutEffect, useRef } from "react";
import { animate } from "motion/react";
import { allowsVerticalScroll } from "@/lib/scroll-container";
import { type SendOrigin, takeSendOrigin } from "@/lib/send-flight";

// Close to the iMessage send: quick to arrive, settling with a slight overshoot.
const ENTRY_SPRING = { type: "spring", visualDuration: 0.4, bounce: 0.12 } as const;

// The bubble rises from slightly smaller than its resting size.
const FLIGHT_START_SCALE = 0.9;

// The agent row starts this far below its slot, under the composer.
const ARRIVAL_RISE_PX = 18;

// The farthest the bubble is seen to travel. A send into a long thread rises
// about 80 to 110 px, from the composer to the slot just above it, and stays
// under this cap. The first message of a chat would otherwise cross most of
// the screen, so it starts at most this far from its slot instead.
const MAX_FLIGHT_PX = 120;

/**
 * Shortens a flight vector to at most `max` px, keeping its direction.
 * clampFlight(0, 600, 120) returns { x: 0, y: 120 }.
 */
export function clampFlight(x: number, y: number, max: number): { x: number; y: number } {
  const length = Math.hypot(x, y);
  if (length <= max) return { x, y };
  const k = max / length;
  return { x: x * k, y: y * k };
}

type Controls = ReturnType<typeof animate>;

// One per transcript element. Owns the shared offset the transcript is drawn
// at, and tells ghosts outside the transcript when it moves.
class TranscriptGlide {
  private offset = 0;
  private controls: Controls | null = null;
  private readonly listeners = new Set<(offset: number, pushed: number) => void>();

  constructor(private readonly content: HTMLElement) {}

  get value(): number {
    return this.offset;
  }

  /** Draws the transcript `delta` px lower and lets it glide back to rest. */
  push(delta: number): void {
    if (Math.abs(delta) < 0.5) return;
    this.controls?.stop();
    const from = this.offset + delta;
    this.set(from, delta);
    this.controls = animate(from, 0, {
      ...ENTRY_SPRING,
      onUpdate: (value) => this.set(value, 0),
      onComplete: () => {
        this.controls = null;
        this.set(0, 0);
        this.content.style.removeProperty("transform");
      },
    });
  }

  /**
   * Calls `listener` on every move with the current offset. `pushed` is the
   * jump a new arrival added in that move, and 0 on an animation frame.
   */
  subscribe(listener: (offset: number, pushed: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(value: number, pushed: number): void {
    this.offset = value;
    this.content.style.transform = `translate3d(0, ${value}px, 0)`;
    for (const listener of this.listeners) listener(value, pushed);
  }
}

const glides = new WeakMap<HTMLElement, TranscriptGlide>();

function transcriptOf(el: HTMLElement): HTMLElement | null {
  return el.closest<HTMLElement>("[data-chat-transcript]");
}

function glideFor(content: HTMLElement): TranscriptGlide {
  let glide = glides.get(content);
  if (!glide) {
    glide = new TranscriptGlide(content);
    glides.set(content, glide);
  }
  return glide;
}

function findScroller(start: HTMLElement): HTMLElement | null {
  let element = start.parentElement;
  while (element) {
    if (allowsVerticalScroll(window.getComputedStyle(element).overflowY)) return element;
    element = element.parentElement;
  }
  return null;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

// Runs `start` once the layout this commit produced has settled, including the
// stick-to-bottom re-pin. That re-pin runs in a ResizeObserver callback, so a
// second observer created later is called after it, still before paint. Two
// animation frames is the fallback for a commit that resized nothing.
function afterPin(content: HTMLElement, start: () => void): () => void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    start();
  };
  const observer = new ResizeObserver(run);
  observer.observe(content);
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(run);
  });
  return () => {
    done = true;
    observer.disconnect();
    cancelAnimationFrame(frame);
  };
}

// The untransformed viewport top of the transcript, so a glide already in
// progress does not count as movement.
function restingTop(content: HTMLElement, glide: TranscriptGlide): number {
  return content.getBoundingClientRect().top - glide.value;
}

/**
 * Raises a newly sent bubble out of the composer into its transcript slot.
 *
 * Runs once, on mount, and only for a message the composer recorded an origin
 * for. `rowRef` is the whole row, hidden until the bubble lands. `bubbleRef`
 * is the bubble: a copy of it starts on the composer's text box, right and
 * bottom edges aligned, slightly scaled down. Does nothing under
 * `prefers-reduced-motion` or outside a chat transcript.
 */
export function useSendFlight(
  messageId: string,
  rowRef: RefObject<HTMLElement | null>,
  bubbleRef: RefObject<HTMLElement | null>,
): void {
  // Held in a ref so StrictMode's mount, unmount, mount replay finds the
  // origin the first pass already took out of the registry.
  const originRef = useRef<SendOrigin | null | undefined>(undefined);

  useLayoutEffect(() => {
    if (originRef.current === undefined) originRef.current = takeSendOrigin(messageId);
    const origin = originRef.current;
    const row = rowRef.current;
    const bubble = bubbleRef.current;
    const content = row ? transcriptOf(row) : null;
    const host = content ? findScroller(content)?.parentElement : null;
    if (!origin || !row || !bubble || !content || !host || prefersReducedMotion()) return;

    const glide = glideFor(content);
    row.style.opacity = "0";
    const before = restingTop(content, glide);

    let ghost: HTMLElement | null = null;
    let controls: Controls | null = null;
    let unsubscribe = () => {};
    const show = () => {
      row.style.removeProperty("opacity");
      ghost?.remove();
      ghost = null;
      unsubscribe();
    };

    const cancelStart = afterPin(content, () => {
      // Measured before the glide moves anything: the bubble's resting slot.
      const rest = bubble.getBoundingClientRect();
      glide.push(before - restingTop(content, glide));

      const style = window.getComputedStyle(bubble);
      const insetRight =
        (Number.parseFloat(style.borderRightWidth) || 0) +
        (Number.parseFloat(style.paddingRight) || 0);
      const insetBottom =
        (Number.parseFloat(style.borderBottomWidth) || 0) +
        (Number.parseFloat(style.paddingBottom) || 0);
      // The start the guardian sees is the bubble's own offset plus the glide,
      // so the cap applies to that sum.
      const seen = clampFlight(
        origin.right - (rest.right - insetRight),
        origin.bottom - (rest.bottom - insetBottom),
        MAX_FLIGHT_PX,
      );
      const dx = seen.x;
      const dy = seen.y - glide.value;

      // The ghost lives in the transcript's host, which neither scrolls nor
      // transforms, above the composer floor (z-10).
      const hostRect = host.getBoundingClientRect();
      const copy = bubble.cloneNode(true) as HTMLElement;
      copy.removeAttribute("title");
      // A CSS animation outranks the inline opacity the flight fades with.
      copy.classList.remove("rome-bubble-pending");
      copy.setAttribute("aria-hidden", "true");
      Object.assign(copy.style, {
        position: "absolute",
        left: `${rest.left - hostRect.left}px`,
        top: `${rest.top - hostRect.top}px`,
        width: `${rest.width}px`,
        height: `${rest.height}px`,
        margin: "0",
        maxWidth: "none",
        zIndex: "30",
        pointerEvents: "none",
        transformOrigin: "100% 100%",
        willChange: "transform, opacity",
      });
      host.append(copy);
      ghost = copy;

      // `base` follows the slot when a later arrival lifts the transcript.
      let base = 0;
      let p = 1;
      const paint = () => {
        const scale = 1 - (1 - FLIGHT_START_SCALE) * p;
        copy.style.transform = `translate3d(${dx * p}px, ${base + dy * p + glide.value}px, 0) scale(${scale})`;
        copy.style.opacity = `${clamp01((1 - p) * 4)}`;
      };
      unsubscribe = glide.subscribe((_, pushed) => {
        base -= pushed;
        paint();
      });
      paint();
      controls = animate(1, 0, {
        ...ENTRY_SPRING,
        onUpdate: (value) => {
          p = value;
          paint();
        },
        onComplete: () => {
          originRef.current = null;
          show();
          // The timestamp and copy row, always shown on touch, fades in once
          // the bubble is home. It fades to its own opacity: on desktop that
          // is 0 until hover, and a fade to 1 would flash it.
          for (const child of Array.from(row.children)) {
            const target = window.getComputedStyle(child).opacity;
            if (child !== bubble && target !== "0") {
              child.animate([{ opacity: 0 }, { opacity: target }], {
                duration: 180,
                easing: "ease-out",
              });
            }
          }
        },
      });
    });
    return () => {
      cancelStart();
      controls?.stop();
      show();
    };
  }, [messageId, rowRef, bubbleRef]);
}

/**
 * Brings a row in from just below its slot, fading in, once, on mount. The
 * transcript above glides up to make room instead of jumping.
 *
 * `wrapperRef` wraps the row and receives the motion. Does nothing under
 * `prefers-reduced-motion` or outside a chat transcript.
 */
export function useArrival(wrapperRef: RefObject<HTMLElement | null>): void {
  const doneRef = useRef(false);

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const content = wrapper ? transcriptOf(wrapper) : null;
    if (doneRef.current || !wrapper || !content || prefersReducedMotion()) return;

    const glide = glideFor(content);
    wrapper.style.opacity = "0";
    const before = restingTop(content, glide);

    let controls: Controls | null = null;
    const reset = () => {
      wrapper.style.removeProperty("opacity");
      wrapper.style.removeProperty("transform");
    };
    const cancelStart = afterPin(content, () => {
      glide.push(before - restingTop(content, glide));
      const step = (p: number) => {
        wrapper.style.transform = `translate3d(0, ${ARRIVAL_RISE_PX * p}px, 0)`;
        wrapper.style.opacity = `${clamp01(1 - p)}`;
      };
      step(1);
      controls = animate(1, 0, {
        ...ENTRY_SPRING,
        onUpdate: step,
        onComplete: () => {
          doneRef.current = true;
          reset();
        },
      });
    });
    return () => {
      cancelStart();
      controls?.stop();
      reset();
    };
  }, [wrapperRef]);
}
