/**
 * Vendor-neutral feature-flag access, shared across core.
 *
 * A *gate* is a named boolean rollout decision evaluated for a *unit id* — the
 * rollout key, e.g. a user, instance, or tenant id. Backends **fail closed**: a
 * gate that cannot be evaluated reads `false`, so an unconfigured or unreachable
 * backend disables features rather than enabling them by accident.
 *
 * The active backend is process-global. `initStatsig` installs the real one at
 * boot (see ./statsig.ts); tests install a fake (see ./testing.ts). Callers only
 * ever touch `checkGate` and never see which backend is wired — so this module
 * holds no vendor or feature-specific logic (cloud-auth lives in
 * `../cloud-auth-gate.ts`, which is just one caller).
 */
export interface FeatureGates {
  checkGate(gateName: string, unitId: string, email?: string): Promise<boolean>;
}

// Default backend: every gate is off. In force until a backend is installed, so
// any gate checked before/without init is safely disabled.
const DISABLED: FeatureGates = { checkGate: async () => false };

let active: FeatureGates = DISABLED;

// Forced gate values, consulted by `checkGate` BEFORE the active backend. Held
// as durable state (not a backend decorator) so an override survives a later
// `setFeatureGates`/`initStatsig` — install order of backend vs override no
// longer matters. Populated by the `FEATURE_GATE_*` env overrides
// (see ./env-overrides.ts) so a gate can be forced on/off with no Statsig
// project wired — local dev, CI, or break-glass.
const overrides = new Map<string, boolean>();

/** Install the process-global feature-flag backend. Leaves overrides intact. */
export function setFeatureGates(gates: FeatureGates): void {
  active = gates;
}

/** Restore the default all-off backend and clear overrides (tests between cases). */
export function resetFeatureGates(): void {
  active = DISABLED;
  overrides.clear();
}

/** Force a gate to a fixed value, winning over the active backend regardless of
 * install order. Pass `undefined` to clear a single override. */
export function setGateOverride(gateName: string, value: boolean | undefined): void {
  if (value === undefined) overrides.delete(gateName);
  else overrides.set(gateName, value);
}

/** Evaluate a feature gate for a unit, and for `email` when its rules match on email.
 * An override wins; otherwise the active backend decides. Fails closed. */
export function checkGate(gateName: string, unitId: string, email?: string): Promise<boolean> {
  const forced = overrides.get(gateName);
  if (forced !== undefined) return Promise.resolve(forced);
  return active.checkGate(gateName, unitId, email);
}
