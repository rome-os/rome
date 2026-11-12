/** How long the thread view fades in and out, in ms. Matches `[data-chat-thread-fade]` in globals.css. */
export const THREAD_FADE_MS = 180;

/** How long a message the reader lands on keeps its tint (`[data-timeline-landed]` in globals.css). */
export const LANDING_MS = 900;

/**
 * Tints `anchor` from no tint, so the tint plays even on a message still
 * tinted from the last time, as when a thread closes again within
 * `LANDING_MS`. Setting the mark on a message that has it changes nothing,
 * so the tint is first dropped at once, with no transition.
 */
export function playLanding(anchor: HTMLElement): void {
  if (anchor.hasAttribute("data-timeline-landed")) {
    const transition = anchor.style.transition;
    anchor.style.transition = "none";
    anchor.removeAttribute("data-timeline-landed");
    // Reading a size applies the untinted style before the transition returns.
    void anchor.offsetWidth;
    anchor.style.transition = transition;
  }
  anchor.setAttribute("data-timeline-landed", "");
}

/**
 * Every bubble of message `messageId` under `root`: its anchor, the first,
 * and the later ones that name it as theirs. Landing on a message tints all.
 */
export function messageBubbles(root: ParentNode, messageId: string): HTMLElement[] {
  const bubbles = new Set<HTMLElement>();
  for (const element of root.querySelectorAll<HTMLElement>("[data-timeline-anchor]")) {
    if (element.dataset.timelineAnchor?.split(" ").includes(messageId)) bubbles.add(element);
  }
  for (const element of root.querySelectorAll<HTMLElement>("[data-message-part]")) {
    if (element.dataset.messagePart === messageId) bubbles.add(element);
  }
  return [...bubbles];
}

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
