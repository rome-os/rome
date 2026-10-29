import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { aiToolsStatusSchema } from "@rome/api-types/ai-tools";
import { fetchJson } from "@/lib/fetch-json";
import { aiToolsStatusTopic, useLiveEvents } from "./use-live-events";

export const AI_TOOL_STATUS_QUERY_KEY = ["ai-tools", "status"] as const;

/** Login polling reads only Rome's cache, never a provider endpoint. */
export function useAiToolStatus(options: { enabled?: boolean; loginPolling?: boolean } = {}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: AI_TOOL_STATUS_QUERY_KEY,
    enabled: options.enabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchInterval: options.loginPolling ? 2000 : false,
    queryFn: async ({ signal }) =>
      aiToolsStatusSchema.parse(
        await fetchJson<unknown>("/api/ai-tools/status", { signal, fallback: "" }),
      ),
  });
  useLiveEvents(
    aiToolsStatusTopic,
    {
      status: {
        schema: aiToolsStatusSchema,
        async fn(status) {
          // Cancel an older GET before applying a pushed snapshot, so it cannot
          // overwrite a newer event when its response arrives later.
          await queryClient.cancelQueries({ queryKey: AI_TOOL_STATUS_QUERY_KEY });
          queryClient.setQueryData(AI_TOOL_STATUS_QUERY_KEY, status);
        },
      },
    },
    { enabled: options.enabled },
  );
  const { refetch } = query;
  const readStatus = useCallback(async () => {
    const result = await refetch();
    if (result.error) throw result.error;
    return result.data!;
  }, [refetch]);
  return { ...query, readStatus };
}
