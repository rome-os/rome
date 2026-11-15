// Focusing a Concierge chat on one task's chat thread, in place
// (docs/domains/chats.md#chat-thread). The messages outside the thread fold
// away and back over MOTION_MS while the message the reader clicked stays where
// it is on screen. Which messages are outside is ConciergeTranscript's rule
// (`focusHidden`); this folds them and keeps the position.

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { HOLD_STICK_EVENT } from "@/hooks/use-stick-to-bottom";
import type { ReplyThread } from "./reply-draft";

const MOTION_MS = 200;

/** A thread in focus: the message it is held on, its task's title, and the thread `taskThreads` maps its messages to. */
export interface ThreadFocus extends ReplyThread {
  root: string;
}

export interface Env {
  scroller: HTMLElement;
  content: HTMLElement;
  /** Blank kept above the messages, when the scroll cannot absorb what folded above the anchor. */
  top: HTMLElement;
  /** Blank kept below them, so the scroll is never clamped while rows fold. */
  bottom: HTMLElement;
}

const spaceOf = (el: HTMLElement) => Number.parseFloat(el.style.height) || 0;
const setSpace = (el: HTMLElement, height: number) => {
  el.style.height = height > 0.5 ? `${height}px` : "";
};
const yOf = ({ scroller }: Env, el: HTMLElement) =>
  el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;

/** The box of message `id`, the unit a thread folds. */
function entryOf(scroller: HTMLElement, id: string): HTMLElement | null {
  const entries = scroller.querySelectorAll<HTMLElement>("[data-thread-entry]");
  return [...entries].find((entry) => entry.dataset.threadEntry === id) ?? null;
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
 * Fades and folds `rows` away (or back, with `away` false) over `ms`, easing
 * out, while `anchor` stays `y` below the scroller's top. The rows keep the
 * motion's inline styles when it resolves, for `release`. A row's own gap to
 * its neighbour folds with it.
 */
function fold(
  env: Env,
  rows: HTMLElement[],
  away: boolean,
  ms: number,
  anchor: HTMLElement | null,
  y: number,
) {
  const parts = rows.map((row) => ({
    row,
    height: row.getBoundingClientRect().height,
    gap: Number.parseFloat(getComputedStyle(row.parentElement ?? row).rowGap) || 0,
    margin: Number.parseFloat(getComputedStyle(row).marginBottom) || 0,
  }));
  // How far folded the rows are: 0 shown, 1 gone.
  const apply = (folded: number) => {
    for (const { row, height, gap, margin } of parts) {
      row.style.overflow = "hidden";
      row.style.height = `${height * (1 - folded)}px`;
      row.style.opacity = String(1 - Math.min(1, folded * 1.4));
      row.style.marginBottom = `${margin + (-gap - margin) * folded}px`;
    }
    if (anchor) pin(env, anchor, y);
    hold(env);
  };
  return new Promise<void>((resolve) => {
    if (ms === 0) {
      apply(away ? 1 : 0);
      resolve();
      return;
    }
    apply(away ? 0 : 1);
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / ms));
      const eased = 1 - (1 - t) ** 3;
      apply(away ? eased : 1 - eased);
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

function release(rows: HTMLElement[]) {
  for (const { style } of rows) {
    style.removeProperty("height");
    style.removeProperty("opacity");
    style.removeProperty("margin-bottom");
    style.removeProperty("overflow");
  }
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

/**
 * The chat thread a Concierge chat is focused on, and the motion that takes it
 * there and back. `scroller` is the message scroller and `content` the
 * transcript in it; `topSpace` and `bottomSpace` go on blank elements of the
 * scroller around the transcript. `resetKey` ends a focus without motion when
 * it changes, as when another chat opens.
 *
 * `focus` is the reader's: it is null as soon as a close starts. `shown`
 * is what the transcript still filters to, and outlasts `focus` by the motion.
 * `open` does nothing while a motion runs or a thread is already in focus.
 * `close` does nothing while a motion runs, and with `instant` skips the
 * motion, as for a jump to a message the focus hides.
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
      try {
        const anchor = entryOf(env.scroller, next.thread);
        const y = anchor ? yOf(env, anchor) : 0;
        // The rows go on showing until the motion folds them. The browser's own
        // scroll anchoring would move the scroll too, against `pin`.
        env.scroller.style.overflowAnchor = "none";
        env.content.setAttribute("data-thread-motion", "");
        hold(env);
        setSpace(env.bottom, Math.max(spaceOf(env.bottom), env.scroller.clientHeight));
        flushSync(() => {
          setFocus(next);
          setShown(next.root);
        });
        const rows = [...env.content.querySelectorAll<HTMLElement>("[data-thread-out]")];
        await fold(env, rows, true, reducedMotion() ? 0 : MOTION_MS, anchor, y);
        env.content.removeAttribute("data-thread-motion");
        release(rows);
        if (anchor) trimBottom(env, anchor);
      } finally {
        env.scroller.style.overflowAnchor = "";
        moving.current = false;
      }
    },
    [envOf],
  );

  const close = useCallback(
    async (instant = false) => {
      const env = envOf();
      const focused = latest.current.focus;
      if (!env || !focused || moving.current) return;
      moving.current = true;
      try {
        const anchor = anchorOf(env, focused);
        const y = anchor ? yOf(env, anchor) : 0;
        env.scroller.style.overflowAnchor = "none";
        env.content.setAttribute("data-thread-motion", "");
        hold(env);
        setFocus(null);
        setSpace(env.bottom, Math.max(spaceOf(env.bottom), env.scroller.clientHeight));
        const rows = [...env.content.querySelectorAll<HTMLElement>("[data-thread-out]")];
        await fold(env, rows, false, instant || reducedMotion() ? 0 : MOTION_MS, anchor, y);
        flushSync(() => setShown(null));
        env.content.removeAttribute("data-thread-motion");
        release(rows);
        // The chat is whole again: no blank above or below.
        setSpace(env.top, 0);
        setSpace(env.bottom, 0);
        if (anchor) env.scroller.scrollTop += yOf(env, anchor) - y;
        anchor?.querySelector<HTMLElement>("[data-thread-label]")?.focus({ preventScroll: true });
      } finally {
        env.scroller.style.overflowAnchor = "";
        moving.current = false;
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
