import { fetchAppApi } from "@rome-os/app-web-sdk";
import type { DreamSchedule, RunDetail, RunListItem } from "../../lib/run-view";

export type { ChangedFile } from "../../lib/changes";
export type { DreamSchedule, RunDetail, RunListItem } from "../../lib/run-view";

export type RunFilter = "all" | "dream" | "skill_review";

/** How often a page with a run in progress checks for its next change. */
export const LIVE_REFETCH_MS = 3_000;

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    return body.message ?? body.error ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetchAppApi(path);
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as T;
}

export const queryKeys = {
  runs: (filter: RunFilter) => ["runs", filter] as const,
  run: (id: string) => ["run", id] as const,
  schedule: ["schedule"] as const,
};

export async function fetchRuns(filter: RunFilter): Promise<RunListItem[]> {
  const query = filter === "all" ? "" : `?kind=${filter}`;
  return (await getJson<{ runs: RunListItem[] }>(`runs${query}`)).runs;
}

export async function fetchRun(id: string): Promise<RunDetail> {
  return (await getJson<{ run: RunDetail }>(`runs/${encodeURIComponent(id)}`)).run;
}

export async function fetchSchedule(): Promise<DreamSchedule> {
  return getJson<DreamSchedule>("schedule");
}

/** Starts a dream and returns its run id. A dream already in progress
 *  returns that run's id instead of starting a second one. */
export async function startDream(): Promise<string> {
  const res = await fetchAppApi("runs/dream", { method: "POST" });
  if (res.status === 409) {
    const body = (await res.json()) as { runId?: string };
    if (body.runId) return body.runId;
  }
  if (!res.ok) throw new Error(await readError(res));
  return ((await res.json()) as { runId: string }).runId;
}
