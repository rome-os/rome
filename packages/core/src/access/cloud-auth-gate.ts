import type { DrizzleDb } from "../db/index.js";
import { getGuardianAuthState } from "./guardian-auth-state.js";
import { resolveInstanceSlug } from "../lib/runtime.js";
import { checkGate } from "@rome-os/libs/feature-flags";

/** Feature-gate name for the cloud-auth rollout (the cloud-auth-specific key). */
export const CLOUD_AUTH_GATE_NAME = "rome_cloud_auth";

/**
 * Compute whether cloud guardian auth is enabled. Called live on each sign-in
 * entry (not snapshotted at boot) so a flipped rollout gate takes effect without
 * an instance restart.
 *
 * Precedence:
 *   1. Sticky cloud: once a cloud-created guardian seat exists it has no local
 *      password (it uses the cloud sentinel), so the instance can ONLY sign in
 *      via cloud. Keep cloud auth on regardless of the gate — a gate flip, a
 *      missing slug, or an unreachable backend must never strand that guardian
 *      on a local sign-in path they cannot use. This is the top invariant.
 *   2. Otherwise the rollout gate `rome_cloud_auth` decides, keyed on the
 *      instance slug, read live so a slug adopted at runtime applies at once.
 *      An indeterminate result (no slug, backend
 *      unconfigured/unreachable) fails closed to local auth — safe before any
 *      cloud-only seat exists. A `FEATURE_GATE_ROME_CLOUD_AUTH` env override (see
 *      @rome-os/libs/feature-flags/env-overrides) is honored inside `checkGate` and serves
 *      as the break-glass / no-Statsig knob.
 */
export async function resolveCloudAuthEnabled(db: DrizzleDb): Promise<boolean> {
  const guardian = await getGuardianAuthState(db);
  if (guardian.exists && !guardian.hasLocalPassword) return true;

  const slug = resolveInstanceSlug();
  if (!slug) return false;
  return checkGate(CLOUD_AUTH_GATE_NAME, slug);
}
