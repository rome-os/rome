import type { ConciergeChatDto, ConciergeChatsResponse } from "@rome/api-types/concierge";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/fetch-json";
import { useSettings } from "@/hooks/use-settings";

/** The canonical id of the agent behind the Concierge chat. */
export const CONCIERGE_AGENT_ID = "core:concierge";
/** The guardian's main Concierge chat's id. A visitor's main chat has its own, which the server answers. */
export const CONCIERGE_CHAT_ID = "concierge";
/** `triggerKind` of a task chat Concierge started. */
export const TASK_CHAT_TRIGGER_KIND = "concierge";
/** The setting that turns Concierge on, under Settings → Experimental. */
const EXPERIMENTAL_CONCIERGE_SETTING_KEY = "experimentalConcierge";
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

function useConciergeSession(enabled: boolean) {
  return useQuery({ ...conciergeSessionQuery, enabled, staleTime: 0 });
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
  /** The signed-in person's main Concierge chat once it exists, else null: Concierge is off or not loaded yet. */
  chatId: string | null;
  /** Whether Concierge is on. The chat may not exist yet; `ensureConciergeChat` waits for it. */
  enabled: boolean;
  /** Whether the setting is still loading, so `enabled` is not known yet. */
  settingsLoading: boolean;
  /** Whether the setting or the chat's creation is still in flight. */
  loading: boolean;
}

/**
 * The signed-in person's main Concierge chat. The server creates it on the
 * first request, and asks again on every mount, which recreates a deleted chat.
 */
export function useConciergeChat(): ConciergeChat {
  const { data: settings, isPending: settingsPending } = useSettings();
  const enabled = settings?.[EXPERIMENTAL_CONCIERGE_SETTING_KEY] === true;
  const { data, isSuccess, isPending } = useConciergeSession(enabled);
  return {
    chatId: enabled && isSuccess ? data.id : null,
    enabled,
    settingsLoading: settingsPending,
    loading: settingsPending || (enabled && isPending),
  };
}

/** The Concierge chat's id, or null while Concierge is off or not loaded yet. */
export function useConciergeChatId(): string | null {
  return useConciergeChat().chatId;
}

/** How many agent messages the Concierge chat got since it was last read; 0 while `chatId` is null. */
export function useConciergeUnread(chatId: string | null): number {
  return useConciergeSession(chatId !== null).data?.unread ?? 0;
}

/**
 * The Concierge chats: the main chat first, then the topic chats, each with
 * its unread count. Empty while Concierge is off or the list is loading.
 */
export function useConciergeChats(): ConciergeChatDto[] {
  const { enabled } = useConciergeChat();
  const { data } = useQuery({
    queryKey: CONCIERGE_CHATS_QUERY_KEY,
    queryFn: ({ signal }) =>
      fetchJson<ConciergeChatsResponse>("/api/concierge/chats", { signal, fallback: "" }),
    enabled,
    staleTime: 0,
  });
  return enabled ? (data?.chats ?? []) : [];
}

/** Starts an untitled topic chat, which its first message names, and answers it. */
export async function startConciergeTopicChat(): Promise<ConciergeChatDto> {
  return fetchJson<ConciergeChatDto>("/api/concierge/chats", {
    method: "POST",
    json: {},
    fallback: "",
  });
}
