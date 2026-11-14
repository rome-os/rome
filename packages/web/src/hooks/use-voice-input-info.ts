import { useQuery } from "@tanstack/react-query";
import type { VoiceInputInfo } from "@rome/api-types/voice-input";
import { fetchJson } from "@/lib/fetch-json";

/** Whether the instance has voice input, and where it turns speech into text. */
export function useVoiceInputInfo(options: { refetchOnMount?: "always" } = {}) {
  return useQuery<VoiceInputInfo>({
    ...options,
    queryKey: ["voice-input"],
    // Changes only with a restart or a Rome Cloud sign-in.
    staleTime: 5 * 60_000,
    queryFn: ({ signal }) =>
      fetchJson<VoiceInputInfo>("/api/voice-input", { signal, fallback: "" }),
  });
}
