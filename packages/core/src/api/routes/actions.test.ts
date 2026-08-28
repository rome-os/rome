import { describe, it, expect, rs } from "@rstest/core";
import { Hono } from "hono";
import { actionsRoutes } from "./actions.js";
import { createTestDb, buildTestDeps } from "../../test/helpers.js";
import type { ApiDeps } from "../deps.js";

describe("Actions API", () => {
  it("lists registered actions with their input schema, sorted by name", async () => {
    const testDb = createTestDb();
    try {
      const deps = await buildTestDeps(testDb.db);
      deps.actionRegistry.register({
        config: {
          name: "zeta_action",
          type: "custom",
          description: "Sends a thing",
          complexity: "simple",
          speed: "fast",
          reliability: "high",
          sideEffects: "write",
          requiresApproval: true,
        },
        inputSchema: {
          type: "object",
          properties: { message: { type: "string", description: "What to send" } },
          required: ["message"],
        },
        execute: async () => ({ status: "ok" as const }),
      });
      // Event-only action (workflow): no inputSchema, still listed with null.
      deps.actionRegistry.register({
        config: {
          name: "alpha_workflow",
          type: "system",
          description: "Runs a pipeline",
          complexity: "complex",
          speed: "slow",
          reliability: "medium",
          sideEffects: "write",
        },
        execute: async () => ({ status: "ok" as const }),
      });
      const app = new Hono().route("/", actionsRoutes(deps));

      const res = await app.request("/actions");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        actions: Array<{ name: string; inputSchema: unknown; requiresApproval: boolean }>;
      };
      const names = body.actions.map((a) => a.name);
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));

      const zeta = body.actions.find((a) => a.name === "zeta_action");
      expect(zeta).toMatchObject({
        description: "Sends a thing",
        type: "custom",
        sideEffects: "write",
        requiresApproval: true,
        inputSchema: {
          type: "object",
          properties: { message: { type: "string", description: "What to send" } },
          required: ["message"],
        },
      });

      const alpha = body.actions.find((a) => a.name === "alpha_workflow");
      expect(alpha).toMatchObject({ requiresApproval: false, inputSchema: null });
    } finally {
      testDb.close();
    }
  });

  it("returns 404 when the engine has no matching execution", async () => {
    const testDb = createTestDb();
    try {
      const deps = await buildTestDeps(testDb.db);
      const app = new Hono().route("/", actionsRoutes(deps));

      const res = await app.request("/actions/executions/nope/cancel", {
        method: "POST",
      });
      expect(res.status).toBe(404);
    } finally {
      testDb.close();
    }
  });

  it("returns 202 with the rootExecutionId when the cancel succeeds", async () => {
    const testDb = createTestDb();
    try {
      const deps = await buildTestDeps(testDb.db);
      const cancel = rs.fn(async () => true);
      const engine = { ...deps.actionEngine, cancel } as unknown as ApiDeps["actionEngine"];
      const app = new Hono().route("/", actionsRoutes({ ...deps, actionEngine: engine }));

      const res = await app.request("/actions/executions/root-1/cancel", {
        method: "POST",
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true, rootExecutionId: "root-1" });
      expect(cancel).toHaveBeenCalledWith("root-1");
    } finally {
      testDb.close();
    }
  });
});
