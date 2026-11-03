// Entry motion for agent rows that arrive while the guardian watches.
//
// A row arriving at the pinned bottom lifts the transcript by its height in one
// frame. The transcript is drawn back down by that amount and glides to rest,
// as one compositor transform on the transcript element. Every frame writes
// transforms and opacity only, so no frame lays out the transcript.

import { type RefObject, useLayoutEffect, useRef } from "react";
import { animate } from "motion/react";

// Close to the iMessage send: quick to arrive, settling with a slight overshoot.
const ENTRY_SPRING = { type: "spring", visualDuration: 0.4, bounce: 0.12 } as const;

// The agent row starts this far below its slot, under the composer.
const ARRIVAL_RISE_PX = 18;

type Controls = ReturnType<typeof animate>;

// One per transcript element. Owns the shared offset the transcript is drawn at.
class TranscriptGlide {
  private offset = 0;
  private controls: Controls | null = null;

  constructor(private readonly content: HTMLElement) {}

  get value(): number {
    return this.offset;
  }

  /** Draws the transcript `delta` px lower and lets it glide back to rest. */
  push(delta: number): void {
    if (Math.abs(delta) < 0.5) return;
    this.controls?.stop();
    const from = this.offset + delta;
    this.set(from);
    this.controls = animate(from, 0, {
      ...ENTRY_SPRING,
      onUpdate: (value) => this.set(value),
      onComplete: () => {
        this.controls = null;
        this.set(0);
        this.content.style.removeProperty("transform");
      },
    });
  }

  private set(value: number): void {
    this.offset = value;
    this.content.style.transform = `translate3d(0, ${value}px, 0)`;
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
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(run);
  observer?.observe(content);
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(run);
  });
  return () => {
    done = true;
    observer?.disconnect();
    cancelAnimationFrame(frame);
  };
}

// The untransformed viewport top of the transcript, so a glide already in
// progress does not count as movement.
function restingTop(content: HTMLElement, glide: TranscriptGlide): number {
  return content.getBoundingClientRect().top - glide.value;
}

/** How an entry comes in: a bubble pops from its bottom-left corner, a card
 * mostly rises, and a whole row rises without scaling. */
export type EntranceKind = "bubble" | "card" | "row";

const ENTRANCES: Record<EntranceKind, { scale: number; rise: number }> = {
  bubble: { scale: 0.8, rise: 8 },
  card: { scale: 0.96, rise: 12 },
  row: { scale: 1, rise: ARRIVAL_RISE_PX },
};

// The iMessage incoming bubble overshoots a little more than the send does.
const POP_SPRING = { type: "spring", visualDuration: 0.36, bounce: 0.2 } as const;

// Entries that have already come in on this page. The live preview of a block
// and its saved copy share a key, so the hand-over does not replay the entrance.
const enteredEntries = new Set<string>();

/**
 * Brings an entry in once, the first time an entry with `entryKey` mounts while
 * `live` is true. Entries of a settled turn, and keys seen before, appear in
 * place. The transcript above glides up to make room instead of jumping.
 *
 * `ref` wraps the entry and receives the motion. Does nothing under
 * `prefers-reduced-motion` or outside a chat transcript.
 */
export function useEntrance(
  ref: RefObject<HTMLElement | null>,
  entryKey: string,
  live: boolean,
  kind: EntranceKind,
): void {
  // Decided on the first effect run and kept in a ref, so StrictMode's replay
  // animates the entry the first run claimed.
  const animateRef = useRef<boolean | undefined>(undefined);
  const doneRef = useRef(false);

  useLayoutEffect(() => {
    if (animateRef.current === undefined) {
      animateRef.current = live && !enteredEntries.has(entryKey);
      enteredEntries.add(entryKey);
    }
    const el = ref.current;
    const content = el ? transcriptOf(el) : null;
    if (!animateRef.current || doneRef.current || !el || !content || prefersReducedMotion()) {
      return;
    }

    const { scale, rise } = ENTRANCES[kind];
    const glide = glideFor(content);
    el.style.opacity = "0";
    el.style.transformOrigin = "0% 100%";
    const before = restingTop(content, glide);

    let controls: Controls | null = null;
    const reset = () => {
      for (const property of ["opacity", "transform", "transform-origin"]) {
        el.style.removeProperty(property);
      }
    };
    const cancelStart = afterPin(content, () => {
      glide.push(before - restingTop(content, glide));
      const step = (p: number) => {
        el.style.transform = `translate3d(0, ${rise * p}px, 0) scale(${1 - (1 - scale) * p})`;
        el.style.opacity = `${clamp01((1 - p) * 3)}`;
      };
      step(1);
      controls = animate(1, 0, {
        ...(kind === "bubble" ? POP_SPRING : ENTRY_SPRING),
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
  }, [ref, entryKey, live, kind]);
}
