import type { QueryClient } from "@tanstack/react-query";
import { CONCIERGE_PAGE_TURNS, CHAT_PAGE_TURNS } from "@/components/chat/use-older-messages";
import { CONCIERGE_CHAT_ID } from "@/hooks/use-concierge";
import { settingsQueryOptions } from "@/hooks/use-settings";
import { AUTH_QUERY_KEY, fetchAuthState } from "./auth-state";
import { primeChatOpenReads } from "./chat-api";

/**
 * The session id a `/chat/<id>` address opens, or null for the chat home, a
 * draft (`/chat/new`) or any other route.
 */
export function chatSessionIdFromPath(pathname: string): string | null {
  const match = /^\/chat\/([^/]+)/.exec(pathname);
  if (!match || match[1] === "new") return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** Whether the address lands on the chat route, which `/` redirects to. */
export function isChatPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/chat" || pathname.startsWith("/chat/");
}

/**
 * Starts the first screen's network work before React renders, so it overlaps
 * the locale download instead of following the first commit:
 *
 * - the auth probe and the settings read, into the cache `AuthGate` and
 *   `useSettings` read from;
 * - on a chat address, the chat route's code and the open session's reads.
 *
 * Every request here is one the screen makes anyway. None of it is awaited and
 * none of it can fail the render: a signed-out visitor gets a 401 that the
 * auth flow handles as before.
 */
export function startEntryPrefetch(
  pathname: string,
  client: QueryClient,
  loadChatRoute: () => Promise<unknown>,
): void {
  void client.prefetchQuery({
    queryKey: AUTH_QUERY_KEY,
    queryFn: ({ signal }) => fetchAuthState({ signal }),
    staleTime: Infinity,
  });
  void client.prefetchQuery(settingsQueryOptions);
  if (!isChatPath(pathname)) return;
  loadChatRoute().catch(() => {
    // Suspense asks for the chunk again on render and reports the failure there.
  });
  const sessionId = chatSessionIdFromPath(pathname);
  if (sessionId) {
    primeChatOpenReads(
      sessionId,
      sessionId === CONCIERGE_CHAT_ID ? CONCIERGE_PAGE_TURNS : CHAT_PAGE_TURNS,
    );
  }
}
