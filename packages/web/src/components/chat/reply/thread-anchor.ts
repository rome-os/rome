/** How long a message the reader lands on keeps its tint (`[data-timeline-landed]` in globals.css). */
export const LANDING_MS = 900;

/**
 * Tints `anchor` from no tint, so the tint plays even on a message still
 * tinted from the last time, as when a thread opens again within
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
