import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { AccountDirectory } from "@rome/api-types/people";
import { fetchJson } from "@/lib/fetch-json";

// How long the search box settles before its term reaches the wire. Long enough
// that a typed word is one request rather than one per letter, short enough
// that the pause is not read as the field having stopped.
const SEARCH_DEBOUNCE_MS = 250;

/** A value that only changes once it has held still for `delayMs`. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

/**
 * The accounts a picker can name, as the server answers the term typed.
 *
 * Server-side, because the directory is an address book rather than a curated
 * listing: a filter over the page that happened to load would answer "no such
 * account" for a contact the mirror holds. For the same reason a picker that
 * only offers one channel's accounts names the channel here, rather than
 * filtering a page other channels may have filled.
 *
 * A picker only offers suggestions, so a failed read shows none and carries no
 * message of its own.
 */
export function useAccountSearch(search: string, options: { enabled: boolean; channel?: string }) {
  const term = useDebounced(search.trim(), SEARCH_DEBOUNCE_MS);
  const channel = options.channel ?? null;
  return useQuery<AccountDirectory>({
    queryKey: ["accounts", "picker", channel, term],
    enabled: options.enabled,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => {
      const query = new URLSearchParams();
      if (term) query.set("q", term);
      if (channel) query.set("channel", channel);
      const suffix = query.toString();
      return fetchJson<AccountDirectory>(`/api/accounts${suffix ? `?${suffix}` : ""}`, {
        signal,
        fallback: "",
      });
    },
  });
}
