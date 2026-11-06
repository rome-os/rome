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

  it("does nothing without an instance credential or a Rome Cloud origin", async () => {
    const cloud = fakeCloud();
    const noToken = new VisitorAllowListSync({
      getToken: () => null,
      getOrigin: () => ORIGIN,
      fetchImpl: cloud.fetchImpl,
    });
    const noOrigin = new VisitorAllowListSync({
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

  it("sends a skipped list once the instance has a credential", async () => {
    const cloud = fakeCloud();
    let token: string | null = null;
    const sync = new VisitorAllowListSync({
      getToken: () => token,
      getOrigin: () => ORIGIN,
      fetchImpl: cloud.fetchImpl,
    });

    sync.push({ emails: ["ada@example.com"], revision: 3 });
    await settle(sync);
    expect(cloud.sent).toEqual([]);

    token = "inst-token";
    sync.push({ emails: ["ada@example.com"], revision: 3 });
    await settle(sync);
    expect(cloud.sent.map((s) => s.body.revision)).toEqual([3]);

    // Already accepted: the same revision is not sent again.
    sync.push({ emails: ["ada@example.com"], revision: 3 });
    await settle(sync);
    expect(cloud.sent).toHaveLength(1);
  });

  it("sends only the newest list and never an older one after it", async () => {
    const cloud = fakeCloud();
    const sync = new VisitorAllowListSync({
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

  it("retries an unreachable or failing Rome Cloud in the background", async () => {
    const cloud = fakeCloud(["throw", 503]);
    const sync = new VisitorAllowListSync({
      getToken: () => "inst-token",
      getOrigin: () => ORIGIN,
      fetchImpl: cloud.fetchImpl,
      retryDelaysMs: [0],
    });

    sync.push({ emails: ["ada@example.com"], revision: 4 });
    await settle(sync);

    expect(cloud.sent.map((s) => s.body.revision)).toEqual([4, 4, 4]);
  });

  it("does not retry a list Rome Cloud refuses", async () => {
    const cloud = fakeCloud([400]);
    const sync = new VisitorAllowListSync({
      getToken: () => "inst-token",
      getOrigin: () => ORIGIN,
      fetchImpl: cloud.fetchImpl,
      retryDelaysMs: [0],
    });

    sync.push({ emails: ["ada@example.com"], revision: 5 });
    await settle(sync);

    expect(cloud.sent).toHaveLength(1);
  });

  it("logs counts, revisions and outcomes, never an email", async () => {
    const { lines, logger } = recordingLogger();
    const cloud = fakeCloud([503, 200, 400]);
    const sync = new VisitorAllowListSync({
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
