/**
 * Network-side executors for the unified Connections detail page.
 *
 * OAuth (Rome Cloud-brokered) connect/reconnect/disconnect no longer live here:
 * connect/reconnect run through the conferral setup (#1611, via
 * `useSetup` in `oauth-connection-section.tsx`) and disconnect is the
 * registry-native grant revoke (`revokeConnectionGrant`). What remains is the
 * Composio account prerequisite that sits above the connection list.
 */

import type { ComposioCliStatus } from "@/lib/provider-types";

/** Typed result of a Composio account ceremony. */
export type ComposioActionResult = { ok: true } | { ok: false; error: string };

const STATUS_POLL_TRIES = 30;
const STATUS_POLL_INTERVAL_MS = 2_000;

/**
 * Composio ACCOUNT login: kick off `login`, then poll `status` (bounded, 30
 * tries at 2s) until `loggedIn`. Verbatim endpoint contracts from the legacy
 * Integrations tab. `onLoginUrl` surfaces the login URL to the caller (which may
 * open it).
 */
export async function runComposioLogin(options?: {
  onLoginUrl?: (loginUrl: string) => void;
}): Promise<ComposioActionResult> {
  const response = await fetch("/api/integrations/composio/login", { method: "POST" });
  const payload = (await response.json().catch(() => null)) as {
    loginUrl?: string;
    error?: string;
  } | null;
  if (!response.ok || !payload?.loginUrl) {
    return { ok: false, error: payload?.error || "Failed to start Composio login." };
  }
  options?.onLoginUrl?.(payload.loginUrl);

  for (let attempt = 0; attempt < STATUS_POLL_TRIES; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));
    const statusResponse = await fetch("/api/integrations/composio/status", { cache: "no-store" });
    const statusPayload = (await statusResponse.json().catch(() => null)) as {
      composio?: ComposioCliStatus;
      error?: string;
    } | null;
    if (!statusResponse.ok) {
      return { ok: false, error: statusPayload?.error || "Failed to check Composio status." };
    }
    if (statusPayload?.composio?.loggedIn) {
      return { ok: true };
    }
    // A terminal completion failure (e.g. `login --poll` exited without saving
    // credentials) surfaces as status.error once the ceremony is no longer
    // pending. Fail fast instead of polling out the full deadline — otherwise a
    // failed completion reads as a silent hang.
    if (statusPayload?.composio?.error) {
      return { ok: false, error: statusPayload.composio.error };
    }
  }
  // Timed out waiting for the browser leg — not an error, just unconfirmed.
  return { ok: true };
}

/** Composio ACCOUNT logout. */
export async function runComposioLogout(): Promise<ComposioActionResult> {
  const response = await fetch("/api/integrations/composio/logout", { method: "POST" });
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) {
    return { ok: false, error: payload?.error || "Failed to disconnect Composio." };
  }
  return { ok: true };
}
