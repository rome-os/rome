import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import type { FeaturesResponse, GatedFeature } from "@rome/api-types/features";

/** Whether a gated feature is shown. Pending until core has answered. */
export type FeatureState = "shown" | "hidden" | "pending";

/**
 * Reads whether gated features are shown, for a list whose entries each may
 * name one. An entry that names no feature is always shown. A feature core
 * cannot answer for is hidden, as a gate that cannot be evaluated reads off.
 */
export function useFeatureStates(): (feature: GatedFeature | undefined) => FeatureState {
  const query = useQuery({
    queryKey: ["features"],
    // A gate flips rarely, and a flip may wait for the next visit.
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }): Promise<FeaturesResponse> => {
      const response = await fetch("/api/features", {
        credentials: "include",
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw new Error(`GET /api/features answered ${response.status}`);
      return (await response.json()) as FeaturesResponse;
    },
  });
  const visibility = query.data?.features;
  const failed = query.isError;
  // Kept across renders while the answer holds, so lists derived from it can
  // memoize on it.
  return useCallback(
    (feature) => {
      if (feature === undefined) return "shown";
      if (visibility === undefined) return failed ? "hidden" : "pending";
      return visibility[feature] === true ? "shown" : "hidden";
    },
    [visibility, failed],
  );
}

/** Whether one gated feature is shown. */
export function useFeatureState(feature: GatedFeature): FeatureState {
  return useFeatureStates()(feature);
}
