import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { COOKIE_NAME, createSession } from "../access/auth.js";
import { createTestDb, type TestDb } from "../test/db.js";
import { MAX_ITEMS_PER_BATCH } from "./domain/ingest.js";
import { PersonalDataRepository } from "./repository.js";
import { personalDataRoutes } from "./routes.js";
import { PERSONAL_DATA_SOURCES } from "./sources/index.js";
import { batch, NOV_10, ORIGIN, stepHour } from "./__fixtures__/apple-health.js";

const GUARDIAN_COOKIE = `${COOKIE_NAME}=${createSession("guardian-seat")}`;

describe("/personal-data routes", () => {
  let testDb: TestDb;
  let app: ReturnType<typeof personalDataRoutes>;

  beforeEach(() => {
    testDb = createTestDb();
    app = personalDataRoutes({
      db: testDb.db,
      personalData: new PersonalDataRepository(testDb.db, PERSONAL_DATA_SOURCES),
      now: () => NOV_10 + 86_400_000,
    });
  });
  afterEach(() => testDb.close());

  const send = (path: string, init: RequestInit = {}, cookie: string | null = GUARDIAN_COOKIE) =>
    app.request(path, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  const ingest = (body: unknown, cookie?: string | null) =>
    send("/personal-data/ingest", { method: "POST", body: JSON.stringify(body) }, cookie);

  it("refuses a caller without the guardian's session, a loopback agent included", async () => {
    expect((await ingest(batch("b-1"), null)).status).toBe(403);
    expect((await send("/personal-data/sources", {}, null)).status).toBe(403);
    expect((await send("/personal-data/sources", {}, `${COOKIE_NAME}=forged`)).status).toBe(403);
  });

  it("refuses the guardian's loopback session, which an agent's shell has", async () => {
    const loopback = personalDataRoutes({
      db: testDb.db,
      personalData: new PersonalDataRepository(testDb.db, PERSONAL_DATA_SOURCES),
      guardianSession: async () => ({ userId: "guardian-seat", via: "loopback" }),
    });
    expect((await loopback.request("/personal-data/sources")).status).toBe(403);
    const cookie = personalDataRoutes({
      db: testDb.db,
      personalData: new PersonalDataRepository(testDb.db, PERSONAL_DATA_SOURCES),
      guardianSession: async () => ({ userId: "guardian-seat", via: "cookie" }),
    });
    expect((await cookie.request("/personal-data/sources")).status).toBe(200);
  });

  it("refuses a chunked body over 1 MB that names no length", async () => {
    const chunk = new TextEncoder().encode(" ".repeat(64 * 1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 20) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const response = await app.request("/personal-data/ingest", {
      method: "POST",
      body,
      headers: { cookie: GUARDIAN_COOKIE, "content-type": "application/json" },
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(413);
  });

  it("ingests a batch and answers its counts, then lists the source", async () => {
    const response = await ingest(batch("b-1", { upserts: [stepHour(NOV_10, 812)] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ batchId: "b-1", status: "ok", inserted: 1 });
    const sources = await (await send("/personal-data/sources")).json();
    expect(sources.sources[0]).toMatchObject({ source: "apple_health", origin: { id: ORIGIN } });
  });

  it("refuses a body that is not sent as JSON", async () => {
    const response = await send("/personal-data/ingest", {
      method: "POST",
      body: JSON.stringify(batch("b-1")),
      headers: { "content-type": "text/plain" },
    });
    expect(response.status).toBe(415);
  });

  it("refuses a bad envelope whole", async () => {
    expect((await ingest({ ...batch("b-1"), version: 2 })).status).toBe(400);
    expect((await ingest({ ...batch("b-1"), source: "fitbit" })).status).toBe(400);
    const { origin: _origin, ...withoutOrigin } = batch("b-1");
    expect((await ingest(withoutOrigin)).status).toBe(400);
  });

  it("refuses a batch over the item or size cap with 413", async () => {
    const many = Array.from({ length: MAX_ITEMS_PER_BATCH + 1 }, () => ({ key: "k" }));
    expect((await ingest(batch("b-1", { deletes: many }))).status).toBe(413);
    const big = batch("b-2", { deletes: [{ key: "x".repeat(1024 * 1024) }] });
    expect((await ingest(big)).status).toBe(413);
  });

  it("limits each origin to 60 ingests a minute", async () => {
    for (let i = 0; i < 60; i += 1) {
      expect((await ingest(batch(`b-${i}`))).status).toBe(200);
    }
    const limited = await ingest(batch("b-60"));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("sets an origin's state, deletes its data and lists the log", async () => {
    await ingest(batch("b-1", { upserts: [stepHour(NOV_10, 812)] }));
    const base = `/personal-data/sources/apple_health/origins/${ORIGIN}`;
    const paused = await send(`${base}/state`, {
      method: "PUT",
      body: JSON.stringify({ state: "paused" }),
    });
    expect(await paused.json()).toEqual({ state: "paused" });
    expect(
      (await send(`${base}/state`, { method: "PUT", body: JSON.stringify({ state: "gone" }) }))
        .status,
    ).toBe(400);
    expect(
      (
        await send("/personal-data/sources/apple_health/origins/other/state", {
          method: "PUT",
          body: JSON.stringify({ state: "paused" }),
        })
      ).status,
    ).toBe(404);
    expect(await (await send(base, { method: "DELETE" })).json()).toEqual({ deletedPoints: 1 });
    const log = await (await send("/personal-data/sources/apple_health/ingests?limit=5")).json();
    expect(log.ingests.map((entry: { status: string }) => entry.status)).toEqual(["deleted", "ok"]);
  });
});
