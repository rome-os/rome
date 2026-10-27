import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { listSessions, type SessionScope, type SessionStatusFilter } from "@/lib/chat-api";
import type { ChatSession } from "@/lib/chat-types";
import { useSessionsChanged } from "@/lib/session-events";

/** Prefix shared by every filter's list, so one invalidation reaches them all. */
const CHAT_SESSIONS_QUERY_KEY = ["chat-sessions"] as const;

function chatSessionsQueryKey(status: SessionStatusFilter, scope: SessionScope) {
  return [...CHAT_SESSIONS_QUERY_KEY, status, scope] as const;
}

/**
 * The sidebar's chat list, cached across mounts. The list unmounts whenever
 * the guardian leaves Chat or collapses it, so a remount shows the cached rows
 * at once and refetches behind them (`staleTime: 0`). A filter change keeps
 * the previous rows until the new list lands. Lists stay cached for the tab's
 * lifetime (`gcTime: Infinity`), since there are at most one per filter and
 * scope, so a long time away from Chat still comes back to rows.
 */
export function useChatSessions(status: SessionStatusFilter, scope: SessionScope) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: chatSessionsQueryKey(status, scope),
    queryFn: () => listSessions(status, scope),
    staleTime: 0,
    gcTime: Number.POSITIVE_INFINITY,
    placeholderData: keepPreviousData,
  });

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: CHAT_SESSIONS_QUERY_KEY }),
    [queryClient],
  );
  useSessionsChanged(() => {
    void invalidate();
  });

  // Edits the cached list of the current filter. A placeholder list belongs to
  // another filter, so there is nothing to edit until this one lands.
  const update = useCallback(
    (fn: (prev: ChatSession[]) => ChatSession[]) => {
      queryClient.setQueryData<ChatSession[]>(chatSessionsQueryKey(status, scope), (prev) =>
        prev ? fn(prev) : prev,
      );
    },
    [queryClient, status, scope],
  );

  return {
    sessions: query.data,
    isError: query.isError,
    refetch: query.refetch,
    invalidate,
    update,
  };
}
