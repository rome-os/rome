import { useQuery } from "@tanstack/react-query";
import type { VoiceConversationInfo } from "@rome/api-types/voice-conversation";
import { fetchJson } from "@/lib/fetch-json";

/** Whether this dashboard may hold a voice conversation: the guardian, on Rome Cloud's voice input list. */
export function useVoiceConversationInfo() {
  return useQuery<VoiceConversationInfo>({
    queryKey: ["voice-conversation"],
    // Rome Cloud's list is read live, so a change shows within a few minutes.
    staleTime: 5 * 60_000,
    queryFn: ({ signal }) =>
      fetchJson<VoiceConversationInfo>("/api/voice-conversation", { signal, fallback: "" }),
  });
}
