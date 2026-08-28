import { describe, it, expect, rs } from "@rstest/core";
import { Hono } from "hono";
import { checkHealthReadiness, healthRoutes, type HealthDeps } from "./health.js";
import { createTestDb } from "../../test/helpers.js";

describe("GET /health", () => {
  it("returns 200 with status ok when the DB and required schema are ready", async () => {
    const testDb = createTestDb();
    const app = new Hono().route("/", healthRoutes({ db: testDb.db }));

    try {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });
    } finally {
      testDb.close();
    }
  });

  it("returns 503 when the database liveness probe fails", async () => {
    const app = new Hono().route(
      "/",
      healthRoutes({
        db: {
          all: rs.fn(() => {
            throw new Error("database is closed");
          }),
        } as unknown as HealthDeps["db"],
      }),
    );

    const res = await app.request("/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: "degraded",
      failedCheck: "database",
    });
  });

  it("returns 503 when a required schema probe fails", async () => {
    let calls = 0;
    const readiness = await checkHealthReadiness({
      db: {
        all: rs.fn(() => {
          const callIndex = calls++;
          if (callIndex === 5) {
            throw new Error("no such table: rome_sessions");
          }
          return [];
        }),
      } as unknown as HealthDeps["db"],
    });

    expect(readiness).toEqual({
      ok: false,
      failedCheck: "schema:rome_sessions",
      error: "no such table: rome_sessions",
    });
  });

  it("returns 503 when the schema is absent", async () => {
    const app = new Hono().route(
      "/",
      healthRoutes({
        db: {
          all: rs
            .fn()
            .mockReturnValueOnce([])
            .mockImplementationOnce(() => {
              throw new Error("no such table: __drizzle_migrations_system");
            }),
        } as unknown as HealthDeps["db"],
      }),
    );

    const res = await app.request("/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: "degraded",
      failedCheck: "schema:system_migrations",
    });
  });
});
