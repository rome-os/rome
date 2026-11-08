import { checkGate } from "@rome-os/libs/feature-flags";
import { resolveInstanceSlug } from "./runtime.js";

/** Feature-gate name for the automatic-upgrade rollout. */
export const AUTO_UPGRADE_GATE_NAME = "auto_upgrade";

/**
 * Whether the automatic nightly upgrade flow (probe → consent countdown →
 * Rome Cloud-relayed cutover) is enabled for this instance. Evaluated live on each
 * nightly probe rather than snapshotted at boot, so a flipped rollout gate takes
 * effect on the next fire without an instance restart. The slug is read live too.
 *
 * Keyed on the instance slug; an indeterminate result (no slug, backend
 * unconfigured/unreachable) fails closed — no slug, no auto-upgrade. A
 * `FEATURE_GATE_AUTO_UPGRADE` env override (see @rome-os/libs/feature-flags/env-overrides)
 * is honored inside `checkGate` as the break-glass / no-Statsig knob.
 *
 * This gates only the *automatic* path; the manual settings-page upgrade
 * (`GET /api/system/upgrade/check` + `POST /api/system/upgrade`) is unaffected.
 */
export async function resolveAutoUpgradeEnabled(): Promise<boolean> {
  const slug = resolveInstanceSlug();
  if (!slug) return false;
  return checkGate(AUTO_UPGRADE_GATE_NAME, slug);
}
