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
