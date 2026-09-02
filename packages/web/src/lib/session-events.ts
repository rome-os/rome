import { useCallback, useEffect, useRef } from "react";
import { archiveSession, pinSession } from "@/lib/chat-api";

/**
 * Fired whenever the set of webchat sessions changes — created, renamed, moved,
 * pinned/unpinned, archived/unarchived, deleted, or marked read. Listeners (the
 * sidebar list, the open chat's identity) refetch on it so every view reconciles
 * to server truth.
 *
 * Lives here (a plain lib module) rather than inside a UI shell so no consumer
 * has to import a component just to get the string.
 */
export const CHAT_SESSIONS_CHANGED_EVENT = "rome:chat-sessions-changed";

/** Broadcast that the webchat session set changed. */
export function emitSessionsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CHAT_SESSIONS_CHANGED_EVENT));
  // The Sessions view also runs inside a same-origin app iframe (AppWidget
  // renders /full/apps/sessions/<id>), and the sidebar listens on the top
  // window. Without this hop, a branch promoted while its widget is open
  // never appears in the sidebar until an unrelated refresh.
  if (window.parent !== window) {
    window.parent.dispatchEvent(new CustomEvent(CHAT_SESSIONS_CHANGED_EVENT));
  }
}

/**
 * Subscribe to {@link CHAT_SESSIONS_CHANGED_EVENT} for the component's lifetime.
 * The listener is registered once; the latest `handler` is always invoked via a
 * ref, so callers may pass a fresh closure each render without re-subscribing or
 * needing to memoize it.
 */
export function useSessionsChanged(handler: () => void): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const listener = () => handlerRef.current();
    window.addEventListener(CHAT_SESSIONS_CHANGED_EVENT, listener);
    return () => window.removeEventListener(CHAT_SESSIONS_CHANGED_EVENT, listener);
  }, []);
}

/**
 * The single archive/unarchive mutation path: PATCH the session, then broadcast
 * {@link CHAT_SESSIONS_CHANGED_EVENT} so the sidebar and any open chat reconcile.
 * Callers keep their own optimistic UI. The returned function is stable across
 * renders and rejects if the PATCH fails (so callers can roll back).
 */
export function useArchiveSession(): (id: string, archived: boolean) => Promise<void> {
  return useCallback(async (id: string, archived: boolean) => {
    await archiveSession(id, archived);
    emitSessionsChanged();
  }, []);
}

/** The server-backed pin/unpin mutation path plus the shared refetch event. */
export function usePinSession(): (id: string, pinned: boolean) => Promise<void> {
  return useCallback(async (id: string, pinned: boolean) => {
    await pinSession(id, pinned);
    emitSessionsChanged();
  }, []);
}
