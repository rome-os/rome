import { type QueryClient, useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/fetch-json";
import { useSettings } from "@/hooks/use-settings";

/** The canonical id of the agent behind the Concierge chat. */
export const CONCIERGE_AGENT_ID = "core:concierge";
/** The Concierge chat's fixed id: the dashboard opens it at `/chat/concierge`. */
export const CONCIERGE_CHAT_ID = "concierge";
/** `triggerKind` of a task chat Concierge started. */
export const TASK_CHAT_TRIGGER_KIND = "concierge";
/** The setting that turns Concierge on, under Settings → Experimental. */
const EXPERIMENTAL_CONCIERGE_SETTING_KEY = "experimentalConcierge";
/** The Concierge chat and its unread count; invalidate it to recount. */
export const CONCIERGE_SESSION_QUERY_KEY = ["concierge-session"] as const;
/** The server stops counting unread messages here; the badge reads 99+ at it. */
export const CONCIERGE_UNREAD_CAP = 100;

interface ConciergeSession {
  id: string;
  /** Agent messages since the guardian last read the chat, at most {@link CONCIERGE_UNREAD_CAP}. */
  unread: number;
}

const conciergeSessionQuery = {
  queryKey: CONCIERGE_SESSION_QUERY_KEY,
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    fetchJson<ConciergeSession>("/api/concierge/session", { signal, fallback: "" }),
};

function useConciergeSession(enabled: boolean) {
  return useQuery({ ...conciergeSessionQuery, enabled, staleTime: 0 });
}

/**
 * Resolves once the server has created the Concierge chat, joining a request
 * already in flight and reusing a recent one. Rejects when the server cannot.
 */
export async function ensureConciergeChat(queryClient: QueryClient): Promise<void> {
  await queryClient.fetchQuery({ ...conciergeSessionQuery, staleTime: 10_000 });
}

export interface ConciergeChat {
  /** `CONCIERGE_CHAT_ID` once the chat exists, else null: Concierge is off or not loaded yet. */
  chatId: string | null;
  /** Whether Concierge is on. The chat may not exist yet; `ensureConciergeChat` waits for it. */
  enabled: boolean;
  /** Whether the setting is still loading, so `enabled` is not known yet. */
  settingsLoading: boolean;
  /** Whether the setting or the chat's creation is still in flight. */
  loading: boolean;
}

/**
 * The Concierge chat. The server creates it on the first request, and asks
 * again on every mount, which recreates a deleted chat.
 */
export function useConciergeChat(): ConciergeChat {
  const { data: settings, isPending: settingsPending } = useSettings();
  const enabled = settings?.[EXPERIMENTAL_CONCIERGE_SETTING_KEY] === true;
  const { isSuccess, isPending } = useConciergeSession(enabled);
  return {
    chatId: enabled && isSuccess ? CONCIERGE_CHAT_ID : null,
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
