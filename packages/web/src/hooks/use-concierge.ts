import { useQuery } from "@tanstack/react-query";
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

export interface ConciergeChat {
  /** `CONCIERGE_CHAT_ID` once the chat exists, else null: Concierge is off or not loaded yet. */
  chatId: string | null;
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
  const { isSuccess, isPending } = useQuery({
    queryKey: ["concierge-session"],
    enabled,
    staleTime: 0,
    queryFn: ({ signal }) =>
      fetchJson<{ id: string }>("/api/concierge/session", { signal, fallback: "" }),
  });
  return {
    chatId: enabled && isSuccess ? CONCIERGE_CHAT_ID : null,
    loading: settingsPending || (enabled && isPending),
  };
}

/** The Concierge chat's id, or null while Concierge is off or not loaded yet. */
export function useConciergeChatId(): string | null {
  return useConciergeChat().chatId;
}
