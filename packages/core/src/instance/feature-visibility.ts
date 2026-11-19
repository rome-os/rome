import { checkGate } from "@rome-os/libs/feature-flags";
import { GATED_FEATURES, type FeatureVisibility } from "@rome/api-types/features";
import { resolveInstanceSlug } from "./runtime.js";

/** The rollout key of an instance with no slug, such as a local dev instance.
 *  Statsig has no rules for it, so only a `FEATURE_GATE_*` override shows a
 *  feature there. */
const UNSLUGGED_UNIT = "local";

/**
 * Whether each gated feature is shown on this instance. The dashboard reads it
 * to hide a feature's pages, navigation and links, and anything else that
 * offers a gated feature to the guardian reads it here too.
 *
 * Each feature is the gate of the same name, keyed on the instance slug and
 * read live. A gate that cannot be evaluated reads off, so a gated feature
 * stays hidden on an instance that cannot reach Statsig. `FEATURE_GATE_PEOPLE=on`
 * shows People without Statsig.
 */
export async function resolveFeatureVisibility(): Promise<FeatureVisibility> {
  const unit = resolveInstanceSlug() ?? UNSLUGGED_UNIT;
  const shown = await Promise.all(GATED_FEATURES.map((feature) => checkGate(feature, unit)));
  return Object.fromEntries(
    GATED_FEATURES.map((feature, i) => [feature, shown[i]]),
  ) as FeatureVisibility;
}
