import { useEffect, useState } from "react";
import type { ExternalSelection, ResolveResult } from "../store/types";

export interface ResolvedSelection {
  /** The path as a file or folder selection; null when absent or unresolvable. */
  selection: ExternalSelection | null;
  /** True once `/resolve` has answered (or failed) for the current path. */
  settled: boolean;
}

/**
 * Resolve a logical path to an external selection of the right kind. Links and
 * saved placements name files and folders alike; `/resolve` says which one this
 * is, so a folder selects the folder instead of being fetched as a file.
 */
export function useResolvedSelection(apiBasePath: string, path: string | null): ResolvedSelection {
  const [resolved, setResolved] = useState<{ path: string; selection: ExternalSelection | null }>();

  useEffect(() => {
    if (!path) return;

    let cancelled = false;
    const settle = (selection: ExternalSelection | null) => {
      if (!cancelled) setResolved({ path, selection });
    };
    fetch(`${apiBasePath}/resolve?path=${encodeURIComponent(path)}`, {
      credentials: "include",
    })
      .then(async (res) => {
        const data = res.ok ? ((await res.json()) as ResolveResult) : null;
        settle(
          data?.type === "file" || data?.type === "directory" ? { path, type: data.type } : null,
        );
      })
      .catch(() => settle(null));

    return () => {
      cancelled = true;
    };
  }, [apiBasePath, path]);

  if (!path) return { selection: null, settled: true };
  // A result for an earlier path is stale: the current one is still pending.
  if (resolved?.path !== path) return { selection: null, settled: false };
  return { selection: resolved.selection, settled: true };
}
