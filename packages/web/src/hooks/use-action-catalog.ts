import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchJson } from "@/lib/fetch-json";

/** JSON Schema subset the catalog surfaces for an action's arguments. The
 * server passes each action's declared schema through verbatim; only the
 * object-level fields the args helper/validator reads are typed here. */
export interface ActionInputSchema {
  type?: string;
  properties?: Record<string, ActionArgSchema>;
  required?: string[];
  additionalProperties?: boolean | Record<string, unknown>;
  [key: string]: unknown;
}

/** Per-argument JSON Schema fields the picker renders and validates against. */
export interface ActionArgSchema {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  default?: unknown;
  items?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Mirror of the server's `ActionCatalogEntry` (`GET /api/actions`). */
export interface ActionCatalogEntry {
  name: string;
  description: string;
  type: "system" | "custom";
  visibility: "public" | "explicit";
  sideEffects: "read-only" | "write";
  requiresApproval: boolean;
  ownerType: string;
  ownerId: string;
  /** `null` = event-only action (workflow) with no declared arguments. */
  inputSchema: ActionInputSchema | null;
}

// The registry behind /api/actions is live (apps can add or remove actions at
// any moment), so the catalog is always re-fetched on mount — the routine
// modal mounts this hook when it opens, giving it fresh data per open.
export function useActionCatalog() {
  const { t } = useTranslation("routines");
  const query = useQuery({
    queryKey: ["actions", "catalog"] as const,
    staleTime: 0,
    queryFn: ({ signal }) =>
      fetchJson<{ actions: ActionCatalogEntry[] }>("/api/actions", {
        signal,
        fallback: t("modal.actionPicker.loadFailed"),
      }),
  });
  return {
    actions: query.data?.actions ?? null,
    isLoading: query.isLoading,
    error: query.error,
  };
}
