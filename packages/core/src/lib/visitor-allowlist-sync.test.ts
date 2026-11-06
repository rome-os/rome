import { afterAll, describe, expect, it } from "@rstest/core";
import { SettingsRepository } from "../db/repositories/settings.js";
import { createTestDb } from "../test/helpers.js";
import { DASHBOARD_ACCESS_SETTING_KEY } from "./dashboard-access-config.js";
import { VisitorAllowListSync, syncStoredVisitorAllowList } from "./visitor-allowlist-sync.js";

const ORIGIN = "https://cloud.test";

interface Sent {
  url: string;
  method?: string;
  authorization: string | null;
  body: { emails: string[]; revision: number };
}

// A fake Rome Cloud that records each PUT and answers with the next queued
// status (200 once the queue is empty). `hold` keeps the next send in flight
// until the test releases it.
function fakeCloud(statuses: Array<number | "throw"> = []) {
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
    return new Response(JSON.stringify({ revision: 0, count: 0 }), { status });
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
      data: { revision: 6, count: 2, outcome: "ok" },
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

    await syncStoredVisitorAllowList(settingsRepo, { push: (list) => pushed.push(list) });

    expect(pushed).toEqual([{ emails: ["ada@example.com"], revision: 9 }]);
  });
});
