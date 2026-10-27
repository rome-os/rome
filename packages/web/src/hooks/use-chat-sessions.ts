import {
  keepPreviousData,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { listSessions, type SessionScope, type SessionStatusFilter } from "@/lib/chat-api";
import type { ChatSession } from "@/lib/chat-types";
import { CHAT_SESSIONS_CHANGED_EVENT } from "@/lib/session-events";

/** Prefix shared by every filter's list, so one invalidation reaches them all. */
const CHAT_SESSIONS_QUERY_KEY = ["chat-sessions"] as const;

const pendingInvalidations = new WeakMap<QueryClient, Promise<void>>();

/**
 * Refetches the active chat lists. Calls made in the same tick share one
 * invalidation: a stop event reaches the sidebar and a task card together, and
 * a read mark can emit several events in a row, and none of them needs its own
 * round trip.
 */
function invalidateChatSessions(queryClient: QueryClient): Promise<void> {
  const pending = pendingInvalidations.get(queryClient);
  if (pending) return pending;
  const run = Promise.resolve().then(() => {
    pendingInvalidations.delete(queryClient);
    return queryClient.invalidateQueries({ queryKey: CHAT_SESSIONS_QUERY_KEY });
  });
  pendingInvalidations.set(queryClient, run);
  return run;
}

/**
 * The one window listener per client that turns a sessions-changed event into
 * an invalidation, and how many `useChatSessions` consumers hold it. One
 * invalidation reaches every list under the prefix, so a listener per consumer
 * would refetch each list once per mounted consumer.
 */
const sessionsChangedSubscriptions = new WeakMap<
  QueryClient,
  { count: number; stop: () => void }
>();

function retainSessionsChangedInvalidation(queryClient: QueryClient): () => void {
  let subscription = sessionsChangedSubscriptions.get(queryClient);
  if (!subscription) {
    const listener = () => {
      void invalidateChatSessions(queryClient);
    };
    window.addEventListener(CHAT_SESSIONS_CHANGED_EVENT, listener);
    subscription = {
      count: 0,
      stop: () => window.removeEventListener(CHAT_SESSIONS_CHANGED_EVENT, listener),
    };
    sessionsChangedSubscriptions.set(queryClient, subscription);
  }
  subscription.count += 1;
  const held = subscription;
  return () => {
    held.count -= 1;
    if (held.count > 0) return;
    held.stop();
    sessionsChangedSubscriptions.delete(queryClient);
  };
}

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
    queryFn: ({ signal }) => listSessions(status, scope, signal),
    staleTime: 0,
    gcTime: Number.POSITIVE_INFINITY,
    placeholderData: keepPreviousData,
  });

  const invalidate = useCallback(() => invalidateChatSessions(queryClient), [queryClient]);
  useEffect(() => retainSessionsChangedInvalidation(queryClient), [queryClient]);

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
