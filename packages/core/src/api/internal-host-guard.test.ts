// Drives the production `buildApp` so the Host guard is checked where it is
// registered, ahead of every route, rather than in isolation.
import { afterAll, beforeAll, describe, expect, it } from "@rstest/core";
import type { Hono } from "hono";
import { buildApp } from "./index.js";
import type { ApiConfig } from "./deps.js";
import { buildTestDeps, createTestDb } from "../test/helpers.js";

const testDb = createTestDb();
afterAll(() => testDb.close());

const TEST_CONFIG: ApiConfig = { port: 0, host: "127.0.0.1" };

let app: Hono;
beforeAll(async () => {
  app = buildApp(await buildTestDeps(testDb.db), TEST_CONFIG).app;
});

describe("internal listener Host guard", () => {
  it("serves a request addressed to the loopback listener", async () => {
    const res = await app.request("/api/chat/sessions", {
      headers: { host: "127.0.0.1:4141" },
    });
    expect(res.status).toBe(200);
  });

  it("refuses a request addressed to a DNS-rebound name", async () => {
    const res = await app.request("/api/chat/sessions", {
      headers: { host: "rebind.example:4141" },
    });
    expect(res.status).toBe(421);
  });

  it("does not let forwarding headers vouch for a rebound name", async () => {
    // A rebound page can set X-Forwarded-* on its own same-origin fetch, so
    // neither header may stand in for a loopback Host.
    const res = await app.request("/api/chat/sessions", {
      headers: {
        host: "rebind.example:4141",
        "x-forwarded-for": "203.0.113.9",
        "x-forwarded-host": "127.0.0.1:4141",
      },
    });
    expect(res.status).toBe(421);
  });

  it("guards routes outside /api too", async () => {
    const res = await app.request("/webhooks/anything", {
      headers: { host: "rebind.example:4141" },
    });
    expect(res.status).toBe(421);
  });

  it("serves the shape Caddy forwards: loopback Host, public X-Forwarded-Host", async () => {
    const res = await app.request("/api/chat/sessions", {
      headers: {
        host: "127.0.0.1:4141",
        "x-forwarded-for": "203.0.113.9",
        "x-forwarded-host": "rome.example",
        "x-forwarded-proto": "https",
      },
    });
    expect(res.status).toBe(200);
  });
});
