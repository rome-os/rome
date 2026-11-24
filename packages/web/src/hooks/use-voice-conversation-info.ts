import { useQuery } from "@tanstack/react-query";
import type { VoiceConversationInfo } from "@rome/api-types/voice-conversation";
import { fetchJson } from "@/lib/fetch-json";

/** Whether this dashboard may hold a voice conversation: `voice_mode` on, for the guardian. */
export function useVoiceConversationInfo() {
  return useQuery<VoiceConversationInfo>({
    queryKey: ["voice-conversation"],
    // `voice_mode` is read live on the instance, so a flipped gate shows within a few minutes.
    staleTime: 5 * 60_000,
    queryFn: ({ signal }) =>
      fetchJson<VoiceConversationInfo>("/api/voice-conversation", { signal, fallback: "" }),
  });
}
