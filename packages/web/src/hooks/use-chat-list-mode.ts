import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";
import { findCachedChatSession } from "@/hooks/use-chat-sessions";
import {
  type ChatListMode,
  chatListModeForRoute,
  readChatListMode,
  readLastOrdinaryChatId,
  subscribeChatListMode,
  writeChatListMode,
  writeLastOrdinaryChatId,
} from "@/lib/chat-list-mode";
import { type ChatKind, chatKind } from "@/lib/chat-session";

/** The stored mode, or null on a device that has not shown one. */
export function useStoredChatListMode(): ChatListMode | null {
  return useSyncExternalStore(subscribeChatListMode, readChatListMode, () => null);
}

/** The ordinary chat last opened on this device, or null. */
export function useLastOrdinaryChatId(): string | null {
  return useSyncExternalStore(subscribeChatListMode, readLastOrdinaryChatId, () => null);
}

/**
 * Moves the stored mode to the open chat's, once per navigation, and keeps the
 * last ordinary chat. A guardian's own switch between navigations stands.
 * `kindOf` may answer null while the chat's list loads: the hook asks again
 * when it changes identity, and does nothing until the chat's kind is known.
 */
export function useChatListFollowsRoute(
  mainChatId: string | null,
  kindOf: (id: string) => ChatKind | null,
): void {
  const location = useLocation();
  const route = chatListModeForRoute({
    pathname: location.pathname,
    state: location.state,
    mainChatId,
    kindOf,
  });
  const applied = useRef<string | null>(null);
  const routeKey = `${location.key}:${location.pathname}`;
  const mode = route?.mode;
  const ordinaryChatId = route?.ordinaryChatId;
  useEffect(() => {
    if (!mode || applied.current === routeKey) return;
    applied.current = routeKey;
    writeChatListMode(mode);
    if (ordinaryChatId) writeLastOrdinaryChatId(ordinaryChatId);
  }, [mode, ordinaryChatId, routeKey]);
}

/**
 * {@link useChatListFollowsRoute} for a caller with no chat list of its own: it
 * reads the lists this tab has already loaded, and does not follow a chat
 * that none of them holds.
 */
export function useChatListFollowsRouteFromCache(mainChatId: string | null): void {
  const queryClient = useQueryClient();
  useChatListFollowsRoute(mainChatId, (id) => {
    const session = findCachedChatSession(queryClient, id);
    return session ? chatKind(session, mainChatId) : null;
  });
}

/**
 * The mode for a caller that is not the chat list, such as the rail and the
 * new-chat shortcut. With the Concierge known to be unavailable it is Chat.
 * On a device that has not shown a mode it is `whenUnset`, which keeps what
 * the caller did before the switch existed.
 */
export function useChatListModeForShell(
  conciergeAvailable: boolean,
  whenUnset: ChatListMode,
): ChatListMode {
  const stored = useStoredChatListMode();
  return conciergeAvailable ? (stored ?? whenUnset) : "chat";
}
