import { checkGate } from "@rome-os/libs/feature-flags";
import { resolveInstanceSlug } from "../instance/runtime.js";

/** Feature-gate name for voice conversation mode. Off unless a gate or override turns it on. */
export const VOICE_MODE_GATE_NAME = "voice_mode";

// The rollout key when the instance has no slug. A gate rule that lists
// instances never matches it; only an override or an everyone rule does.
const UNNAMED_INSTANCE = "unnamed-instance";

/**
 * Whether voice conversation mode is on for this instance. Read live on each
 * use, so a flipped gate applies without a restart. It is off until something
 * turns it on: `FEATURE_GATE_VOICE_MODE=on` (see
 * `@rome-os/libs/feature-flags/env-overrides`), or a rule on the `voice_mode`
 * gate in the feature-flag backend. A backend that cannot answer reads off.
 */
export function resolveVoiceModeEnabled(): Promise<boolean> {
  return checkGate(VOICE_MODE_GATE_NAME, resolveInstanceSlug() ?? UNNAMED_INSTANCE);
}
