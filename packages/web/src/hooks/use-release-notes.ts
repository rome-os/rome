import { useQuery } from "@tanstack/react-query";
import type { ReleaseNotesRange } from "@rome/api-types/release-notes";
import { fetchJson } from "@/lib/fetch-json";

export const RELEASE_NOTES_PATH = "/api/system/release-notes";

/**
 * What upgrading from `from` to `to` changes. Keyed by both versions, so a
 * changed target reads its own notes and never shows another version's. The
 * query stays idle while `to` is null.
 */
export function useReleaseNotes(from: string | null, to: string | null) {
  return useQuery<ReleaseNotesRange>({
    queryKey: ["release-notes", from, to] as const,
    enabled: to !== null,
    retry: false,
    // The server refreshes its copies after a backfill, so an answer is read
    // again on the next open once it is an hour old.
    staleTime: 60 * 60_000,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ to: to ?? "" });
      if (from) params.set("from", from);
      return fetchJson<ReleaseNotesRange>(`${RELEASE_NOTES_PATH}?${params}`, {
        signal,
        fallback: "",
      });
    },
  });
}
