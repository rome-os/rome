import { useEffect, useState } from "react";
import type { ExternalSelection, ResolveResult } from "../store/types";

export interface ResolvedSelection {
  /**
   * The path as a file or folder selection. While a new path resolves this
   * keeps the previous result, so a consumer never falls back mid-navigation.
   */
  selection: ExternalSelection | null;
  /** True only when `/resolve` answered that the current path does not exist. */
  missing: boolean;
  /** True once the current path got an answer or its lookup failed. */
  settled: boolean;
}

interface Resolved {
  path: string;
  selection: ExternalSelection | null;
  missing: boolean;
}

/**
 * Resolve a logical path to an external selection of the right kind. Links and
 * saved placements name files and folders alike; `/resolve` says which one this
 * is, so a folder selects the folder instead of being fetched as a file.
 */
export function useResolvedSelection(apiBasePath: string, path: string | null): ResolvedSelection {
  const [resolved, setResolved] = useState<Resolved | null>(null);

  useEffect(() => {
    if (!path) {
      setResolved(null);
      return;
    }

    let cancelled = false;
    // A failed lookup says nothing about the path: settle without a verdict.
    const fail = () => {
      if (cancelled) return;
      setResolved((prev) => ({ path, selection: prev?.selection ?? null, missing: false }));
    };
    fetch(`${apiBasePath}/resolve?path=${encodeURIComponent(path)}`, {
      credentials: "include",
    })
      .then(async (res) => {
        if (!res.ok) return fail();
        const data = (await res.json()) as ResolveResult;
        if (cancelled) return;
        const found = data.type === "file" || data.type === "directory";
        setResolved({
          path,
          selection: found ? { path, type: data.type } : null,
          missing: !found,
        });
      })
      .catch(fail);

    return () => {
      cancelled = true;
    };
  }, [apiBasePath, path]);

  if (!path) return { selection: null, missing: false, settled: true };
  return {
    selection: resolved?.selection ?? null,
    missing: resolved?.path === path && resolved.missing,
    settled: resolved?.path === path,
  };
}
