import type { Approval } from "@/pages/ActivityPage";

/** Stored pairing requests, one per way a request ended. Rome creates none
 *  (docs/domains/people.md#stranger), so these are history only. */
export function pairingFixtures(now = Date.now()): Approval[] {
  const ends = [
    { channel: "telegram", status: "approved", resolution: "web" },
    { channel: "discord", status: "rejected", resolution: "rejected" },
    { channel: "feishu", status: "rejected", resolution: "expired" },
  ] as const;
  return ends.map(({ channel, status, resolution }, index) => ({
    id: `gallery-pairing-${channel}`,
    type: "person_mapping",
    status,
    requestedBy: `${channel}:account-${index}`,
    description: `Pair Alex on ${channel}`,
    payload: {
      action: "channel_pairing",
      channel,
      connectionId: `connection:${channel}`,
      channelUserId: `account-${index}`,
      displayName: "Alex",
      expiresAt: now - 3_000_000,
      failedAttempts: 0,
      lastGuidanceAt: now - 3_600_000,
      resolution,
    },
    createdAt: new Date(now - 3_600_000).toISOString(),
    resolvedAt: new Date(now - 3_300_000).toISOString(),
    resolvedBy: resolution === "expired" ? "system:expiry" : "mock-guardian",
    executedAt: null,
    executionError: null,
  }));
}
