import { useEffect, useRef } from "react";

/** Fired on `window` once the server deleted a webchat session; `detail` is its id. */
const SESSION_DELETED_EVENT = "rome:chat-session-deleted";

/**
 * Broadcast that a session is gone. Whatever kept that session's chat alive
 * (the Concierge, whose id is fixed and comes back empty) lets go of it.
 */
export function emitSessionDeleted(sessionId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>(SESSION_DELETED_EVENT, { detail: sessionId }));
}

/** Calls `handler` with the id of each session deleted while the component is mounted. */
export function useSessionDeleted(handler: (sessionId: string) => void): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);
  useEffect(() => {
    const listener = (event: Event) => handlerRef.current((event as CustomEvent<string>).detail);
    window.addEventListener(SESSION_DELETED_EVENT, listener);
    return () => window.removeEventListener(SESSION_DELETED_EVENT, listener);
  }, []);
}
