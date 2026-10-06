import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { ActionExecutionsRepository } from "../db/repositories/action-executions.js";
import { SettingsRepository } from "../db/repositories/settings.js";
import { UsageOutboxRepository } from "../db/repositories/usage-outbox.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import type { UsageAttributionResolver } from "./attribution.js";
import type { UsageEvent } from "./events.js";
import { ACTION_RUN_CURSOR_KEY, UsageReporter, type RomeCloudAccess } from "./reporter.js";

const ACCESS: RomeCloudAccess = { token: "romeinst_test", origin: "https://rome.example" };
const attribution: Pick<UsageAttributionResolver, "forActionRun"> = {
  forActionRun: (row) =>
    row.initiator?.startsWith("routine:")
      ? { kind: "routine", appId: null }
      : row.initiator?.startsWith("app:")
        ? { kind: "app", appId: "@rome/news" }
        : null,
};

function turn(eventId: string): UsageEvent {
  return {
    type: "turn",
    eventId,
    kind: "chat",
    appId: null,
    status: "completed",
    provider: "openai",
    model: "gpt-6-sol",
    funding: "byok",
    providerTurnId: null,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostMicros: null,
    durationMs: 1,
    occurredAt: "2026-10-06T12:00:00.000Z",
  };
}

describe("UsageReporter", () => {
  let testDb: TestDb;
  let outbox: UsageOutboxRepository;
  let executions: ActionExecutionsRepository;
  let settings: SettingsRepository;
  let now: Date;
  let access: RomeCloudAccess | null;
  let requests: Array<{ url: string; authorization: string | null; events: UsageEvent[] }>;
  let respond: () => Response;

  function reporter() {
    return new UsageReporter({
      outbox,
      executions,
      settings,
      attribution,
      access: () => access,
      now: () => now,
      fetch: (async (url: URL, init: RequestInit) => {
        const headers = new Headers(init.headers);
        requests.push({
          url: String(url),
          authorization: headers.get("authorization"),
          events: (JSON.parse(String(init.body)) as { events: UsageEvent[] }).events,
        });
        return respond();
      }) as typeof fetch,
    });
  }

  async function finishedRoot(
    id: string,
    actionName: string,
    initiator: string,
    at: Date,
    rootExecutionId = id,
  ) {
    await executions.create({
      id,
      rootExecutionId,
      actionName,
      status: "success",
      initiator,
      durationMs: 25,
      startedAt: new Date(at.getTime() - 1000),
      finishedAt: at,
    });
  }

  beforeEach(() => {
    testDb = createTestDb();
    outbox = new UsageOutboxRepository(testDb.db);
    executions = new ActionExecutionsRepository(testDb.db);
    settings = new SettingsRepository(testDb.db);
    now = new Date("2026-10-06T12:00:00.000Z");
    access = ACCESS;
    requests = [];
    respond = () => Response.json({ accepted: 1, duplicates: 0, rejected: [] });
  });

  afterEach(() => {
    testDb.close();
  });

  it("starts the action-run cursor at the first pass without reporting history", async () => {
    await finishedRoot(
      "old-run",
      "news.digest",
      "routine:Digest",
      new Date("2026-10-01T00:00:00Z"),
    );
    await reporter().tick();
    expect(requests).toEqual([]);
    expect(await settings.get(ACTION_RUN_CURSOR_KEY)).toEqual({
      finishedAt: "2026-10-06T12:00:00.000Z",
      id: "",
      reporting: true,
    });
  });

  it("queues and ships finished routine and app runs, skipping core work and recent rows", async () => {
    const r = reporter();
    await r.tick();
    // The routine engine roots its chain at the routine run, not the execution.
    await finishedRoot(
      "routine-run",
      "core.memory",
      "routine:Digest",
      new Date("2026-10-06T12:00:30Z"),
      "routine-run-root",
    );
    await finishedRoot("app-run", "news.digest", "app:news", new Date("2026-10-06T12:00:40Z"));
    await finishedRoot("core-run", "core.memory", "agent:main", new Date("2026-10-06T12:00:45Z"));
    await finishedRoot("too-recent", "news.digest", "app:news", new Date("2026-10-06T12:00:55Z"));
    await executions.create({
      id: "nested",
      rootExecutionId: "app-run",
      parentId: "app-run",
      actionName: "news.fetch",
      status: "success",
      initiator: "app:news",
      finishedAt: new Date("2026-10-06T12:00:41Z"),
    });
    now = new Date("2026-10-06T12:01:00.000Z");
    await r.tick();

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://rome.example/v1/usage/events");
    expect(requests[0].authorization).toBe("Bearer romeinst_test");
    expect(requests[0].events).toEqual([
      {
        type: "action_run",
        eventId: "routine-run",
        kind: "routine",
        appId: null,
        status: "success",
        durationMs: 25,
        occurredAt: "2026-10-06T12:00:30.000Z",
      },
      {
        type: "action_run",
        eventId: "app-run",
        kind: "app",
        appId: "@rome/news",
        status: "success",
        durationMs: 25,
        occurredAt: "2026-10-06T12:00:40.000Z",
      },
    ]);
    expect(await outbox.peek(10)).toEqual([]);

    now = new Date("2026-10-06T12:02:00.000Z");
    await r.tick();
    expect(requests[1].events.map((event) => event.eventId)).toEqual(["too-recent"]);
  });

  it("keeps events queued while signed out, and does not report runs from that period later", async () => {
    const r = reporter();
    await r.tick();
    access = null;
    await outbox.enqueue(turn("turn-1"));
    await finishedRoot(
      "signed-out-run",
      "news.digest",
      "app:news",
      new Date("2026-10-06T12:00:30Z"),
    );
    now = new Date("2026-10-06T12:01:00.000Z");
    await r.tick();
    expect(requests).toEqual([]);
    expect(await outbox.peek(10)).toHaveLength(1);

    access = ACCESS;
    await r.tick();
    expect(requests.map((request) => request.events.map((event) => event.eventId))).toEqual([
      ["turn-1"],
    ]);
  });

  it("does not report a run that finished signed out inside the sweep lag once the instance signs in", async () => {
    const r = reporter();
    await r.tick();
    access = null;
    await finishedRoot("lagged-run", "news.digest", "app:news", new Date("2026-10-06T12:00:55Z"));
    now = new Date("2026-10-06T12:01:00.000Z");
    await r.tick();

    access = ACCESS;
    now = new Date("2026-10-06T12:02:00.000Z");
    await r.tick();
    await finishedRoot(
      "signed-in-run",
      "news.digest",
      "app:news",
      new Date("2026-10-06T12:02:30Z"),
    );
    now = new Date("2026-10-06T12:03:00.000Z");
    await r.tick();

    expect(requests.map((request) => request.events.map((event) => event.eventId))).toEqual([
      ["signed-in-run"],
    ]);
  });

  it("starts the cursor when the reporter starts, not at the first interval", async () => {
    const r = reporter();
    r.start();
    await r.stop();
    await finishedRoot("early-run", "news.digest", "app:news", new Date("2026-10-06T12:00:20Z"));
    now = new Date("2026-10-06T12:01:00.000Z");
    await r.tick();

    expect(requests.map((request) => request.events.map((event) => event.eventId))).toEqual([
      ["early-run"],
    ]);
  });

  it("retries after an outage, a rate limit, or a missing route, and drops a refused batch", async () => {
    const r = reporter();
    await outbox.enqueue(turn("turn-1"));
    for (const status of [503, 429, 404, 401]) {
      respond = () => new Response("", { status });
      await r.tick();
      expect(await outbox.peek(10)).toHaveLength(1);
    }
    respond = () => Response.json({ error: "invalid_request" }, { status: 400 });
    await r.tick();
    expect(await outbox.peek(10)).toEqual([]);
  });

  it("treats every event in a 200 response as delivered, rejected ones included", async () => {
    const r = reporter();
    await outbox.enqueue(turn("turn-1"));
    await outbox.enqueue(turn("turn-2"));
    respond = () =>
      Response.json({
        accepted: 1,
        duplicates: 0,
        rejected: [{ index: 1, eventId: "turn-2", error: "kind: invalid" }],
      });
    await r.tick();
    expect(await outbox.peek(10)).toEqual([]);
  });

  it("drops queued events past retention", async () => {
    await outbox.enqueue(turn("stale"), new Date("2026-08-01T00:00:00Z"));
    access = null;
    await reporter().tick();
    expect(await outbox.peek(10)).toEqual([]);
  });
});
