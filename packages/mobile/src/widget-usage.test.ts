import { describe, expect, it } from "@rstest/core";
import {
  buildWidgetTimeline,
  createOfflineWidgetSnapshot,
  createWidgetUsageSnapshot,
} from "./widget-usage.js";

const NOW = new Date("2026-08-11T12:00:00.000Z").getTime();

function apiState() {
  return {
    codex: {
      loggedIn: true,
      email: "private@example.com",
      quotaExhausted: false,
      usage: {
        checkedAt: "2026-08-11T11:55:00.000Z",
        source: "/Users/private/.codex/rate-limits.json",
        fiveHour: { usedPercent: 42.34, remainingPercent: 57.66, resetsAt: "2026-08-11T14:00:00Z" },
        sevenDay: { usedPercent: 75, remainingPercent: 25 },
      },
    },
    claude: { loggedIn: false, quotaExhausted: false },
    codexLogin: { lastError: "must not reach the Widget" },
  };
}

describe("createWidgetUsageSnapshot", () => {
  it("projects the AI Tools response into a small, non-sensitive Widget payload", () => {
    const snapshot = createWidgetUsageSnapshot(apiState(), NOW);

    expect(snapshot).toEqual({
      schemaVersion: 1,
      state: "ready",
      updatedAt: NOW,
      providers: [
        {
          id: "codex",
          status: "ready",
          quotaExhausted: false,
          checkedAt: new Date("2026-08-11T11:55:00.000Z").getTime(),
          fiveHour: {
            usedPercent: 42.3,
            resetsAt: new Date("2026-08-11T14:00:00.000Z").getTime(),
          },
          sevenDay: { usedPercent: 75 },
        },
        { id: "claude", status: "not-connected", quotaExhausted: false },
      ],
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("private@example.com");
    expect(serialized).not.toContain("rate-limits.json");
    expect(serialized).not.toContain("lastError");
  });

  it("returns null for a malformed response", () => {
    expect(createWidgetUsageSnapshot(null, NOW)).toBeNull();
    expect(createWidgetUsageSnapshot("bad", NOW)).toBeNull();
  });

  it("lets explicit disconnection override retained usage", () => {
    const value = apiState();
    value.codex.loggedIn = false;
    value.codex.quotaExhausted = true;

    expect(createWidgetUsageSnapshot(value, NOW)?.providers[0]).toEqual({
      id: "codex",
      status: "not-connected",
      quotaExhausted: false,
    });
  });
});

describe("Widget timeline", () => {
  it("publishes only the current snapshot", () => {
    const snapshot = createWidgetUsageSnapshot(apiState(), NOW)!;
    const timeline = buildWidgetTimeline(snapshot, NOW);
    expect(timeline).toEqual([{ date: new Date(NOW), props: snapshot }]);
  });

  it("retains last-known values when marking a failed refresh offline", () => {
    const snapshot = createWidgetUsageSnapshot(apiState(), NOW)!;
    const offline = createOfflineWidgetSnapshot(snapshot, NOW + 1_000);
    expect(offline.state).toBe("offline");
    expect(offline.providers).toEqual(snapshot.providers);
  });
});
