import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { z } from "zod";
import {
  CONCIERGE_DONE_DAYS,
  CONCIERGE_TASK_STATES,
  type ConciergeTaskDto,
  type ConciergeTasksResponse,
} from "@rome/api-types/concierge";
import { CONCIERGE_TASKS_TOPIC } from "@rome/api-types/live-events";
import { type LiveTopic, useLiveEvents } from "@/hooks/use-live-events";
import { fetchJson } from "@/lib/fetch-json";
import { applyTaskUpsert } from "./tasks";

/** Every cached task list, the recent and the full one. */
const CONCIERGE_TASKS_QUERY_KEY = ["concierge-tasks"] as const;
/** How far back the full list reaches. */
const ALL_DONE_DAYS = 3650;

const conciergeTasksTopic: LiveTopic = {
  topic: CONCIERGE_TASKS_TOPIC,
  sseUrl: "/api/concierge/tasks/events",
};

const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  state: z.enum(CONCIERGE_TASK_STATES),
  summary: z.string().nullable(),
  waitingOn: z.string().nullable(),
  dueAt: z.number().nullable(),
  rank: z.number().nullable(),
  chat: z.object({ id: z.string(), name: z.string() }).nullable(),
  // A server from before the field sends none.
  sourceMessageId: z.string().nullable().default(null),
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().nullable(),
  archivedAt: z.number().nullable(),
  notSynced: z.boolean(),
});
const upsertSchema = z.object({ task: taskSchema });

/**
 * The Concierge's task list, kept live. `allDone` also loads the finished rows
 * older than the default window, for the panel's "show more". Every caller
 * shares the cache, and each write the Concierge makes lands in all of it.
 */
export function useConciergeTasks(options: { enabled?: boolean; allDone?: boolean } = {}) {
  const { enabled = true, allDone = false } = options;
  const queryClient = useQueryClient();
  const queryKey = [...CONCIERGE_TASKS_QUERY_KEY, allDone ? "all" : "recent"] as const;
  const query = useQuery({
    queryKey,
    enabled,
    staleTime: 0,
    queryFn: async ({ signal }) =>
      (
        await fetchJson<ConciergeTasksResponse>(
          `/api/concierge/tasks?doneDays=${allDone ? ALL_DONE_DAYS : CONCIERGE_DONE_DAYS}`,
          { signal, fallback: "" },
        )
      ).tasks,
  });
  const upsert = useCallback(
    ({ task }: { task: ConciergeTaskDto }) => {
      queryClient.setQueriesData<ConciergeTaskDto[]>(
        { queryKey: CONCIERGE_TASKS_QUERY_KEY },
        (prev) => (prev ? applyTaskUpsert(prev, task) : prev),
      );
    },
    [queryClient],
  );
  const refetch = query.refetch;
  useLiveEvents(
    conciergeTasksTopic,
    { task_upsert: { schema: upsertSchema, fn: upsert } },
    // Events missed while disconnected are gone, so read the list again.
    { enabled, onReconnect: () => void refetch() },
  );
  return { tasks: query.data ?? [], loaded: query.isSuccess };
}
