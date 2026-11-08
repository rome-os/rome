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
    return new Response(JSON.stringify({ revision: held, count: emails.length }), { status });
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
      data: { revision: 6, count: 2, outcome: "ok", cloudRevision: 6 },
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
      signedIn: [],
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
// `{revision, applied}`. `accounts` are the emails with a Rome Cloud
// account. `hold` keeps the next send in flight until the test releases it.
function appliedCloud(opts: { revision?: number; emails?: string[]; accounts?: string[] } = {}) {
  const state = { revision: opts.revision ?? -1, emails: opts.emails ?? [] };
  const accounts = new Set(opts.accounts ?? []);
  const visitors: string[] = [];
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
    // Rome Cloud matches the listed emails to accounts as it applies the list.
    const matched = applied ? body.emails.filter((email) => accounts.has(email)) : [];
    if (applied) visitors.splice(0, visitors.length, ...matched);
    if (holdNext) {
      holdNext = false;
      await new Promise<void>((resolve) => (release = resolve));
    }
    if (failure) return new Response("{}", { status: failure });
    return new Response(JSON.stringify({ revision: state.revision, applied }), {
      status: 200,
    });
  }) as typeof fetch;
  return {
    state,
    sent,
    accounts,
    visitors,
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

  it("still ends with the newest list when Rome Cloud is above both the boot send and the queued save", async () => {
    // Rome Cloud holds 3. The reset instance's boot sends 0 and a save queues 1
    // during it, so the first answer's revision is not acted on. The save's own
    // answer carries it again.
    const cloud = appliedCloud({ revision: 3, emails: ["old@example.com"] });
    const store = await storeAt(0, ["a@example.com"]);
    const sync = linkedSync(cloud, store);

    cloud.hold();
    await syncStoredVisitorAllowList(store, sync);
    await new Promise((resolve) => setTimeout(resolve, 0));
    sync.push(await store.save({ cloudEmailAccess: ["c@example.com"] }));
    cloud.release();
    await settle(sync);

    expect(cloud.sent.map((list) => list.revision)).toEqual([0, 1, 4]);
    expect(cloud.state).toEqual({ revision: 4, emails: ["c@example.com"] });
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

  it("raises nothing and stops when Rome Cloud does not apply a list without a higher revision", async () => {
    const lines: unknown[] = [];
    const record = (message: string, data?: unknown) => lines.push({ message, data });
    let raises = 0;
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ revision: 2, applied: false }), {
        status: 200,
      })) as typeof fetch;
    const sync = new VisitorAllowListSync({
      getEnrollmentId: () => "enrollment-1",
      getToken: () => "inst-token",
      getOrigin: () => ORIGIN,
      onLinkChanged: () => () => {},
      raiseRevisionPast: async (floor) => {
        raises += 1;
        return { emails: [], revision: floor + 1 };
      },
      fetchImpl,
      retryDelaysMs: [0],
      logger: { debug: record, info: record, warn: record },
    });

    sync.push({ emails: ["a@example.com"], revision: 2 });
    await settle(sync);

    expect(raises).toBe(0);
    expect(lines).toContainEqual({
      message: "visitor allow-list not applied",
      data: { revision: 2, cloudRevision: 2 },
    });
    // Not delivered: the next push sends it again.
    sync.push({ emails: ["a@example.com"], revision: 2 });
    await settle(sync);
    expect(
      lines.filter((line) => (line as { message: string }).message === "visitor allow-list synced"),
    ).toHaveLength(2);
  });

  it("sends the applied list once more on a requested resend, once per burst", async () => {
    const cloud = appliedCloud();
    const sync = linkedSync(cloud);
    sync.push({ emails: ["invitee@example.com"], revision: 3 });
    await settle(sync);
    expect(cloud.sent).toHaveLength(1);

    sync.requestResend();
    sync.requestResend();
    sync.requestResend();
    await settle(sync);
    expect(cloud.sent).toHaveLength(2);
    expect(cloud.sent[1]).toEqual(cloud.sent[0]);
  });

  it("keeps a first sign-in that lands while the first send is still in flight", async () => {
    // No earlier sync: the very first PUT is held open across the sign-up and sign-in.
    const cloud = appliedCloud();
    const sync = linkedSync(cloud);

    cloud.hold();
    sync.push({ emails: ["invitee@example.com"], revision: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    cloud.accounts.add("invitee@example.com");
    sync.requestResend();
    await new Promise((resolve) => setTimeout(resolve, 5));
    cloud.release();
    await settle(sync);

    expect(cloud.sent.map((list) => list.revision)).toEqual([1, 1]);
    expect(cloud.visitors).toEqual(["invitee@example.com"]);
  });
});

describe("DashboardAccessStore — visitor sign-ins", () => {
  const testDb = createTestDb();
  afterAll(() => testDb.close());

  it("counts only a listed email's first sign-in, and forgets it when the email leaves the list", async () => {
    const settingsRepo = new SettingsRepository(testDb.db);
    const store = new DashboardAccessStore(settingsRepo);
    await store.save({ cloudEmailAccess: ["ada@example.com", "lin@example.com"] });

    expect(await store.recordVisitorSignIn("Ada@Example.com")).toBe(true);
    expect(await store.recordVisitorSignIn("ada@example.com")).toBe(false);
    expect(await store.recordVisitorSignIn("stranger@example.com")).toBe(false);

    // Survives a raise and a save that keeps the email.
    await store.raisePast(5);
    await store.save({ cloudEmailAccess: ["ada@example.com", "lin@example.com"] });
    expect(await store.recordVisitorSignIn("ada@example.com")).toBe(false);

    // Removed, then added back: the next sign-in is a first one again.
    await store.save({ cloudEmailAccess: ["lin@example.com"] });
    await store.save({ cloudEmailAccess: ["ada@example.com", "lin@example.com"] });
    expect(await store.recordVisitorSignIn("ada@example.com")).toBe(true);
    expect((await store.read()).emails).toEqual(["ada@example.com", "lin@example.com"]);
  });
});
