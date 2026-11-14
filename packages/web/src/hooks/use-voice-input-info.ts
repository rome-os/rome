import { useQuery } from "@tanstack/react-query";
import type { VoiceInputInfo } from "@rome/api-types/voice-input";
import { fetchJson } from "@/lib/fetch-json";

/** Where the instance turns speech into text. `data.place` is null when it has no provider. */
export function useVoiceInputInfo() {
  return useQuery<VoiceInputInfo>({
    queryKey: ["voice-input"],
    // Config is read once at boot, so the answer changes only with a restart.
    staleTime: 5 * 60_000,
    queryFn: ({ signal }) =>
      fetchJson<VoiceInputInfo>("/api/voice-input", { signal, fallback: "" }),
  });
}
