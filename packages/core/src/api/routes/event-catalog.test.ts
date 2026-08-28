import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import { Hono } from "hono";
import { eventCatalogRoutes } from "./event-catalog.js";
import { createTestDb, buildTestDeps, type TestDb } from "../../test/helpers.js";
import { EventCatalog } from "../../event-catalog.js";

// GET /event-catalog reflects the live state a producer app maintains via the
// EventCatalog. Drives the endpoint over HTTP and asserts on what a
// routine-creation client would observe.

describe("Event catalog discovery", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  it("returns an empty list when no producer has registered an event type", async () => {
    const deps = await buildTestDeps(testDb.db);
    const app = new Hono().route(
      "/",
      eventCatalogRoutes({ ...deps, eventCatalog: new EventCatalog() }),
    );

    const res = await app.request("/event-catalog");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns an empty list when no catalog is wired into the server", async () => {
    const deps = await buildTestDeps(testDb.db);
    const app = new Hono().route("/", eventCatalogRoutes(deps));

    const res = await app.request("/event-catalog");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("surfaces every event type producers have registered", async () => {
    const deps = await buildTestDeps(testDb.db);
    const eventCatalog = new EventCatalog();
    eventCatalog.register({
      eventType: "connector:GMAIL_NEW_MESSAGE",
      appId: "connector",
    });
    eventCatalog.register({ eventType: "github:PR_OPENED", appId: "github" });
    const app = new Hono().route("/", eventCatalogRoutes({ ...deps, eventCatalog }));

    const res = await app.request("/event-catalog");
    expect(res.status).toBe(200);
    const types = ((await res.json()) as { eventType: string }[]).map((e) => e.eventType);
    expect(types.sort()).toEqual(["connector:GMAIL_NEW_MESSAGE", "github:PR_OPENED"]);
  });

  it("stops surfacing an event type after its producer withdraws it", async () => {
    const deps = await buildTestDeps(testDb.db);
    const eventCatalog = new EventCatalog();
    eventCatalog.register({
      eventType: "connector:GMAIL_NEW_MESSAGE",
      appId: "connector",
    });
    const app = new Hono().route("/", eventCatalogRoutes({ ...deps, eventCatalog }));

    eventCatalog.unregister("connector", "connector:GMAIL_NEW_MESSAGE");

    const res = await app.request("/event-catalog");
    expect(await res.json()).toEqual([]);
  });
});
