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

/** A jump waiting for another Concierge chat to open. */
let deferred: { chatId: string; messageId: string } | null = null;

/** Keeps a jump for when Concierge chat `chatId` opens, as when the panel sends the guardian to it. */
export function deferConciergeJump(chatId: string, messageId: string): void {
  deferred = { chatId, messageId };
}

/** The message a jump waits to show in `chatId`, once: null when none waits for it. */
export function takeConciergeJump(chatId: string): string | null {
  if (deferred?.chatId !== chatId) return null;
  const { messageId } = deferred;
  deferred = null;
  return messageId;
}
