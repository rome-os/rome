import { useEffect, useState } from "react";
import type { ExternalSelection, ResolveResult } from "../store/types";

/**
 * Resolve a logical path to an external selection of the right kind. Links and
 * saved placements name files and folders alike; `/resolve` says which one this
 * is, so a folder selects the folder instead of being fetched as a file.
 */
export function useResolvedSelection(
  apiBasePath: string,
  path: string | null,
): ExternalSelection | null {
  const [target, setTarget] = useState<ExternalSelection | null>(null);

  useEffect(() => {
    if (!path) {
      setTarget(null);
      return;
    }

    let cancelled = false;
    fetch(`${apiBasePath}/resolve?path=${encodeURIComponent(path)}`, {
      credentials: "include",
    })
      .then(async (res) => {
        const data = res.ok ? ((await res.json()) as ResolveResult) : null;
        if (cancelled) return;
        setTarget(
          data?.type === "file" || data?.type === "directory" ? { path, type: data.type } : null,
        );
      })
      .catch(() => {
        if (!cancelled) setTarget(null);
      });

    return () => {
      cancelled = true;
    };
  }, [apiBasePath, path]);

  return target;
}
