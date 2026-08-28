import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import { Hono } from "hono";
import { actionExecutionsRoutes } from "./action-executions.js";
import { createTestDb, buildTestDeps, type TestDb } from "../../test/helpers.js";
import { seedBaseline, type BaselineIds } from "../../test/seeds.js";
import type { ApiDeps } from "../deps.js";

describe("Action-executions API", () => {
  let testDb: TestDb;
  let baseline: BaselineIds;

  beforeEach(async () => {
    testDb = createTestDb();
    baseline = await seedBaseline(testDb.db);
  });

  afterEach(() => {
    testDb.close();
    rs.restoreAllMocks();
  });

  describe("GET /action-executions", () => {
    it("groups roots with their children and orders roots desc", async () => {
      const deps = await buildTestDeps(testDb.db);
      const app = new Hono().route("/", actionExecutionsRoutes(deps));

      const res = await app.request("/action-executions");
      expect(res.status).toBe(200);
      const groups = (await res.json()) as {
        rootExecution: { id: string };
        children: { id: string }[];
      }[];

      const rootIds = groups.map((g) => g.rootExecution.id);
      // Both roots present, error root has the later createdAt.
      expect(rootIds).toEqual(
        expect.arrayContaining([
          baseline.actionExecutions.rootSuccessId,
          baseline.actionExecutions.rootErrorId,
        ]),
      );
      expect(rootIds.indexOf(baseline.actionExecutions.rootErrorId)).toBeLessThan(
        rootIds.indexOf(baseline.actionExecutions.rootSuccessId),
      );

      const successGroup = groups.find(
        (g) => g.rootExecution.id === baseline.actionExecutions.rootSuccessId,
      )!;
      expect(successGroup.children.map((c) => c.id)).toEqual([
        baseline.actionExecutions.childSuccessId,
      ]);
    });

    it("filters root executions by actionName", async () => {
      const deps = await buildTestDeps(testDb.db);
      const app = new Hono().route("/", actionExecutionsRoutes(deps));

      const res = await app.request("/action-executions?actionName=send_message");
      const groups = (await res.json()) as { rootExecution: { id: string } }[];
      const ids = groups.map((g) => g.rootExecution.id);
      expect(ids).toContain(baseline.actionExecutions.rootSuccessId);
      expect(ids).not.toContain(baseline.actionExecutions.rootErrorId);
    });
  });

  describe("POST /action-executions/:id/cancel", () => {
    it("returns 404 when the engine has no matching in-flight execution", async () => {
      const deps = await buildTestDeps(testDb.db);
      const app = new Hono().route("/", actionExecutionsRoutes(deps));

      const res = await app.request("/action-executions/not-running/cancel", {
        method: "POST",
      });
      expect(res.status).toBe(404);
    });

    it("returns 202 when the engine reports the cancel succeeded", async () => {
      const deps = await buildTestDeps(testDb.db);
      const engine = { ...deps.actionEngine, cancel: rs.fn(async () => true) };
      const app = new Hono().route(
        "/",
        actionExecutionsRoutes({
          ...deps,
          actionEngine: engine as unknown as ApiDeps["actionEngine"],
        }),
      );

      const id = baseline.actionExecutions.rootSuccessId;
      const res = await app.request(`/action-executions/${id}/cancel`, {
        method: "POST",
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true, rootExecutionId: id });
      expect(engine.cancel).toHaveBeenCalledWith(id);
    });
  });
});
