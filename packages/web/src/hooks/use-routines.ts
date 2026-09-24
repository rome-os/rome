import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchJson } from "@/lib/fetch-json";
import type { Routine, RoutineRun } from "@/lib/routine-language";
import type { ActionNode } from "@/components/agent-trace/ActionExecutionTree";

const LIST_QUERY_KEY = ["routines", "list"] as const;

// Mirror of the /apps reactivity pattern: the routines list is authoritative and
// eager (staleTime: 0), so every mount/focus revalidates against the server.
// Toggle/delete mutations invalidate this key on success instead of hand-merging
// server fields, so the cards always reflect server truth.
export function useRoutines() {
  const { t } = useTranslation("routines");
  const query = useQuery({
    queryKey: LIST_QUERY_KEY,
    staleTime: 0,
    queryFn: ({ signal }) =>
      fetchJson<Routine[]>("/api/routines", {
        signal,
        fallback: t("errors.loadFailed"),
      }),
  });
  return {
    routines: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}

// Run history for one routine. Lazy: only fetched when a card's history panel is
// open (enabled), and kept briefly so reopening the same card is instant. The
// card passes the default limit (5); the detail view asks for more. `limit` is
// in the query key so the two callers don't share a truncated cache entry;
// mutations still invalidate both via the ["routines", id, "runs"] prefix.
export function useRoutineRuns(routineId: string, enabled: boolean, limit = 5) {
  const { t } = useTranslation("routines");
  const query = useQuery({
    queryKey: ["routines", routineId, "runs", limit] as const,
    enabled,
    staleTime: 30_000,
    queryFn: ({ signal }) =>
      fetchJson<RoutineRun[]>(
        `/api/routines/${encodeURIComponent(routineId)}/runs?limit=${limit}`,
        {
          signal,
          fallback: t("errors.loadFailed"),
        },
      ),
  });
  return {
    runs: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
  };
}

/** Response of the run-trace endpoint. `roots` is already `ActionNode`-shaped
 * (the server runs the action_executions → tree mapper), so no client mapping. */
export interface RoutineRunTrace {
  runId: string;
  status: "success" | "error" | "running" | "pending_approval" | "cancelled";
  error: string | null;
  roots: ActionNode[];
}

// Action-execution tree for one run. Lazy: only fetched when a run row is
// expanded (enabled), and kept briefly so reopening the same run is instant.
export function useRoutineRunTrace(routineId: string, runId: string, enabled: boolean) {
  const { t } = useTranslation("routines");
  const query = useQuery({
    queryKey: ["routines", routineId, "runs", runId, "trace"] as const,
    enabled,
    staleTime: 30_000,
    queryFn: ({ signal }) =>
      fetchJson<RoutineRunTrace>(
        `/api/routines/${encodeURIComponent(routineId)}/runs/${encodeURIComponent(runId)}/trace`,
        { signal, fallback: t("errors.loadFailed") },
      ),
  });
  return {
    trace: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
  };
}

export function useInvalidateRoutines(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: LIST_QUERY_KEY });
}

// Chat creates through a small fetch helper rather than a query mutation. Put
// the returned server row into the authoritative list before invalidating it,
// so an immediate detail navigation cannot mistake an older cached list for a
// definitive "not found" result while the fresh list is loading. If the server
// response is malformed, drop the list instead of guessing a routine shape.
export function useSyncCreatedRoutine(): (routine: Routine | undefined) => void {
  const queryClient = useQueryClient();
  return (routine) => {
    if (!routine) {
      queryClient.removeQueries({ queryKey: LIST_QUERY_KEY, exact: true });
      return;
    }
    queryClient.setQueryData<Routine[]>(LIST_QUERY_KEY, (current) => [
      routine,
      ...(current ?? []).filter((cached) => cached.id !== routine.id),
    ]);
    void queryClient.invalidateQueries({ queryKey: LIST_QUERY_KEY });
  };
}

/** A persisted chat record can outlive an older routines-list cache. Clear that
 * cache immediately before following its detail link so the detail route waits
 * for server truth instead of briefly treating the old list as authoritative. */
export function usePrepareRoutineDetailNavigation(): () => void {
  const queryClient = useQueryClient();
  return () => queryClient.removeQueries({ queryKey: LIST_QUERY_KEY, exact: true });
}

/** Outcome of a manual "run now": the action ran for real, so `status` may be a
 * run-level failure even though the HTTP call succeeded. */
export interface RunNowResult {
  runId: string;
  status: "success" | "error" | "running" | "pending_approval" | "cancelled";
  error?: string;
}

// Fire a routine's action immediately. Returns a callable rather than wrapping
// react-query's mutation because the caller drives a small per-card status
// machine (idle → running → success/error) and only needs the resolved outcome.
// On settle we invalidate the routine's run history (a new run was recorded) and
// the list (lastFiredAt etc. may have shifted on the server).
export function useRunRoutineNow(): (routineId: string) => Promise<RunNowResult> {
  const { t } = useTranslation("routines");
  const queryClient = useQueryClient();
  return async (routineId: string) => {
    try {
      return await fetchJson<RunNowResult>(`/api/routines/${encodeURIComponent(routineId)}/run`, {
        method: "POST",
        fallback: t("errors.runFailed"),
      });
    } finally {
      void queryClient.invalidateQueries({ queryKey: ["routines", routineId, "runs"] });
      void queryClient.invalidateQueries({ queryKey: LIST_QUERY_KEY });
    }
  };
}

// Stop a routine's active run. Forces the run to a terminal "cancelled" on the
// server (killing a live execution if one exists, and always repairing a status
// left stuck "running" by a restart), then invalidates so the badge clears.
export function useStopRoutine(): (routineId: string) => Promise<void> {
  const { t } = useTranslation("routines");
  const queryClient = useQueryClient();
  return async (routineId: string) => {
    try {
      await fetchJson<void>(`/api/routines/${encodeURIComponent(routineId)}/cancel`, {
        method: "POST",
        fallback: t("errors.stopFailed"),
      });
    } finally {
      void queryClient.invalidateQueries({ queryKey: ["routines", routineId, "runs"] });
      void queryClient.invalidateQueries({ queryKey: LIST_QUERY_KEY });
    }
  };
}
