import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DefaultModelProvider, ProviderFailureReason } from "@rome/api-types/chat";
import { fetchJson } from "@/lib/fetch-json";

export type { DefaultModelProvider };

/** The providers the guardian is signed in to, as `/api/ai-tools/default` reports them. */
export type SignedInProviders = Record<DefaultModelProvider, boolean>;

/** The guardian's default provider and the providers it can be. docs/domains/agents.md#default-provider */
export interface DefaultProviderState {
  provider: DefaultModelProvider | null;
  signedIn: SignedInProviders;
  /** Left when the default was removed and another provider took its place. */
  note?: { from: DefaultModelProvider; to: DefaultModelProvider; at: string };
  /** How many chats follow the default, which a change of default can move. */
  followingChats?: number;
  /** Rome credits could run chats once no AI account is logged in. */
  romeCreditsUsable?: boolean;
}

/** One provider that stopped working while unattended chats waited on it. */
export interface ProviderOutage {
  id: string;
  provider: DefaultModelProvider;
  reason: ProviderFailureReason;
  until?: string;
  chatIds: string[];
  since: string;
}

export const DEFAULT_PROVIDER_QUERY_KEY = ["ai-tools", "default"] as const;
export const PROVIDER_OUTAGES_QUERY_KEY = ["ai-tools", "provider-outages"] as const;

export const DEFAULT_MODEL_PROVIDERS: readonly DefaultModelProvider[] = [
  "anthropic",
  "openai",
  "rome_credits",
];

/** The default provider and signed-in providers; null where the instance has none. */
export function useDefaultProvider() {
  return useQuery<DefaultProviderState | null>({
    queryKey: DEFAULT_PROVIDER_QUERY_KEY,
    staleTime: 30_000,
    queryFn: async ({ signal }) =>
      (
        await fetchJson<{ defaultProvider: DefaultProviderState | null }>("/api/ai-tools/default", {
          signal,
          fallback: "Failed to load the default provider",
        })
      ).defaultProvider,
  });
}

/** Read the default provider again, after a sign-in or sign-out changed what it can be. */
export function useInvalidateDefaultProvider() {
  const qc = useQueryClient();
  return useCallback(() => qc.invalidateQueries({ queryKey: DEFAULT_PROVIDER_QUERY_KEY }), [qc]);
}

/**
 * Makes `provider` the default. With `moveExisting` false, the chats that
 * follow the default stay on the provider they run on.
 */
export function useSetDefaultProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { provider: DefaultModelProvider; moveExisting: boolean }) =>
      fetchJson<{ defaultProvider: DefaultProviderState | null }>("/api/ai-tools/default", {
        method: "PUT",
        json: input,
        fallback: "Failed to change the default provider",
      }),
    onSuccess: (data) => {
      qc.setQueryData(DEFAULT_PROVIDER_QUERY_KEY, data.defaultProvider);
      void qc.invalidateQueries({ queryKey: PROVIDER_OUTAGES_QUERY_KEY });
    },
  });
}

export function useDismissDefaultProviderNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetchJson<{ defaultProvider: DefaultProviderState | null }>("/api/ai-tools/default/note", {
        method: "DELETE",
        fallback: "Failed to dismiss the note",
      }),
    onSuccess: (data) => qc.setQueryData(DEFAULT_PROVIDER_QUERY_KEY, data.defaultProvider),
  });
}

/**
 * What a failure card's or an outage notice's button asks for: move to another
 * provider (and with `makeDefault`, make it the default), or to another model
 * on the same provider.
 */
export type ProviderSwitch =
  | { kind: "provider"; provider: DefaultModelProvider; makeDefault: boolean }
  | { kind: "model"; selection: string };

/**
 * Settles the failure card in message `messageId`: the chat moves, and the
 * stopped turn runs again. The server rewrites the card's message in place.
 */
export function switchProviderFailure(messageId: string, change: ProviderSwitch): Promise<unknown> {
  return fetchJson(`/api/ai-tools/provider-failures/${encodeURIComponent(messageId)}/switch`, {
    method: "POST",
    json: change,
    fallback: "Failed to switch",
  });
}

/** The open provider outages. A resolved outage is absent. */
export function useProviderOutages() {
  return useQuery<ProviderOutage[]>({
    queryKey: PROVIDER_OUTAGES_QUERY_KEY,
    staleTime: 30_000,
    queryFn: async ({ signal }) =>
      (
        await fetchJson<{ outages: ProviderOutage[] }>("/api/ai-tools/provider-outages", {
          signal,
          fallback: "Failed to load provider outages",
        })
      ).outages,
  });
}

/** Moves every chat an outage stopped, which then run again. */
export function useSwitchOutage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { outageId: string; change: ProviderSwitch }) =>
      fetchJson<{ moved: number }>(
        `/api/ai-tools/provider-outages/${encodeURIComponent(input.outageId)}/switch`,
        { method: "POST", json: input.change, fallback: "Failed to switch" },
      ),
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: PROVIDER_OUTAGES_QUERY_KEY });
      if (input.change.kind === "provider" && input.change.makeDefault) {
        void qc.invalidateQueries({ queryKey: DEFAULT_PROVIDER_QUERY_KEY });
      }
    },
  });
}

/** Signed-in providers, or null while the answer is unknown. */
export function useSignedInProviders(): SignedInProviders | null {
  const { data } = useDefaultProvider();
  return data?.signedIn ?? null;
}
