import type { ChatSettingField, ChatSettings } from "@rome/api-types/chat-settings";
/**
 * Client types + fetchers for the registry-native connection surface
 * (`GET /api/connections`). The types mirror the backend's
 * ConnectionView projection verbatim — registry vocabulary (ConnectionState /
 * CapabilityStatus), identity only through the generic display projection.
 * Presentation (labels, icons, ordering, slot grouping) lives in
 * `connection-cards.ts`, not here.
 */

import type { ConnectionAccountFields } from "@rome/api-types/connected-accounts";
import { fetchJson } from "@/lib/fetch-json";

/** Runtime health can change without a grant ceremony (for example, a long-poll
 * transport entering or leaving a cooldown), so active connection surfaces
 * refresh this feed periodically. */
export const CONNECTIONS_REFRESH_INTERVAL_MS = 30_000;

export type GrantState = "unauthorized" | "authorized" | "degraded";

/** Whether the platform accepts the connection's grant
 *  (docs/domains/connections.md). */
export type ConnectionState = "working" | "broken";

export type Capability = "chat" | "act" | "watch";

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

/** Where the guardian goes to (re-)grant this connection's grants. Resolved
 *  server-side for Rome Cloud-brokered OAuth services; null for services whose
 *  connect ceremony is dashboard-local (channels). */
export interface ConnectHint {
  url: string | null;
  available: boolean;
  unavailableReason: string | null;
}

export interface ApiConnection extends ConnectionAccountFields {
  /** Ledger connection id, or null for an offerable placeholder — a registered
   *  service the guardian has never connected. */
  id: string | null;
  /** The kind of connection, such as `telegram_user`. */
  connectionKind: string;
  label: string;
  /** Working or broken. Null for a placeholder, and for a connection a
   *  disconnect kept with no access. */
  state: ConnectionState | null;
  /** The grant names, each a slot the dashboard can revoke. Read the
   *  connection's state from `state`, not from these. */
  grants: Record<string, GrantState>;
  display: Record<string, GrantDisplay | null>;
  capabilities: Record<Capability, CapabilityStatus>;
  connect: ConnectHint | null;
  /** Active-setup discovery: per grant, the id of the live grant
   *  setup (if any). Lets a reopened dashboard re-attach instead of starting
   *  a fresh one. Empty when no setup is in progress. */
  setups: Record<string, string>;
  /** The chat rules the connection's kind offers on its group chats. Empty
   *  for a kind that offers none. Absent from a core that predates it. */
  chatRules?: ChatSettingField[];
  /** The values the kind's group chats run on where nobody set one. Null
   *  for a kind with no chats, and absent from a core that predates it. */
  chatRuleDefaults?: ChatSettings | null;
}

export async function fetchConnections(): Promise<ApiConnection[]> {
  const payload = await fetchJson<{ connections: ApiConnection[] }>("/api/connections", {
    fallback: "Failed to load connections.",
  });
  return payload.connections;
}

/** Structured, non-throwing result from a teardown call. */
/** A disconnect that ended the connection may carry a warning: the service
 *  may still hold Rome's access, because taking it back there failed. */
export type TeardownResult = { ok: true; warning?: string } | { ok: false; error: string };

/** Revoke the grant — the registry-native disconnect. The transport relocks
 *  and custody artifacts clear off the transition. The connection ends with
 *  it, whatever its kind, and a later connect makes a new one. */
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
  const payload = (await response.json().catch(() => null)) as { warning?: unknown } | null;
  return typeof payload?.warning === "string"
    ? { ok: true, warning: payload.warning }
    : { ok: true };
}
