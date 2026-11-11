import type { ConciergeChatDto, ConciergeChatsResponse } from "@rome/api-types/concierge";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { invalidateChatSessions } from "@/hooks/use-chat-sessions";
import { fetchJson } from "@/lib/fetch-json";
import { useSettings } from "@/hooks/use-settings";
import { mainAgentDisplayName } from "@/lib/agent-name";

export { CONCIERGE_AGENT_ID, TASK_CHAT_TRIGGER_KIND } from "@/lib/chat-session";
/** The guardian's main Concierge chat's id. A visitor's main chat has its own, which the server answers. */
export const CONCIERGE_CHAT_ID = "concierge";
/** The Concierge chat and its unread count; invalidate it to recount. */
export const CONCIERGE_SESSION_QUERY_KEY = ["concierge-session"] as const;
/** The Concierge chats, main first, with their unread counts; invalidate it to recount. */
export const CONCIERGE_CHATS_QUERY_KEY = ["concierge-chats"] as const;
/** The server stops counting unread messages here; the badge reads 99+ at it. */
export const CONCIERGE_UNREAD_CAP = 100;

interface ConciergeSession {
  /** The signed-in person's main Concierge chat. */
  id: string;
  /** Agent messages since it was last read, at most {@link CONCIERGE_UNREAD_CAP}. */
  unread: number;
}

let timeZoneReported = false;

/**
 * Tells the server this browser's time zone once per page load, so a
 * visitor's digest times and quiet hours read in their own zone.
 */
function reportTimeZone(): void {
  if (timeZoneReported) return;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!timeZone) return;
  timeZoneReported = true;
  void fetchJson<void>("/api/concierge/timezone", {
    method: "PUT",
    json: { timeZone },
    fallback: "",
  }).catch(() => {
    timeZoneReported = false;
  });
}

const conciergeSessionQuery = {
  queryKey: CONCIERGE_SESSION_QUERY_KEY,
  queryFn: async ({ signal }: { signal: AbortSignal }) => {
    const session = await fetchJson<ConciergeSession>("/api/concierge/session", {
      signal,
      fallback: "",
    });
    reportTimeZone();
    return session;
  },
};

function useConciergeSession(enabled = true) {
  return useQuery({ ...conciergeSessionQuery, enabled, staleTime: 0 });
}

/**
 * The main Concierge chat's id when it is already loaded, else null. It never
 * asks the server, for a caller that only needs the id when it is there, and
 * can open `/chat/<id>`, which still reaches the chat, when it is not.
 */
export function loadedConciergeChatId(queryClient: QueryClient): string | null {
  return queryClient.getQueryData<ConciergeSession>(CONCIERGE_SESSION_QUERY_KEY)?.id ?? null;
}

/**
 * Resolves with the main Concierge chat's id once the server has created it,
 * joining a request already in flight and reusing a recent one. Rejects when
 * the server cannot.
 */
export async function ensureConciergeChat(queryClient: QueryClient): Promise<string> {
  return (await queryClient.fetchQuery({ ...conciergeSessionQuery, staleTime: 10_000 })).id;
}

export interface ConciergeChat {
  /** The signed-in person's main Concierge chat once it exists, else null: not loaded yet. `ensureConciergeChat` waits for it. */
  chatId: string | null;
  /** Whether the chat's creation is still in flight. */
  loading: boolean;
  /** Whether the first load failed, so there is no chat to show, such as when the Concierge is off. A failed refetch after a success is not a failure. */
  failed: boolean;
  /** Asks the server again after a failure. */
  retry: () => void;
}

/**
 * The signed-in person's main Concierge chat. The server creates it on the
 * first request, and asks again on every mount, which recreates a deleted chat.
 * With `enabled` false it only reads what is already loaded.
 */
export function useConciergeChat(enabled = true): ConciergeChat {
  const { data, isPending, isError, refetch } = useConciergeSession(enabled);
  // A failed refetch keeps the data it had, with an error status. The chat it
  // names still exists, so only a first load that failed counts as failed.
  return {
    chatId: data?.id ?? null,
    loading: isPending,
    failed: isError && data === undefined,
    retry: () => void refetch(),
  };
}

/**
 * What the dashboard calls the Concierge: the name the guardian gave their
 * agent, else the main agent's default name. A main Concierge chat shows it in
 * place of the session name the server stores.
 */
export function useConciergeName(): string {
  return mainAgentDisplayName(useSettings().data?.agentName);
}

/** The Concierge chat's id, or null while it is not loaded yet. */
export function useConciergeChatId(): string | null {
  return useConciergeChat().chatId;
}

/** How many agent messages the Concierge chat got since it was last read; 0 while `chatId` is null. */
export function useConciergeUnread(chatId: string | null): number {
  return useConciergeSession(chatId !== null).data?.unread ?? 0;
}

/**
 * The Concierge chats: the main chat first, then the topic chats, each with
 * its unread count. Empty while the list is loading. Like the chat list, it
 * stays cached for the tab's lifetime (`gcTime: Infinity`), so the sidebar's
 * topic chats show at once after a long time away from Chat, and every mount
 * still refetches behind them (`staleTime: 0`).
 */
export function useConciergeChats(): ConciergeChatDto[] {
  const { data } = useQuery({
    queryKey: CONCIERGE_CHATS_QUERY_KEY,
    queryFn: ({ signal }) =>
      fetchJson<ConciergeChatsResponse>("/api/concierge/chats", { signal, fallback: "" }),
    staleTime: 0,
    gcTime: Number.POSITIVE_INFINITY,
  });
  return data?.chats ?? [];
}

/**
 * Refetches both lists a topic chat's row reads: the Concierge's own list,
 * which carries names and unread counts, and the chat list, which carries
 * activity times and the archived topic chats. Call it after anything that
 * changes a topic chat, so the two never disagree about one.
 */
export function refreshTopicChats(queryClient: QueryClient): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: CONCIERGE_CHATS_QUERY_KEY }),
    invalidateChatSessions(queryClient),
  ]).then(() => undefined);
}

/** {@link refreshTopicChats} bound to this component's query client. */
export function useRefreshTopicChats(): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => void refreshTopicChats(queryClient), [queryClient]);
}

/** Starts an untitled topic chat, which its first message names, and answers it. */
export async function startConciergeTopicChat(): Promise<ConciergeChatDto> {
  return fetchJson<ConciergeChatDto>("/api/concierge/chats", {
    method: "POST",
    json: {},
    fallback: "",
  });
}
