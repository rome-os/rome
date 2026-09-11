import { describe, expect, it } from "@rstest/core";
import {
  LinkedInParticipantProfileSynchronizer,
  type LinkedInParticipantProfileStore,
} from "./linkedin-profile-sync.js";
import type {
  LinkedInParticipantInput,
  LinkedInParticipantProfileSyncState,
  LinkedInThreadParticipantInput,
} from "./linkedin-sync.js";

const ada: LinkedInParticipantInput = {
  participantId: "ACoAAAda0001",
  name: "Ada Lovelace",
  headline: "Engineer",
  profileUrl: "https://www.linkedin.com/in/ACoAAAda0001/",
  type: "member",
  isSelf: false,
};

class ProfileStore implements LinkedInParticipantProfileStore {
  states = new Map<string, LinkedInParticipantProfileSyncState>();
  writes: string[] = [];
  attempts: string[] = [];
  fail = new Set<string>();

  constructor(private readonly now: () => Date) {}

  async getParticipantProfileSyncStates(
    participantIds: string[],
  ): Promise<Map<string, LinkedInParticipantProfileSyncState>> {
    return new Map(
      participantIds.flatMap((id) => {
        const state = this.states.get(id);
        return state ? [[id, state] as const] : [];
      }),
    );
  }

  async upsertParticipantProfile(participant: LinkedInParticipantInput): Promise<void> {
    this.attempts.push(participant.participantId);
    if (this.fail.has(participant.participantId)) throw new Error("profile store unavailable");
    this.writes.push(participant.participantId);
    this.states.set(participant.participantId, {
      participantId: participant.participantId,
      lastSuccessfulSyncAt: this.now(),
      profileSyncFailureCount: 0,
      profileSyncRetryAt: null,
    });
  }

  async recordParticipantProfileSyncFailure(
    participant: LinkedInThreadParticipantInput,
    failureCount: number,
    retryAt: Date,
  ): Promise<void> {
    const previous = this.states.get(participant.participantId);
    this.states.set(participant.participantId, {
      participantId: participant.participantId,
      lastSuccessfulSyncAt: previous?.lastSuccessfulSyncAt ?? null,
      profileSyncFailureCount: failureCount,
      profileSyncRetryAt: retryAt,
    });
  }
}

describe("LinkedInParticipantProfileSynchronizer", () => {
  it("reuses a recent successful profile from durable state", async () => {
    const now = new Date("2026-09-11T06:00:00Z");
    const store = new ProfileStore(() => now);
    store.states.set(ada.participantId, {
      participantId: ada.participantId,
      lastSuccessfulSyncAt: new Date("2026-09-11T05:00:00Z"),
      profileSyncFailureCount: 0,
      profileSyncRetryAt: null,
    });
    const synchronizer = new LinkedInParticipantProfileSynchronizer(store, {
      refreshIntervalMs: 24 * 60 * 60_000,
      now: () => now,
    });

    expect((await synchronizer.sync([ada])).get(ada.participantId)).toBe("fresh");
    expect(store.attempts).toEqual([]);
  });

  it("deduplicates concurrent work for one profile without serializing other profiles", async () => {
    const now = new Date("2026-09-11T06:00:00Z");
    const store = new ProfileStore(() => now);
    const releases = new Map<string, () => void>();
    store.upsertParticipantProfile = async (participant) => {
      store.attempts.push(participant.participantId);
      await new Promise<void>((resolve) => releases.set(participant.participantId, resolve));
      store.writes.push(participant.participantId);
    };
    const grace = { ...ada, participantId: "ACoAAGrace002", name: "Grace Hopper" };
    const synchronizer = new LinkedInParticipantProfileSynchronizer(store, { now: () => now });

    const firstAda = synchronizer.sync([ada]);
    const secondAda = synchronizer.sync([{ ...ada, headline: "Mathematician" }]);
    const graceSync = synchronizer.sync([grace]);
    await Promise.resolve();
    await Promise.resolve();

    expect(store.attempts).toEqual([ada.participantId, grace.participantId]);
    releases.get(ada.participantId)?.();
    releases.get(grace.participantId)?.();
    await Promise.all([firstAda, secondAda, graceSync]);
    expect(store.writes).toEqual([ada.participantId, grace.participantId]);
  });

  it("backs off failures without advancing success and resets after a successful retry", async () => {
    let now = new Date("2026-09-11T06:00:00Z");
    const store = new ProfileStore(() => now);
    const previousSuccess = new Date("2026-09-01T06:00:00Z");
    store.states.set(ada.participantId, {
      participantId: ada.participantId,
      lastSuccessfulSyncAt: previousSuccess,
      profileSyncFailureCount: 0,
      profileSyncRetryAt: null,
    });
    store.fail.add(ada.participantId);
    const synchronizer = new LinkedInParticipantProfileSynchronizer(store, {
      refreshIntervalMs: 24 * 60 * 60_000,
      retryBaseMs: 5 * 60_000,
      retryMaxMs: 6 * 60 * 60_000,
      now: () => now,
    });

    expect((await synchronizer.sync([ada])).get(ada.participantId)).toBe("failed");
    expect(store.states.get(ada.participantId)).toEqual({
      participantId: ada.participantId,
      lastSuccessfulSyncAt: previousSuccess,
      profileSyncFailureCount: 1,
      profileSyncRetryAt: new Date("2026-09-11T06:05:00Z"),
    });
    expect((await synchronizer.sync([ada])).get(ada.participantId)).toBe("backoff");
    expect(store.attempts).toEqual([ada.participantId]);

    now = new Date("2026-09-11T06:05:00Z");
    store.fail.delete(ada.participantId);
    expect((await synchronizer.sync([ada])).get(ada.participantId)).toBe("synced");
    expect(store.states.get(ada.participantId)).toEqual({
      participantId: ada.participantId,
      lastSuccessfulSyncAt: now,
      profileSyncFailureCount: 0,
      profileSyncRetryAt: null,
    });
  });

  it("fails open when freshness cannot be read and records a retry best-effort", async () => {
    const now = new Date("2026-09-11T06:00:00Z");
    const store = new ProfileStore(() => now);
    store.getParticipantProfileSyncStates = async () => {
      throw new Error("profile state unavailable");
    };
    const synchronizer = new LinkedInParticipantProfileSynchronizer(store, {
      retryBaseMs: 5 * 60_000,
      now: () => now,
    });

    await expect(synchronizer.sync([ada])).resolves.toEqual(
      new Map([[ada.participantId, "failed"]]),
    );
    expect(store.writes).toEqual([]);
    expect(store.states.get(ada.participantId)).toMatchObject({
      lastSuccessfulSyncAt: null,
      profileSyncFailureCount: 1,
      profileSyncRetryAt: new Date("2026-09-11T06:05:00Z"),
    });
  });

  it("caps exponential retry deadlines", async () => {
    let now = new Date("2026-09-11T06:00:00Z");
    const store = new ProfileStore(() => now);
    store.fail.add(ada.participantId);
    const synchronizer = new LinkedInParticipantProfileSynchronizer(store, {
      retryBaseMs: 100,
      retryMaxMs: 250,
      now: () => now,
    });

    for (const expectedDelay of [100, 200, 250]) {
      expect((await synchronizer.sync([ada])).get(ada.participantId)).toBe("failed");
      const state = store.states.get(ada.participantId)!;
      expect(state.profileSyncRetryAt!.getTime() - now.getTime()).toBe(expectedDelay);
      now = state.profileSyncRetryAt!;
    }
  });
});
