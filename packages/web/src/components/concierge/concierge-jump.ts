// The task panel and the Concierge transcript are separate trees, so the panel
// asks for a jump with a window event and the chat answers it.

const CONCIERGE_JUMP_EVENT = "rome:concierge-jump";

/** Asks the open Concierge chat to scroll to a message and highlight it. */
export function requestConciergeJump(messageId: string): void {
  window.dispatchEvent(new CustomEvent(CONCIERGE_JUMP_EVENT, { detail: { messageId } }));
}

/** Listens for jump requests. Returns the unsubscribe. */
export function onConciergeJump(handler: (messageId: string) => void): () => void {
  const listener = (event: Event) => {
    const { messageId } = (event as CustomEvent<{ messageId: string }>).detail;
    handler(messageId);
  };
  window.addEventListener(CONCIERGE_JUMP_EVENT, listener);
  return () => window.removeEventListener(CONCIERGE_JUMP_EVENT, listener);
}
