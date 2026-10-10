import { useCallback, useSyncExternalStore } from "react";
import { matchesMediaQuery } from "@/lib/media-query";

/** Whether `query` matches, re-rendering when it flips. False where
 *  `matchMedia` is unavailable and during server rendering. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
        return () => {};
      }
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onStoreChange);
      return () => mql.removeEventListener("change", onStoreChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => matchesMediaQuery(query),
    () => false,
  );
}
