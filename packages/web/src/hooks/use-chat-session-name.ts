import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getSession } from "@/lib/chat-api";
import { useSessionsChanged } from "@/lib/session-events";

/**
 * The name of the open chat, or null while it loads and for a session id that
 * names nothing. Refetches on {@link CHAT_SESSIONS_CHANGED_EVENT}, so a rename
 * reaches every consumer without a reload.
 */
export function useChatSessionName(sessionId: string | null): string | null {
  const queryClient = useQueryClient();
  const queryKey = ["chat-session-name", sessionId] as const;
  const { data } = useQuery({
    queryKey,
    enabled: sessionId !== null && sessionId.length > 0,
    // A name is cheap to be slightly stale: the rename event below is what
    // keeps it honest, not the clock.
    staleTime: 5 * 60_000,
    queryFn: () => getSession(sessionId as string),
  });
  useSessionsChanged(() => {
    void queryClient.invalidateQueries({ queryKey });
  });
  return data?.name ?? null;
}
