/**
 * Client types + fetchers for the registry-native connection surface
 * (`GET /api/connections`). The types mirror the backend's
 * ConnectionView projection verbatim — registry vocabulary (GrantState /
 * CapabilityStatus), identity only through the generic display projection.
 * Presentation (labels, icons, ordering, slot grouping) lives in
 * `connection-cards.ts`, not here.
 */

import { fetchJson } from "@/lib/fetch-json";

/** Runtime health can change without a grant ceremony (for example, a long-poll
 * transport entering or leaving a cooldown), so active connection surfaces
 * refresh this feed periodically. */
export const CONNECTIONS_REFRESH_INTERVAL_MS = 30_000;

export type GrantState = "unauthorized" | "authorized" | "degraded";

export type Capability = "talk" | "act" | "watch";

export interface CapabilityDegradation {
  reason: string;
  retryAt?: string;
}

export type CapabilityStatus =
  | { state: "unlocked"; degradation?: CapabilityDegradation }
  | { state: "needs-auth"; missingGrants: string[] }
  | { state: "needs-subscription" }
  | { state: "unsupported" };

/** The generic identity view of one grant — the service's ProfileDisplay
 *  projection, normalized to nulls at the API boundary. */
export interface GrantDisplay {
  displayName: string | null;
  handle: string | null;
  email: string | null;
  avatarUrl: string | null;
}

/** Where the guardian goes to (re-)confer this connection's grants. Resolved
 *  server-side for Rome Cloud-brokered OAuth services; null for services whose
 *  connect ceremony is dashboard-local (channels). */
export interface ConnectHint {
  url: string | null;
  available: boolean;
  unavailableReason: string | null;
}

export interface ApiConnection {
  /** Ledger connection id, or null for an offerable placeholder — a registered
   *  service the guardian has never connected. */
  id: string | null;
  service: string;
  label: string;
  grants: Record<string, GrantState>;
  display: Record<string, GrantDisplay | null>;
  capabilities: Record<Capability, CapabilityStatus>;
  connect: ConnectHint | null;
  /** Active-setup discovery: per grant, the id of the live conferral
   *  setup (if any). Lets a reopened dashboard re-attach instead of starting
   *  a fresh one. Empty when no setup is in progress. */
  setups: Record<string, string>;
}

export async function fetchConnections(): Promise<ApiConnection[]> {
  const payload = await fetchJson<{ connections: ApiConnection[] }>("/api/connections", {
    fallback: "Failed to load connections.",
  });
  return payload.connections;
}

/** Structured, non-throwing result from a teardown call. */
export type TeardownResult = { ok: true } | { ok: false; error: string };

/** Revoke one grant — the registry-native disconnect. The transport relocks
 *  and custody artifacts clear off the transition; the connection row persists
 *  so a later reconnect re-confers in place. */
export async function revokeConnectionGrant(
  connectionId: string,
  grant: string,
): Promise<TeardownResult> {
  const response = await fetch(
    `/api/connections/${encodeURIComponent(connectionId)}/grants/${encodeURIComponent(grant)}`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, error: payload?.error || "Failed to disconnect." };
  }
  return { ok: true };
}
