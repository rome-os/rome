import type { ProviderSessionResetPolicy } from "@rome-os/app-runtime";

export const DEFAULT_PROVIDER_SESSION_RESET_POLICY = {
  mode: "idle",
  idleMinutes: 7 * 24 * 60,
} as const satisfies ProviderSessionResetPolicy;

export function assertProviderSessionResetPolicy(
  value: unknown,
): asserts value is ProviderSessionResetPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error('Invalid value for conversation setting "session.reset"');
  }
  const policy = value as Record<string, unknown>;
  if (policy.mode === "none") {
    assertExactKeys(policy, ["mode"]);
    return;
  }
  if (policy.mode === "idle") {
    assertExactKeys(policy, ["mode", "idleMinutes"]);
    if (
      !Number.isInteger(policy.idleMinutes) ||
      (policy.idleMinutes as number) < 1 ||
      (policy.idleMinutes as number) > 525_600
    ) {
      throw new Error(
        'Conversation setting "session.reset.idleMinutes" must be an integer from 1 through 525600',
      );
    }
    return;
  }
  if (policy.mode === "daily") {
    assertExactKeys(policy, ["mode", "atHour"]);
    if (
      !Number.isInteger(policy.atHour) ||
      (policy.atHour as number) < 0 ||
      (policy.atHour as number) > 23
    ) {
      throw new Error(
        'Conversation setting "session.reset.atHour" must be an integer from 0 through 23',
      );
    }
    return;
  }
  throw new Error('Invalid value for conversation setting "session.reset"');
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new Error(`Unsupported conversation setting "session.reset.${key}"`);
    }
  }
}

export interface ProviderSessionGenerationFreshness {
  createdAt: Date;
  lastActiveAt: Date;
}

export type ProviderSessionResetDecision =
  | { due: false; elapsedMinutes?: number }
  | { due: true; reason: "idle" | "daily"; elapsedMinutes: number };

export function evaluateProviderSessionReset(
  policy: ProviderSessionResetPolicy,
  generation: ProviderSessionGenerationFreshness,
  interactionAt: Date,
): ProviderSessionResetDecision {
  if (policy.mode === "none") return { due: false };
  if (policy.mode === "idle") {
    const freshness = generation.lastActiveAt;
    const boundary = new Date(freshness.getTime() + policy.idleMinutes * 60_000);
    const elapsedMinutes = Math.max(0, (interactionAt.getTime() - freshness.getTime()) / 60_000);
    return interactionAt >= boundary
      ? { due: true, reason: "idle", elapsedMinutes }
      : { due: false, elapsedMinutes };
  }

  const generationBucket = dailyBucket(generation.createdAt, policy.atHour);
  const interactionBucket = dailyBucket(interactionAt, policy.atHour);
  const elapsedMinutes = Math.max(
    0,
    (interactionAt.getTime() - generation.createdAt.getTime()) / 60_000,
  );
  return generationBucket < interactionBucket
    ? { due: true, reason: "daily", elapsedMinutes }
    : { due: false, elapsedMinutes };
}

function dailyBucket(instant: Date, atHour: number): number {
  const boundary = new Date(instant);
  boundary.setUTCHours(atHour, 0, 0, 0);
  if (instant < boundary) boundary.setUTCDate(boundary.getUTCDate() - 1);
  return boundary.getTime();
}
