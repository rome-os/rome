import {
  keepPreviousData,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  CHAT_SESSION_DELETED_EVENT,
  listSessions,
  type SessionScope,
  type SessionStatusFilter,
} from "@/lib/chat-api";
import type { ChatSession } from "@/lib/chat-types";
import { LIVE_QUERY_OPTIONS } from "@/lib/query-client";
import { CHAT_SESSIONS_CHANGED_EVENT } from "@/lib/session-events";

/** Prefix shared by every filter's list, so one invalidation reaches them all. */
const CHAT_SESSIONS_QUERY_KEY = ["chat-sessions"] as const;

/**
 * The chat with this id from any chat list this tab has loaded, whatever its
 * filter, or undefined when none holds it. Never fetches.
 */
export function findCachedChatSession(
  queryClient: QueryClient,
  id: string,
): ChatSession | undefined {
  for (const [, list] of queryClient.getQueriesData<ChatSession[]>({
    queryKey: CHAT_SESSIONS_QUERY_KEY,
  })) {
    const found = list?.find((session) => session.id === id);
    if (found) return found;
  }
  return undefined;
}

/**
 * False when the lists this tab has loaded show the chat is gone: it is in none
 * of them, and one of them is not the archived list, which does not hold a
 * chat that is not archived. True when a list holds it, and when no list can
 * say. Never fetches.
 */
function chatSessionMayExist(queryClient: QueryClient, id: string): boolean {
  let proves = false;
  for (const [key, list] of queryClient.getQueriesData<ChatSession[]>({
    queryKey: CHAT_SESSIONS_QUERY_KEY,
  })) {
    if (!list) continue;
    if (list.some((session) => session.id === id)) return true;
    if (key[1] !== "archived") proves = true;
  }
  return !proves;
}

/** {@link chatSessionMayExist}, kept current as this tab's chat lists change. True for no id. */
export function useChatSessionMayExist(id: string | null): boolean {
  const queryClient = useQueryClient();
  // Holds the deletion listener, so a delete reaches every cached list while the
  // rail shows even when no list is on screen.
  useEffect(() => retainSessionsChangedInvalidation(queryClient), [queryClient]);
  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange),
    [queryClient],
  );
  return useSyncExternalStore(
    subscribe,
    () => id === null || chatSessionMayExist(queryClient, id),
    () => true,
  );
}

/**
 * Marks chat `id` read in every cached chat list, the only field a read mark
 * changes, so no list is fetched again for it.
 */
export function markChatSessionReadInCache(queryClient: QueryClient, id: string): void {
  queryClient.setQueriesData<ChatSession[]>({ queryKey: CHAT_SESSIONS_QUERY_KEY }, (list) =>
    list?.some((session) => session.id === id && session.unread)
      ? list.map((session) => (session.id === id ? { ...session, unread: false } : session))
      : list,
  );
}

const pendingInvalidations = new WeakMap<QueryClient, Promise<void>>();

/**
 * Refetches the active chat lists. Calls made in the same tick share one
 * invalidation: a stop event reaches the sidebar and a task card together, and
 * a read mark can emit several events in a row, and none of them needs its own
 * round trip.
 */
export function invalidateChatSessions(queryClient: QueryClient): Promise<void> {
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
 * The one pair of window listeners per client, and how many consumers hold
 * them. One turns a sessions-changed event into an invalidation, which reaches
 * every list under the prefix, so a listener per consumer would refetch each
 * list once per mounted consumer. The other drops a deleted chat from every
 * cached list, since a delete edits only the list on screen and an invalidation
 * refetches only the lists in use.
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
    const onDeleted = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      queryClient.setQueriesData<ChatSession[]>({ queryKey: CHAT_SESSIONS_QUERY_KEY }, (list) =>
        list?.filter((session) => session.id !== id),
      );
    };
    window.addEventListener(CHAT_SESSIONS_CHANGED_EVENT, listener);
    window.addEventListener(CHAT_SESSION_DELETED_EVENT, onDeleted);
    subscription = {
      count: 0,
      stop: () => {
        window.removeEventListener(CHAT_SESSIONS_CHANGED_EVENT, listener);
        window.removeEventListener(CHAT_SESSION_DELETED_EVENT, onDeleted);
      },
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

function chatSessionsQueryKey(status: SessionStatusFilter, scope: SessionScope | undefined) {
  return [...CHAT_SESSIONS_QUERY_KEY, status, scope ?? "default"] as const;
}

/**
 * The sidebar's chat list, cached across mounts. The list unmounts whenever
 * the guardian leaves Chat or collapses it, so a remount shows the cached rows
 * at once, and refetches behind them once they are older than
 * {@link LIVE_QUERY_OPTIONS}' staleTime; a change made here or a live event
 * invalidates them sooner. A filter change keeps
 * the previous rows until the new list lands. Lists stay cached for the tab's
 * lifetime (`gcTime: Infinity`), since there are at most one per filter and
 * scope, so a long time away from Chat still comes back to rows.
 *
 * Without a `scope` the server's default applies. `enabled: false` holds the
 * fetch back, for a consumer that only needs the list while something is open.
 * `refetchOnShow` reads the list again each time it mounts or is enabled,
 * whatever its age, for a view whose live updates stop while it is not shown,
 * such as the sidebar and the search dialog.
 */
export function useChatSessions(
  status: SessionStatusFilter,
  scope: SessionScope | undefined,
  { enabled = true, refetchOnShow = false }: { enabled?: boolean; refetchOnShow?: boolean } = {},
) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: chatSessionsQueryKey(status, scope),
    queryFn: ({ signal }) => listSessions(status, scope, signal),
    enabled,
    ...LIVE_QUERY_OPTIONS,
    ...(refetchOnShow ? { staleTime: 0 } : {}),
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

/** The list `useChatSession` falls back on, which holds every chat. */
const ALL_CHATS_KEY = chatSessionsQueryKey("all", "all");
const isAllChatsKey = (key: readonly unknown[]) =>
  key.length === ALL_CHATS_KEY.length && key.every((part, i) => part === ALL_CHATS_KEY[i]);

/**
 * Chat `id` from a list this tab holds other than the list of every chat, or
 * "loading" while such a list is on its first read and may still hold it.
 */
function chatSessionElsewhere(
  queryClient: QueryClient,
  id: string,
): ChatSession | "loading" | null {
  let loading = false;
  for (const query of queryClient.getQueryCache().findAll({ queryKey: CHAT_SESSIONS_QUERY_KEY })) {
    if (isAllChatsKey(query.queryKey)) continue;
    const list = query.state.data as ChatSession[] | undefined;
    const found = list?.find((session) => session.id === id);
    if (found) return found;
    if (list === undefined && query.state.fetchStatus === "fetching") loading = true;
  }
  return loading ? "loading" : null;
}

/**
 * One chat's row, for a view that shows one chat. It reads the lists this tab
 * already holds, such as the sidebar's, and keeps the list of every chat
 * (`all`, `all`) only when none of them holds the chat once they have loaded:
 * an archived chat, or no list loaded at all.
 */
export function useChatSession(id: string) {
  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange),
    [queryClient],
  );
  const elsewhere = useSyncExternalStore(
    subscribe,
    () => chatSessionElsewhere(queryClient, id),
    () => "loading" as const,
  );
  const { sessions, invalidate } = useChatSessions("all", "all", { enabled: elsewhere === null });
  return {
    session:
      elsewhere && elsewhere !== "loading"
        ? elsewhere
        : sessions?.find((session) => session.id === id),
    invalidate,
  };
}
