import type { ProviderSessionResetPolicy } from "@rome-os/app-runtime";

export interface ProviderSessionGenerationFreshness {
  createdAt: Date;
  lastActiveAt: Date;
}

export type ProviderSessionResetDecision =
  | { due: false; elapsedMinutes?: number }
  | { due: true; reason: "idle" | "daily"; elapsedMinutes: number };

/**
 * Whether a chat's reset policy says its session is due to be replaced by a
 * fresh one at `interactionAt`. An idle policy counts from the session's last
 * activity, and a daily policy resets once the configured UTC hour has passed
 * since the session was created.
 */
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
