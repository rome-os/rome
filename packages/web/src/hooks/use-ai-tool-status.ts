import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { aiToolsStatusSchema, type AIToolsStatus } from "@rome/api-types/ai-tools";
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
          // Publish the snapshot before cancelling an older GET, so that GET
          // cannot overwrite it later. Set data is what a cancelled fetch
          // reverts to, so a reader awaiting that GET gets this snapshot.
          queryClient.setQueryData(AI_TOOL_STATUS_QUERY_KEY, status);
          await queryClient.cancelQueries({ queryKey: AI_TOOL_STATUS_QUERY_KEY });
        },
      },
    },
    { enabled: options.enabled },
  );
  const { refetch } = query;
  const readStatus = useCallback(async () => {
    const result = await refetch();
    if (result.error) throw result.error;
    const status = result.data ?? queryClient.getQueryData<AIToolsStatus>(AI_TOOL_STATUS_QUERY_KEY);
    if (!status) throw new Error("AI tool status is unavailable");
    return status;
  }, [refetch, queryClient]);
  return { ...query, readStatus };
}
