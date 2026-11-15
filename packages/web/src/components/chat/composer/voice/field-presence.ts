import type { BehaviorContext } from "./behavior";

/** The page the field is on. */
export interface PageEvents {
  /** Calls `hidden` each time the page goes away: a reload, a close, or a move into the back/forward cache. Returns the cleanup. */
  onHide(hidden: () => void): () => void;
}

export type LeaveReason = "left-chat" | "page-reloaded";

/**
 * Knows whether the guardian still sees the field of this chat. `hidden` fires
 * when something covers the field for a while, as a card lock does, and
 * `left` when the field goes for good: the page goes away, or the guardian
 * opens another chat, which destroys the field.
 */
export function createFieldPresence<State>(
  context: BehaviorContext<State>,
  options: {
    page: PageEvents;
    hidden: () => void;
    left: (reason: LeaveReason) => void;
  },
) {
  const stopWatching = options.page.onHide(() => options.left("page-reloaded"));
  context.onDestroy(() => {
    stopWatching();
    options.left("left-chat");
  });
  return {
    /** Call with whether the field shows. */
    shown(visible: boolean) {
      if (!visible) options.hidden();
    },
  };
}
