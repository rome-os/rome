// The Tasks panel and the Concierge transcript are separate trees, so the panel
// asks for a jump with a window event and the chat answers it.

const CONCIERGE_JUMP_EVENT = "rome:concierge-jump";

interface JumpDetail {
  messageId: string;
  /** Called once the chat landed on the message, or found it is not there. */
  done: (landed: boolean) => void;
  /** Set by a chat that takes the request. */
  taken?: boolean;
}

/**
 * Asks the open Concierge chat to scroll to a message and highlight it.
 * Resolves whether it landed there; false at once when no chat takes it.
 */
export function requestConciergeJump(messageId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const detail: JumpDetail = { messageId, done: resolve };
    window.dispatchEvent(new CustomEvent(CONCIERGE_JUMP_EVENT, { detail }));
    if (!detail.taken) resolve(false);
  });
}

/** Listens for jump requests; `handler` resolves whether it landed. Returns the unsubscribe. */
export function onConciergeJump(handler: (messageId: string) => Promise<boolean>): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<JumpDetail>).detail;
    detail.taken = true;
    void handler(detail.messageId).then(detail.done, () => detail.done(false));
  };
  window.addEventListener(CONCIERGE_JUMP_EVENT, listener);
  return () => window.removeEventListener(CONCIERGE_JUMP_EVENT, listener);
}
