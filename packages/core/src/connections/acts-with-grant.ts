// `act` for a kind agents act through with its grant alone, through the
// connector's proxy, though the kind has no actor of its own.

import type { CapabilityStatus, ConnectionDescriptor, GrantName, GrantState } from "./types.js";

/**
 * The `act` status a connection of `descriptor`'s kind reports, given the
 * status it reports itself and its grants' states. A kind that declares
 * `actsWithGrant` and has no actor is unlocked while every grant is
 * authorized, and otherwise needs the grants that are not. Any other kind
 * reports `act` as it stands.
 */
export function actStatusOf(
  descriptor: ConnectionDescriptor | null | undefined,
  act: CapabilityStatus,
  grants: Record<GrantName, GrantState>,
): CapabilityStatus {
  if (descriptor?.actsWithGrant !== true || descriptor.capabilities.actor) return act;
  const missing = Object.keys(grants).filter((name) => grants[name] !== "authorized");
  return missing.length === 0
    ? { state: "unlocked" }
    : { state: "needs-auth", missingGrants: missing };
}
