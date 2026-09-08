import type { Approval } from "@/pages/ActivityPage";

export const PAIRING_FIXTURE_CODE = "ROME-PAIR-0123456789ABCDEF0123";

export function pairingFixtures(now = Date.now()): Approval[] {
  return ["telegram", "discord", "feishu"].map((channel, index) => ({
    id: `gallery-pairing-${channel}`,
    type: "person_mapping",
    status: "pending",
    requestedBy: `${channel}:account-${index}`,
    description: `Pair Alex on ${channel}`,
    payload: {
      action: "channel_pairing",
      channel,
      connectionId: `connection:${channel}`,
      channelUserId: `account-${index}`,
      displayName: "Alex",
      expiresAt: now + 600_000,
      failedAttempts: 0,
      lastGuidanceAt: now,
    },
    createdAt: new Date(now).toISOString(),
    resolvedAt: null,
    resolvedBy: null,
    executedAt: null,
    executionError: null,
  }));
}
