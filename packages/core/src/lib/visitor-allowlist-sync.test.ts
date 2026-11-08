import { afterAll, describe, expect, it } from "@rstest/core";
import { SettingsRepository } from "../db/repositories/settings.js";
import { createTestDb } from "../test/helpers.js";
import { DASHBOARD_ACCESS_SETTING_KEY } from "./dashboard-access-config.js";
import { DashboardAccessStore } from "./dashboard-access-store.js";
import { VisitorAllowListSync, syncStoredVisitorAllowList } from "./visitor-allowlist-sync.js";

const ORIGIN = "https://cloud.test";

interface Sent {
  url: string;
  method?: string;
  authorization: string | null;
  body: { emails: string[]; revision: number };
}

// A fake Rome Cloud that records each PUT and answers with the next queued
// status (200 once the queue is empty). Like Rome Cloud, it keeps the highest
// revision it has seen, starting from `held`, and answers with it. `hold`
// keeps the next send in flight until the test releases it.
function fakeCloud(statuses: Array<number | "throw"> = [], opts: { held?: number } = {}) {
  let held = opts.held ?? 0;
  const sent: Sent[] = [];
  let release: (() => void) | null = null;
  let holdNext = false;
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sent.push({
      url: String(input),
      method: init?.method,
      authorization: headers.get("authorization"),
      body: JSON.parse(String(init?.body)) as Sent["body"],
    });
    if (holdNext) {
      holdNext = false;
      await new Promise<void>((resolve) => (release = resolve));
    }
    const status = statuses.shift() ?? 200;
    if (status === "throw") throw new Error("connect ECONNREFUSED");
    const { emails, revision } = JSON.parse(String(init?.body)) as Sent["body"];
    if (status >= 200 && status < 300) held = Math.max(held, revision);
    return new Response(
      JSON.stringify({ revision: held, count: emails.length, unmatched: emails.slice(0, 1) }),
      { status },
    );
  }) as typeof fetch;
  return {
    sent,
    fetchImpl,
    hold: () => (holdNext = true),
    release: () => release?.(),
  };
}

function recordingLogger() {
  const lines: unknown[] = [];
  const record = (message: string, data?: unknown) => lines.push({ message, data });
  return { lines, logger: { debug: record, info: record, warn: record } };
}

async function settle(sync: VisitorAllowListSync): Promise<void> {
  // Retries in these tests wait 0 ms; let their timers fire, then drain.
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await sync.idle();
  }
}

describe("VisitorAllowListSync", () => {
  it("sends the whole list, lowercased and deduped, with its revision and the instance credential", async () => {
    const cloud = fakeCloud();
    const sync = new VisitorAllowListSync({
      getEnrollmentId: () => "enrollment-1",
      getToken: () => "inst-token",
      getOrigin: () => ORIGIN,
      fetchImpl: cloud.fetchImpl,
    });

    sync.push({ emails: ["Lin@Example.com", "ada@example.com", "lin@example.com"], revision: 7 });
    await settle(sync);

    expect(cloud.sent).toEqual([
      {
        url: `${ORIGIN}/api/instance/visitors`,
        method: "PUT",
        authorization: "Bearer inst-token",
        body: { emails: ["ada@example.com", "lin@example.com"], revision: 7 },
      },
    ]);
  });

  it("does nothing on an unlinked instance or without a Rome Cloud origin", async () => {
    const cloud = fakeCloud();
    const noToken = new VisitorAllowListSync({
      getEnrollmentId: () => null,
      getToken: () => "inst-token",
      getOrigin: () => ORIGIN,
      fetchImpl: cloud.fetchImpl,
    });
    const noOrigin = new VisitorAllowListSync({
      getEnrollmentId: () => "enrollment-1",
      getToken: () => "inst-token",
      getOrigin: () => null,
      fetchImpl: cloud.fetchImpl,
    });

    noToken.push({ emails: ["ada@example.com"], revision: 1 });
    noOrigin.push({ emails: ["ada@example.com"], revision: 1 });
    await settle(noToken);
    await settle(noOrigin);

    expect(cloud.sent).toEqual([]);
  });

  it("sends a skipped list once the instance links", async () => {
    const cloud = fakeCloud();
    let enrollment: string | null = null;
    const sync = new VisitorAllowListSync({
      getEnrollmentId: () => enrollment,
      getToken: () => "inst-token",
      getOrigin: () => ORIGIN,
      fetchImpl: cloud.fetchImpl,
    });

    sync.push({ emails: ["ada@example.com"], revision: 3 });
    await settle(sync);
    expect(cloud.sent).toEqual([]);

    enrollment = "enrollment-1";
    sync.push({ emails: ["ada@example.com"], revision: 3 });
    await settle(sync);
    expect(cloud.sent.map((s) => s.body.revision)).toEqual([3]);

    // Already accepted: the same revision is not sent again.
    sync.push({ emails: ["ada@example.com"], revision: 3 });
    await settle(sync);
    expect(cloud.sent).toHaveLength(1);
  });

  it("sends an unchanged list again to a new enrollment after an unlink", async () => {
    const cloud = fakeCloud();
    let enrollment: string | null = "key-1";
    let linkChanged = () => {};
    const sync = new VisitorAllowListSync({
      getEnrollmentId: () => enrollment,
      getToken: () => "inst-token",
      getOrigin: () => ORIGIN,
      onLinkChanged: (listener) => {
        linkChanged = listener;
        return () => {};
      },
      fetchImpl: cloud.fetchImpl,
    });

    sync.push({ emails: ["ada@example.com"], revision: 3 });
    await settle(sync);
    expect(cloud.sent).toHaveLength(1);

    // Unlinked: nothing to send to.
    enrollment = null;
    linkChanged();
    await settle(sync);
    expect(cloud.sent).toHaveLength(1);

    // Enrolled again with the same signer key: the same list goes to the new enrollment.
    enrollment = "key-1";
    linkChanged();
    await settle(sync);
    expect(cloud.sent.map((s) => s.body)).toEqual([
      { emails: ["ada@example.com"], revision: 3 },
      { emails: ["ada@example.com"], revision: 3 },
    ]);

    // A different credential, found by the boot or link push, is a new enrollment too.
    enrollment = "key-2";
    sync.push({ emails: ["ada@example.com"], revision: 3 });
    await settle(sync);
    expect(cloud.sent).toHaveLength(3);
  });

  it("does not let a send from before a relink count for the new enrollment", async () => {
    const cloud = fakeCloud();
    let linkChanged = () => {};
    const sync = new VisitorAllowListSync({
      getEnrollmentId: () => "key-1",
      getToken: () => "inst-token",
      getOrigin: () => ORIGIN,
      onLinkChanged: (listener) => {
        linkChanged = listener;
        return () => {};
      },
      fetchImpl: cloud.fetchImpl,
    });

    cloud.hold();
    sync.push({ emails: ["ada@example.com"], revision: 4 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    linkChanged();
    cloud.release();
    await settle(sync);

    expect(cloud.sent.map((s) => s.body.revision)).toEqual([4, 4]);

    sync.push({ emails: ["ada@example.com"], revision: 4 });
    await settle(sync);
    expect(cloud.sent).toHaveLength(2);
  });

  it("sends only the newest list and never an older one after it", async () => {
    const cloud = fakeCloud();
    const sync = new VisitorAllowListSync({
      getEnrollmentId: () => "enrollment-1",
      getToken: () => "inst-token",
      getOrigin: () => ORIGIN,
      fetchImpl: cloud.fetchImpl,
    });

    cloud.hold();
    sync.push({ emails: ["a@example.com"], revision: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    sync.push({ emails: ["b@example.com"], revision: 2 });
    sync.push({ emails: ["c@example.com"], revision: 3 });
    sync.push({ emails: ["stale@example.com"], revision: 2 });
    cloud.release();
    await settle(sync);

    expect(cloud.sent.map((s) => s.body)).toEqual([
      { emails: ["a@example.com"], revision: 1 },
      { emails: ["c@example.com"], revision: 3 },
    ]);
  });

  it("sends a list pushed just as the previous send finishes", async () => {
    // The push lands 0 to 9 microtasks after the send is accepted, which covers
    // the moment the previous send settles and the sync releases its running flag.
    for (let hops = 0; hops < 10; hops++) {
      const cloud = fakeCloud();
      let sync: VisitorAllowListSync | null = null;
      const pushLater = async () => {
        for (let i = 0; i < hops; i++) await Promise.resolve();
        sync?.push({ emails: ["b@example.com"], revision: 2 });
      };
      const record = (message: string, data?: unknown) => {
        if (
          message === "visitor allow-list synced" &&
          (data as { revision: number }).revision === 1
        )
          void pushLater();
      };
      sync = new VisitorAllowListSync({
        getEnrollmentId: () => "enrollment-1",
        getToken: () => "inst-token",
        getOrigin: () => ORIGIN,
        fetchImpl: cloud.fetchImpl,
        logger: { debug: record, info: record, warn: record },
      });

      sync.push({ emails: ["a@example.com"], revision: 1 });
      await settle(sync);

      expect({ hops, sent: cloud.sent.map((s) => s.body.revision) }).toEqual({
        hops,
        sent: [1, 2],
      });
    }
  });

  it("retries a linked instance that has no bearer for a moment, with no further push", async () => {
    const cloud = fakeCloud();
    const bearers: Array<string | null> = [null, null];
    const sync = new VisitorAllowListSync({
      getEnrollmentId: () => "enrollment-1",
      // The signer is down for two tries, then recovers.
      getToken: () => (bearers.length > 0 ? (bearers.shift() ?? null) : "signer-token"),
      getOrigin: () => ORIGIN,
      fetchImpl: cloud.fetchImpl,
      retryDelaysMs: [0],
    });

    sync.push({ emails: ["ada@example.com"], revision: 8 });
    await settle(sync);

    expect(cloud.sent.map((s) => [s.body.revision, s.authorization])).toEqual([
      [8, "Bearer signer-token"],
    ]);
  });

  it("retries an unreachable or failing Rome Cloud in the background", async () => {
    const cloud = fakeCloud(["throw", 503]);
    const sync = new VisitorAllowListSync({
      getEnrollmentId: () => "enrollment-1",
      getToken: () => "inst-token",
      getOrigin: () => ORIGIN,
      fetchImpl: cloud.fetchImpl,
      retryDelaysMs: [0],
    });

    sync.push({ emails: ["ada@example.com"], revision: 4 });
    await settle(sync);

    expect(cloud.sent.map((s) => s.body.revision)).toEqual([4, 4, 4]);
  });

  it("does not retry a list Rome Cloud refuses, but sends it again on the next push", async () => {
    const cloud = fakeCloud([401]);
    const sync = new VisitorAllowListSync({
      getEnrollmentId: () => "enrollment-1",
      getToken: () => "inst-token",
      getOrigin: () => ORIGIN,
      fetchImpl: cloud.fetchImpl,
      retryDelaysMs: [0],
    });

    sync.push({ emails: ["ada@example.com"], revision: 5 });
    await settle(sync);
    expect(cloud.sent).toHaveLength(1);

    sync.push({ emails: ["ada@example.com"], revision: 5 });
    await settle(sync);
    expect(cloud.sent.map((s) => s.body.revision)).toEqual([5, 5]);
  });

  it("logs counts, revisions and outcomes, never an email", async () => {
    const { lines, logger } = recordingLogger();
    const cloud = fakeCloud([503, 200, 400]);
    const sync = new VisitorAllowListSync({
      getEnrollmentId: () => "enrollment-1",
      getToken: () => "inst-token",
      getOrigin: () => ORIGIN,
      fetchImpl: cloud.fetchImpl,
      retryDelaysMs: [0],
      logger,
    });

    sync.push({ emails: ["ada@example.com", "lin@example.com"], revision: 6 });
    await settle(sync);
    sync.push({ emails: ["ada@example.com"], revision: 7 });
    await settle(sync);

    expect(lines).toContainEqual({
      message: "visitor allow-list synced",
      data: { revision: 6, count: 2, outcome: "ok", cloudRevision: 6, unmatched: 1 },
    });
    expect(lines).toContainEqual({
      message: "visitor allow-list sync failed",
      data: { revision: 7, count: 1, outcome: "rejected", status: 400, attempt: 1 },
    });
    expect(JSON.stringify(lines)).not.toContain("@");
  });
});

describe("syncStoredVisitorAllowList", () => {
  const testDb = createTestDb();
  afterAll(() => testDb.close());

  it("queues the stored list with its stored revision", async () => {
    const settingsRepo = new SettingsRepository(testDb.db);
    await settingsRepo.set(DASHBOARD_ACCESS_SETTING_KEY, {
      cloudEmailAccess: ["Ada@Example.com"],
      revision: 9,
    });
    const pushed: unknown[] = [];

    await syncStoredVisitorAllowList(new DashboardAccessStore(settingsRepo), {
      push: (list) => pushed.push(list),
    });

    expect(pushed).toEqual([{ emails: ["ada@example.com"], revision: 9 }]);
  });
});

describe("VisitorAllowListSync — Rome Cloud ahead", () => {
  const testDb = createTestDb();
  afterAll(() => testDb.close());

  it("raises the stored revision past Rome Cloud's and sends the list again", async () => {
    // This instance's database was restored from a backup at revision 2, and
    // Rome Cloud still holds revision 7 from before.
    const settingsRepo = new SettingsRepository(testDb.db);
    await settingsRepo.set(DASHBOARD_ACCESS_SETTING_KEY, {
      cloudEmailAccess: ["ada@example.com"],
      revision: 2,
    });
    const store = new DashboardAccessStore(settingsRepo);
    const cloud = fakeCloud([], { held: 7 });
    const sync = new VisitorAllowListSync({
      getEnrollmentId: () => "enrollment-1",
      getToken: () => "inst-token",
      getOrigin: () => ORIGIN,
      onLinkChanged: () => () => {},
      raiseRevisionPast: (floor) => store.raisePast(floor),
      fetchImpl: cloud.fetchImpl,
    });

    await syncStoredVisitorAllowList(store, sync);
    await settle(sync);

    expect(cloud.sent.map((s) => s.body)).toEqual([
      { emails: ["ada@example.com"], revision: 2 },
      { emails: ["ada@example.com"], revision: 8 },
    ]);
    expect(await settingsRepo.get(DASHBOARD_ACCESS_SETTING_KEY)).toEqual({
      cloudEmailAccess: ["ada@example.com"],
      revision: 8,
    });

    // The next save continues from there.
    expect((await store.save({ cloudEmailAccess: [] })).revision).toBe(9);
  });
});

describe("DashboardAccessStore", () => {
  const testDb = createTestDb();
  afterAll(() => testDb.close());

  it("gives concurrent saves and raises their own revisions in order", async () => {
    const store = new DashboardAccessStore(new SettingsRepository(testDb.db));

    const results = await Promise.all([
      store.save({ cloudEmailAccess: ["a@example.com"] }),
      store.raisePast(4),
      store.save({ cloudEmailAccess: ["b@example.com"] }),
      store.raisePast(2),
    ]);

    expect(results).toEqual([
      { emails: ["a@example.com"], revision: 1 },
      { emails: ["a@example.com"], revision: 5 },
      { emails: ["b@example.com"], revision: 6 },
      { emails: ["b@example.com"], revision: 6 },
    ]);
    expect(await store.read()).toEqual({ emails: ["b@example.com"], revision: 6 });
  });
});

// A fake Rome Cloud with the agreed contract: it stores a list whose revision
// is at least the stored one (an equal revision replaces it) and answers
// `{revision, applied, unmatched}`. `accounts` are the emails with a Rome Cloud
// account. `hold` keeps the next send in flight until the test releases it.
function appliedCloud(opts: { revision?: number; emails?: string[]; accounts?: string[] } = {}) {
  const state = { revision: opts.revision ?? -1, emails: opts.emails ?? [] };
  const accounts = new Set(opts.accounts ?? []);
  const sent: Array<{ emails: string[]; revision: number }> = [];
  let release: (() => void) | null = null;
  let holdNext = false;
  const failures: number[] = [];
  const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { emails: string[]; revision: number };
    sent.push(body);
    const failure = failures.shift();
    // Rome Cloud decides when the request arrives; a held send only answers late.
    const applied = !failure && body.revision >= state.revision;
    if (applied) Object.assign(state, body);
    const unmatched = applied ? body.emails.filter((email) => !accounts.has(email)) : [];
    if (holdNext) {
      holdNext = false;
      await new Promise<void>((resolve) => (release = resolve));
    }
    if (failure) return new Response("{}", { status: failure });
    return new Response(JSON.stringify({ revision: state.revision, applied, unmatched }), {
      status: 200,
    });
  }) as typeof fetch;
  return {
    state,
    sent,
    accounts,
    fetchImpl,
    failNext: (status: number) => failures.push(status),
    hold: () => (holdNext = true),
    release: () => release?.(),
  };
}

function linkedSync(cloud: { fetchImpl: typeof fetch }, store?: DashboardAccessStore) {
  return new VisitorAllowListSync({
    getEnrollmentId: () => "enrollment-1",
    getToken: () => "inst-token",
    getOrigin: () => ORIGIN,
    onLinkChanged: () => () => {},
    raiseRevisionPast: store ? (floor) => store.raisePast(floor) : undefined,
    fetchImpl: cloud.fetchImpl,
    retryDelaysMs: [0],
    resyncDelayMs: 0,
  });
}

describe("VisitorAllowListSync — applied contract", () => {
  const testDb = createTestDb();
  afterAll(() => testDb.close());

  async function storeAt(revision: number, emails: string[]): Promise<DashboardAccessStore> {
    const settingsRepo = new SettingsRepository(testDb.db);
    await settingsRepo.set(DASHBOARD_ACCESS_SETTING_KEY, { cloudEmailAccess: emails, revision });
    return new DashboardAccessStore(settingsRepo);
  }

  it("ends with Rome Cloud holding the newest list when a save lands during a boot send after a reset", async () => {
    // Rome Cloud holds revision 1. The instance database was reset to 0.
    const cloud = appliedCloud({ revision: 1, emails: ["old@example.com"] });
    const store = await storeAt(0, ["a@example.com"]);
    const sync = linkedSync(cloud, store);

    cloud.hold();
    await syncStoredVisitorAllowList(store, sync);
    await new Promise((resolve) => setTimeout(resolve, 0));
    sync.push(await store.save({ cloudEmailAccess: ["c@example.com"] }));
    cloud.release();
    await settle(sync);

    expect(cloud.state).toEqual({ revision: 1, emails: ["c@example.com"] });
    // Delivered: the same list is not sent again.
    const sends = cloud.sent.length;
    sync.push(await store.read());
    await settle(sync);
    expect(cloud.sent).toHaveLength(sends);
  });

  it("delivers a save whose revision equals the one Rome Cloud holds after a restore", async () => {
    // Rome Cloud holds a different list at 5. The instance was restored to 4,
    // its boot send failed, and the guardian then saves revision 5.
    const cloud = appliedCloud({ revision: 5, emails: ["a@example.com"] });
    const store = await storeAt(4, ["b@example.com"]);
    const sync = new VisitorAllowListSync({
      getEnrollmentId: () => "enrollment-1",
      getToken: () => "inst-token",
      getOrigin: () => ORIGIN,
      onLinkChanged: () => () => {},
      raiseRevisionPast: (floor) => store.raisePast(floor),
      fetchImpl: cloud.fetchImpl,
      retryDelaysMs: [60_000],
    });

    cloud.failNext(503);
    await syncStoredVisitorAllowList(store, sync);
    await settle(sync);
    sync.push(await store.save({ cloudEmailAccess: ["c@example.com"] }));
    await settle(sync);
    sync.stop();

    expect(cloud.state).toEqual({ revision: 5, emails: ["c@example.com"] });
  });

  it("raises past Rome Cloud's revision and sends again when Rome Cloud did not apply the list", async () => {
    const cloud = appliedCloud({ revision: 7, emails: ["x@example.com"] });
    const store = await storeAt(2, ["a@example.com"]);
    const sync = linkedSync(cloud, store);

    await syncStoredVisitorAllowList(store, sync);
    await settle(sync);

    expect(cloud.sent.map((list) => list.revision)).toEqual([2, 8]);
    expect(cloud.state).toEqual({ revision: 8, emails: ["a@example.com"] });
    expect((await store.read()).revision).toBe(8);
  });

  it("sends the list once more when an invited email without an account signs in, and only then", async () => {
    const cloud = appliedCloud({ accounts: ["visitor@example.com"] });
    const sync = linkedSync(cloud);

    sync.push({
      emails: ["visitor@example.com", "invitee@example.com", "invitee2@example.com"],
      revision: 3,
    });
    await settle(sync);
    expect(cloud.sent).toHaveLength(1);

    // A visitor Rome Cloud already matched: nothing to resend.
    sync.visitorSignedIn("visitor@example.com");
    await settle(sync);
    expect(cloud.sent).toHaveLength(1);

    // Both invitees sign up and sign in at once: one resend.
    cloud.accounts.add("invitee@example.com");
    cloud.accounts.add("invitee2@example.com");
    sync.visitorSignedIn("Invitee@Example.com");
    sync.visitorSignedIn("invitee@example.com");
    sync.visitorSignedIn("invitee2@example.com");
    await settle(sync);
    expect(cloud.sent).toHaveLength(2);
    expect(cloud.sent[1]).toEqual(cloud.sent[0]);

    // Rome Cloud now matches them, so later sign-ins send nothing.
    sync.visitorSignedIn("invitee@example.com");
    await settle(sync);
    expect(cloud.sent).toHaveLength(2);
  });

  it("resends after a sign-in that lands while a send Rome Cloud answered before the sign-up is in flight", async () => {
    const cloud = appliedCloud();
    const sync = linkedSync(cloud);
    sync.push({ emails: ["invitee@example.com"], revision: 1 });
    await settle(sync);

    // A save goes out and Rome Cloud processes it before the invitee signs up.
    cloud.hold();
    sync.push({ emails: ["invitee@example.com", "lin@example.com"], revision: 2 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The invitee signs up and signs in while that answer is still on its way.
    cloud.accounts.add("invitee@example.com");
    sync.visitorSignedIn("invitee@example.com");
    await new Promise((resolve) => setTimeout(resolve, 5));
    cloud.release();
    await settle(sync);

    expect(cloud.sent.map((list) => list.revision)).toEqual([1, 2, 2]);
    expect(cloud.state.revision).toBe(2);
  });
});
