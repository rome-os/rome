// Source-neutral project sync client. Data model: docs/concepts/data.md.
// Mirrors the backend
// `SyncSource` contract — no git/GitHub-specific shapes leak through here.

export type SyncState =
  | "unlinked"
  | "linked"
  | "syncing"
  | "ahead"
  | "behind"
  | "diverged"
  | "conflict"
  | "error";

export interface SyncStatus {
  state: SyncState;
  ref?: string;
  defaultRef?: string;
  remoteLabel?: string;
  remoteUrl?: string;
  sourceId?: string;
  private?: boolean;
  changes?: { added: number; modified: number; removed: number };
  ahead?: number;
  behind?: number;
  lastSyncedAt?: string;
  message?: string;
  resolvedCase?: "empty-empty" | "empty-remote" | "local-empty" | "local-remote";
}

/** One file that differs from the synced baseline. Mirrors the backend
 * `ChangedFile`; the `change` buckets match `SyncStatus.changes`. */
export interface ChangedFile {
  path: string;
  change: "added" | "modified" | "removed";
}

export interface ChangeDiff {
  path: string;
  patch: string;
  truncated?: boolean;
}

export interface RemoteTarget {
  sourceId: string;
  locator: Record<string, unknown>;
  label: string;
}

export interface RemoteTargetCandidate extends RemoteTarget {
  description?: string;
  group?: string;
  isEmpty?: boolean;
}

export interface SyncGroup {
  id: string;
  label: string;
  icon?: string;
}

export interface SyncSourceInfo {
  id: string;
  label: string;
  icon?: string;
  authProvider?: string;
  available: boolean;
  reason?: string;
  connectUrl?: string | null;
}

export type LinkStrategy = "auto" | "pull-remote" | "push-local" | "merge";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

export class SyncApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "SyncApiError";
    this.status = status;
  }
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const payload = (await res.json()) as { error?: string };
      if (payload?.error) message = payload.error;
    } catch {
      /* keep default */
    }
    throw new SyncApiError(message, res.status);
  }
  return (await res.json()) as T;
}

export async function listSyncSources(): Promise<SyncSourceInfo[]> {
  const res = await fetch("/api/sync/sources", { credentials: "include" });
  const data = await jsonOrThrow<{ sources: SyncSourceInfo[] }>(res);
  return data.sources;
}

export async function listSyncGroups(source: string): Promise<SyncGroup[]> {
  const params = new URLSearchParams({ source });
  const res = await fetch(`/api/sync/groups?${params.toString()}`, { credentials: "include" });
  const data = await jsonOrThrow<{ groups: SyncGroup[] }>(res);
  return data.groups;
}

export async function listSyncTargets(
  source: string,
  query?: string,
): Promise<RemoteTargetCandidate[]> {
  const params = new URLSearchParams({ source });
  if (query) params.set("q", query);
  const res = await fetch(`/api/sync/targets?${params.toString()}`, { credentials: "include" });
  const data = await jsonOrThrow<{ targets: RemoteTargetCandidate[] }>(res);
  return data.targets;
}

export async function createSyncTarget(input: {
  source: string;
  name: string;
  group?: string;
  private?: boolean;
  description?: string;
}): Promise<RemoteTarget> {
  const res = await fetch("/api/sync/targets", {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  const data = await jsonOrThrow<{ target: RemoteTarget }>(res);
  return data.target;
}

export async function linkProject(input: {
  projectPath: string;
  source: string;
  target: RemoteTarget;
  strategy?: LinkStrategy;
}): Promise<SyncStatus> {
  const res = await fetch("/api/sync/link", {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  return jsonOrThrow<SyncStatus>(res);
}

export async function getSyncStatus(projectPath: string): Promise<SyncStatus> {
  const params = new URLSearchParams({ projectPath });
  const res = await fetch(`/api/sync/status?${params.toString()}`, { credentials: "include" });
  return jsonOrThrow<SyncStatus>(res);
}

export async function getSyncChanges(projectPath: string): Promise<ChangedFile[]> {
  const params = new URLSearchParams({ projectPath });
  const res = await fetch(`/api/sync/changes?${params.toString()}`, { credentials: "include" });
  const data = await jsonOrThrow<{ files: ChangedFile[] }>(res);
  return data.files;
}

export async function getSyncChangeDiff(projectPath: string, path: string): Promise<ChangeDiff> {
  const params = new URLSearchParams({ projectPath, path });
  const res = await fetch(`/api/sync/changes/diff?${params.toString()}`, {
    credentials: "include",
  });
  return jsonOrThrow<ChangeDiff>(res);
}

export async function restoreSyncChange(projectPath: string, path: string): Promise<ChangedFile[]> {
  const res = await fetch("/api/sync/changes/restore", {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify({ projectPath, path }),
  });
  const data = await jsonOrThrow<{ files: ChangedFile[] }>(res);
  return data.files;
}

export async function restoreAllSyncChanges(projectPath: string): Promise<ChangedFile[]> {
  const res = await fetch("/api/sync/changes/restore-all", {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify({ projectPath }),
  });
  const data = await jsonOrThrow<{ files: ChangedFile[] }>(res);
  return data.files;
}

export async function resetSyncToDefault(projectPath: string): Promise<SyncStatus> {
  const res = await fetch("/api/sync/reset", {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify({ projectPath }),
  });
  return jsonOrThrow<SyncStatus>(res);
}

export async function runSync(
  projectPath: string,
  direction: "push" | "pull" | "both",
): Promise<SyncStatus> {
  const res = await fetch("/api/sync/sync", {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify({ projectPath, direction }),
  });
  return jsonOrThrow<SyncStatus>(res);
}

// The internal enum stays the contract; nothing renders the raw state value.

export interface SyncStatePresentation {
  label: string;
  tone: "neutral" | "ok" | "busy" | "attention" | "error";
}

export function presentSyncState(state: SyncState): SyncStatePresentation {
  switch (state) {
    case "unlinked":
      return { label: "Not connected", tone: "neutral" };
    case "linked":
      return { label: "Up to date", tone: "ok" };
    case "syncing":
      return { label: "Syncing…", tone: "busy" };
    case "ahead":
      return { label: "Changes to upload", tone: "attention" };
    case "behind":
      return { label: "Updates available", tone: "attention" };
    case "diverged":
      return { label: "Local and remote both changed", tone: "attention" };
    case "conflict":
      return { label: "Needs your attention", tone: "error" };
    case "error":
      return { label: "Sync problem", tone: "error" };
    default:
      return { label: "Unknown", tone: "neutral" };
  }
}
