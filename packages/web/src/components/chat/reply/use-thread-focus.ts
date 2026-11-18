// Focusing a Concierge chat on one chat thread, in place
// (docs/domains/chats.md#chat-thread). The chat changes in one view transition,
// the old picture fading into the new one, while the message the reader clicked
// stays where it is on screen. Which messages are outside is
// ConciergeTranscript's rule (`focusHidden`); this switches and keeps the position.

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { HOLD_STICK_EVENT } from "@/hooks/use-stick-to-bottom";
import type { FocusedThread } from "./reply-draft";

/** A thread in focus: the message it is held on, its name, and its root. */
export type ThreadFocus = FocusedThread;

export interface Env {
  scroller: HTMLElement;
  content: HTMLElement;
  /** Blank kept above the messages, when the scroll cannot absorb what left above the anchor. */
  top: HTMLElement;
  /** Blank kept below them, so the scroll is never clamped while the chat changes. */
  bottom: HTMLElement;
}

const spaceOf = (el: HTMLElement) => Number.parseFloat(el.style.height) || 0;
const setSpace = (el: HTMLElement, height: number) => {
  el.style.height = height > 0.5 ? `${height}px` : "";
};
const yOf = ({ scroller }: Env, el: HTMLElement) =>
  el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;

/** The box of message `id`, the unit a thread hides. */
function entryOf(scroller: HTMLElement, id: string): HTMLElement | null {
  const entries = scroller.querySelectorAll<HTMLElement>("[data-thread-entry]");
  return [...entries].find((entry) => entry.dataset.threadEntry === id) ?? null;
}

/**
 * The live box of message `id`, else of `fallback`. A render that regroups the
 * transcript (a thread's replies leave the main line for its stack, or come
 * back) can remount a message in another group, so a box found before it is
 * not the one on the screen after it. `fallback` is for a message that is no
 * longer drawn, such as a reply that folds back into its root's stack.
 */
export function liveEntry(scroller: HTMLElement, id: string | undefined, fallback?: string) {
  return (id && entryOf(scroller, id)) || (fallback ? entryOf(scroller, fallback) : null);
}

/** Tells the stick-to-bottom pin that the layout is moving on purpose, so it neither re-pins nor snaps back. */
function hold({ content }: Env) {
  content.dispatchEvent(new Event(HOLD_STICK_EVENT, { bubbles: true }));
}

/**
 * Keeps `anchor` `y` below the scroller's top. The scroll moves first. When it
 * runs out at the top, the rest goes to the blank above; when content above
 * grows again, that blank is given back before the scroll moves.
 */
export function pin(env: Env, anchor: HTMLElement, y: number) {
  const diff = yOf(env, anchor) - y;
  if (Math.abs(diff) < 0.5) return;
  const { scroller, top } = env;
  if (diff > 0) {
    const fromBlank = Math.min(diff, spaceOf(top));
    setSpace(top, spaceOf(top) - fromBlank);
    scroller.scrollTop += diff - fromBlank;
    return;
  }
  const want = scroller.scrollTop + diff;
  if (want >= 0) {
    scroller.scrollTop = want;
  } else {
    scroller.scrollTop = 0;
    setSpace(top, spaceOf(top) - want);
  }
}

/** Drops the blank below down to what the scroll needs to hold `anchor`. */
function trimBottom(env: Env, anchor: HTMLElement) {
  const { scroller, bottom } = env;
  const y = yOf(env, anchor);
  const extra = scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight);
  setSpace(bottom, spaceOf(bottom) - Math.max(0, Math.min(extra, spaceOf(bottom))));
  pin(env, anchor, y);
}

/**
 * The message to hold still while the focus closes: the one it was opened
 * from while that is on screen, else the first of the thread's messages that is.
 */
function anchorOf(env: Env, focus: ThreadFocus): HTMLElement | null {
  const view = env.scroller.getBoundingClientRect();
  const onScreen = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    return rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom;
  };
  const opened = entryOf(env.scroller, focus.thread);
  if (opened && onScreen(opened)) return opened;
  const entries = env.content.querySelectorAll<HTMLElement>("[data-thread-entry]");
  const inThread = [...entries].filter((entry) => !entry.closest("[data-thread-out]"));
  return inThread.find(onScreen) ?? opened;
}

const reducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { finished: Promise<void> };
};

/**
 * Makes `update`, a change of what the chat shows, as one view transition:
 * the browser fades the old picture into the new one, and no frame lays out
 * the transcript for the motion. Until it ends `keep` runs every frame, and
 * once more after, because what is shown again can still settle after the
 * update, such as a long message that measures itself once it shows, and the
 * held message must not move with it. Without view transitions, or with
 * reduced motion, the change is at once.
 */
export async function transition(update: () => void, keep: () => void) {
  const start = (document as ViewTransitionDocument).startViewTransition?.bind(document);
  if (!start || reducedMotion()) {
    update();
    keep();
    return;
  }
  let running = true;
  const tick = () => {
    if (!running) return;
    keep();
    requestAnimationFrame(tick);
  };
  const motion = start(() => {
    update();
    // The browser takes the new picture right after this: hold the message in it.
    keep();
    requestAnimationFrame(tick);
  });
  // A transition the browser skips, as for a newer one, still made the update.
  await motion.finished.catch(() => {});
  running = false;
  keep();
}

/**
 * The chat thread a Concierge chat is focused on, and the motion that takes it
 * there and back. `scroller` is the message scroller and `content` the
 * transcript in it; `topSpace` and `bottomSpace` go on blank elements of the
 * scroller around the transcript. `resetKey` ends a focus without motion when
 * it changes, as when another chat opens.
 *
 * `focus` is the reader's, and `shown` is what the transcript filters to; both
 * change in the same render. `open` does nothing while a motion runs or a
 * thread is already in focus. `close` waits for a motion that runs, then
 * closes; with `instant` it skips its own motion, as for a jump to a message
 * the focus hides.
 */
export function useThreadFocus({
  scroller,
  content,
  resetKey,
}: {
  scroller: HTMLElement | null;
  content: HTMLElement | null;
  resetKey: string | null | undefined;
}) {
  const topSpace = useRef<HTMLDivElement>(null);
  const bottomSpace = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<ThreadFocus | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const moving = useRef(false);
  // Settles when the motion that is running ends.
  const motion = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef({ scroller, content, focus });
  latest.current = { scroller, content, focus };

  const envOf = useCallback((): Env | null => {
    const { scroller, content } = latest.current;
    const top = topSpace.current;
    const bottom = bottomSpace.current;
    return scroller && content && top && bottom ? { scroller, content, top, bottom } : null;
  }, []);

  const open = useCallback(
    async (next: ThreadFocus) => {
      const env = envOf();
      if (!env || moving.current || latest.current.focus) return;
      moving.current = true;
      let done!: () => void;
      motion.current = new Promise<void>((resolve) => (done = resolve));
      try {
        const before = entryOf(env.scroller, next.thread);
        const y = before ? yOf(env, before) : 0;
        // The browser's own scroll anchoring would move the scroll too, against `pin`.
        env.scroller.style.overflowAnchor = "none";
        hold(env);
        let anchor: HTMLElement | null = null;
        await transition(
          () => {
            // A blank below, so holding the message never runs out of scroll.
            setSpace(env.bottom, Math.max(spaceOf(env.bottom), env.scroller.clientHeight));
            flushSync(() => {
              setFocus(next);
              setShown(next.root);
            });
            // The render regrouped the transcript: hold the message as it is now drawn.
            anchor = liveEntry(env.scroller, next.thread, next.root);
          },
          () => {
            if (anchor) pin(env, anchor, y);
            hold(env);
          },
        );
        if (anchor) trimBottom(env, anchor);
      } finally {
        env.scroller.style.overflowAnchor = "";
        moving.current = false;
        done();
      }
    },
    [envOf],
  );

  const close = useCallback(
    async (instant = false) => {
      // A close that comes while a motion runs waits for it, then closes.
      while (moving.current) await motion.current;
      const env = envOf();
      const focused = latest.current.focus;
      if (!env || !focused) return;
      moving.current = true;
      let done!: () => void;
      motion.current = new Promise<void>((resolve) => (done = resolve));
      try {
        const anchor = anchorOf(env, focused);
        const held = anchor?.dataset.threadEntry;
        const y = anchor ? yOf(env, anchor) : 0;
        env.scroller.style.overflowAnchor = "none";
        hold(env);
        let kept: HTMLElement | null = null;
        const update = () => {
          flushSync(() => {
            setFocus(null);
            setShown(null);
          });
          setSpace(env.top, 0);
          // The blank below stays while the chat settles, so holding the
          // message never runs out of scroll.
          setSpace(env.bottom, Math.max(spaceOf(env.bottom), env.scroller.clientHeight));
          // Closing regrouped the transcript, so the box held before may be
          // gone. A reply folded into its root's stack is held by the root.
          kept = liveEntry(env.scroller, held, focused.root);
          kept?.querySelector<HTMLElement>("[data-thread-label]")?.focus({ preventScroll: true });
        };
        const keep = () => {
          if (kept) pin(env, kept, y);
          hold(env);
        };
        if (instant) update();
        else await transition(update, keep);
        // The chat is whole again: no blank above or below.
        setSpace(env.bottom, 0);
        keep();
        setSpace(env.top, 0);
      } finally {
        env.scroller.style.overflowAnchor = "";
        moving.current = false;
        done();
      }
    },
    [envOf],
  );

  const reset = useCallback(() => {
    setFocus(null);
    setShown(null);
    for (const space of [topSpace.current, bottomSpace.current]) if (space) setSpace(space, 0);
  }, []);
  useEffect(() => reset, [resetKey, reset]);

  // Esc closes the focus, unless what has focus used the key first.
  useEffect(() => {
    if (!focus) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing) void close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [focus, close]);

  // A message that arrives in the thread takes up the blank kept below the
  // messages, so the end of the thread stays at the bottom of the view.
  useEffect(() => {
    if (!shown || !content || typeof ResizeObserver === "undefined") return;
    let height = content.offsetHeight;
    const observer = new ResizeObserver(() => {
      const bottom = bottomSpace.current;
      if (bottom && !moving.current && content.offsetHeight > height) {
        setSpace(bottom, spaceOf(bottom) - (content.offsetHeight - height));
      }
      height = content.offsetHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [shown, content]);

  return { focus, shown, open, close, reset, topSpace, bottomSpace };
}
