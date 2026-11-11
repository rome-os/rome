/** How long the thread view fades in and out, in ms. Matches `[data-chat-thread-fade]` in globals.css. */
export const THREAD_FADE_MS = 180;

/** How long a message the reader lands on keeps its tint (`[data-timeline-landed]` in globals.css). */
export const LANDING_MS = 900;

/**
 * Where the thread view puts its messages so the message it was opened from
 * stays exactly where it was in the timeline. All lengths are in px from the
 * top of the view's scroll box.
 *
 * The message's old place is first kept inside the view: below the header
 * (`minTop`) and above the composer (`maxTop`). A thread taller than the view
 * then scrolls so the message sits there, as far as the thread reaches. A
 * thread that fits is lifted off the composer to bring the message there, as
 * far as its free space allows, which may leave blurred space under it.
 */
export function threadAnchor({
  desired,
  copyTop,
  slack,
  viewHeight,
  scrollHeight,
  minTop = 0,
  maxTop = viewHeight,
}: {
  /** Where the message sat in the timeline. */
  desired: number;
  /** Where the thread's copy of the message sits, with no scroll and no lift. */
  copyTop: number;
  /** The free space above a thread that fits; 0 or less when it scrolls. */
  slack: number;
  viewHeight: number;
  scrollHeight: number;
  /** The highest the message may sit: just below the header. */
  minTop?: number;
  /** The lowest the message's top may sit: its first lines above the composer. */
  maxTop?: number;
}): { scrollTop: number; lift: number } {
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), Math.max(max, 0));
  const target = Math.min(Math.max(desired, minTop), Math.max(maxTop, minTop));
  if (slack > 0) return { scrollTop: 0, lift: Math.round(clamp(copyTop - target, slack)) };
  return { scrollTop: Math.round(clamp(copyTop - target, scrollHeight - viewHeight)), lift: 0 };
}

/**
 * Whether a message shows in the timeline between `top` and `bottom`: its top
 * edge and its first lines, or all of it when it is short.
 */
export function isAnchorInView(
  rect: { top: number; height: number },
  view: { top: number; bottom: number },
): boolean {
  return rect.top >= view.top && rect.top + Math.min(rect.height, 48) <= view.bottom;
}
