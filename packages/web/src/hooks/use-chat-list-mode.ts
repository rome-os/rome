import type { ConciergeChatsResponse } from "@rome/api-types/concierge";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";
import { findCachedChatSession } from "@/hooks/use-chat-sessions";
import { CONCIERGE_CHATS_QUERY_KEY } from "@/hooks/use-concierge";
import { getSession } from "@/lib/chat-api";
import {
  type ChatListMode,
  chatListModeForRoute,
  readChatListMode,
  readLastOrdinaryChatId,
  subscribeChatListMode,
  writeChatListMode,
  writeLastOrdinaryChatId,
} from "@/lib/chat-list-mode";
import { activeSessionFromPath, type ChatKind, chatKind } from "@/lib/chat-session";

/** The stored mode, or null on a device that has not shown one. */
export function useStoredChatListMode(): ChatListMode | null {
  return useSyncExternalStore(subscribeChatListMode, readChatListMode, () => null);
}

/** The ordinary chat last opened on this device, or null. */
export function useLastOrdinaryChatId(): string | null {
  return useSyncExternalStore(subscribeChatListMode, readLastOrdinaryChatId, () => null);
}

/**
 * Moves the mode to the open chat's, once per navigation, and keeps the last
 * ordinary chat. Call it once, from the shell, which stays mounted while the
 * chat list comes and goes: a second caller would apply the same navigation
 * again and undo a switch the guardian made since. A guardian's own switch
 * between navigations stands.
 *
 * The open chat's kind comes from the chat lists and the Concierge's chats
 * this tab has loaded, else from the chat's own session, so a deep link with no
 * list loaded, such as on a phone, still moves the mode. The mode stays as it
 * was until that kind is known.
 */
export function useChatListFollowsRoute(mainChatId: string | null): void {
  const location = useLocation();
  const queryClient = useQueryClient();
  const openId = activeSessionFromPath(location.pathname, mainChatId);
  const loadedKind = (id: string): ChatKind | null => {
    const session = findCachedChatSession(queryClient, id);
    if (session) return chatKind(session, mainChatId);
    const topics = queryClient.getQueryData<ConciergeChatsResponse>(CONCIERGE_CHATS_QUERY_KEY);
    return topics?.chats.some((chat) => chat.id === id) ? "topic" : null;
  };
  const known = openId !== null ? loadedKind(openId) : null;
  const { data: fetched } = useQuery({
    queryKey: ["chat-list-route-session", openId],
    queryFn: () => getSession(openId as string),
    // The open chat reads its session through `getSession` outside React Query,
    // so this read is separate unless the two overlap, and then `getSession`
    // joins them.
    enabled: openId !== null && openId !== mainChatId && known === null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const route = chatListModeForRoute({
    pathname: location.pathname,
    state: location.state,
    mainChatId,
    kindOf: (id) =>
      id === openId ? (known ?? (fetched ? chatKind(fetched, mainChatId) : null)) : null,
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
