import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import { Hono } from "hono";
import { webhookRoutes } from "./webhooks.js";
import { createTestDb, buildTestDeps, type TestDb } from "../../test/helpers.js";
import { seedBaseline, type BaselineIds } from "../../test/seeds.js";
import {
  currentSessionActor,
  runWithSessionActor,
  type SessionActor,
} from "../../lib/session-actor.js";
import type { ActionResult } from "../../actions/types.js";
import type { ApiDeps } from "../deps.js";
import { errorHandler } from "../middleware/error-handler.js";

const API_KEY = "test-secret-key";

interface FakeActionConfig {
  webhook?: boolean;
  requiresApproval?: boolean;
}

function buildActionLoader(actions: Record<string, FakeActionConfig>) {
  return {
    get: (name: string) => {
      if (!(name in actions)) return undefined;
      return { name, ...actions[name] };
    },
  } as unknown as NonNullable<ApiDeps["actionLoader"]>;
}

function buildApp(
  deps: ApiDeps,
  runImpl: (name: string, args: Record<string, unknown>) => Promise<ActionResult>,
  options: { apiKey?: string | undefined; useDefault?: boolean } = { useDefault: true },
) {
  const apiKey = options.useDefault ? API_KEY : options.apiKey;
  const actionEngine = {
    ...deps.actionEngine,
    run: rs.fn(async (name: string, args: Record<string, unknown>) => runImpl(name, args)),
  } as unknown as ApiDeps["actionEngine"];

  const app = new Hono();
  app.onError(errorHandler);
  app.route("/", webhookRoutes({ ...deps, actionEngine }, apiKey));
  return app;
}

describe("Webhooks API", () => {
  let testDb: TestDb;
  let baseDeps: ApiDeps;
  let baseline: BaselineIds;

  beforeEach(async () => {
    testDb = createTestDb();
    baseline = await seedBaseline(testDb.db);
    baseDeps = {
      ...(await buildTestDeps(testDb.db)),
      actionLoader: buildActionLoader({
        send_message: { webhook: true },
        internal_only: { webhook: false },
        approval_gated: { webhook: true, requiresApproval: true },
      }),
    };
  });

  afterEach(() => {
    testDb.close();
    rs.restoreAllMocks();
  });

  describe("auth", () => {
    it("rejects without x-api-key (401)", async () => {
      const app = buildApp(baseDeps, async () => ({ status: "ok" }));
      const res = await app.request("/webhooks/send_message", { method: "POST" });
      expect(res.status).toBe(401);
    });

    it("returns 503 when no api key is configured", async () => {
      const app = buildApp(baseDeps, async () => ({ status: "ok" }), {
        useDefault: false,
        apiKey: undefined,
      });
      const res = await app.request("/webhooks/send_message", {
        method: "POST",
        headers: { "x-api-key": "anything" },
      });
      expect(res.status).toBe(503);
    });
  });

  describe("POST /webhooks/:actionName", () => {
    it("returns 404 for unknown actions", async () => {
      const app = buildApp(baseDeps, async () => ({ status: "ok" }));
      const res = await app.request("/webhooks/does_not_exist", {
        method: "POST",
        headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ args: {} }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 403 for non-webhook-enabled actions", async () => {
      const app = buildApp(baseDeps, async () => ({ status: "ok" }));
      const res = await app.request("/webhooks/internal_only", {
        method: "POST",
        headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ args: {} }),
      });
      expect(res.status).toBe(403);
    });

    it("returns 409 for approval-gated actions", async () => {
      const app = buildApp(baseDeps, async () => ({ status: "ok" }));
      const res = await app.request("/webhooks/approval_gated", {
        method: "POST",
        headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ args: {} }),
      });
      expect(res.status).toBe(409);
    });

    it("returns 400 for invalid JSON body", async () => {
      const app = buildApp(baseDeps, async () => ({ status: "ok" }));
      const res = await app.request("/webhooks/send_message", {
        method: "POST",
        headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when args is missing", async () => {
      const app = buildApp(baseDeps, async () => ({ status: "ok" }));
      const res = await app.request("/webhooks/send_message", {
        method: "POST",
        headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("accepts a valid invocation, persists it, and runs the action", async () => {
      const runImpl = rs.fn(async () => ({ status: "ok", data: { echo: "ok" } }) as ActionResult);
      const app = buildApp(baseDeps, runImpl);

      const res = await app.request("/webhooks/send_message", {
        method: "POST",
        headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ args: { text: "hi" } }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as {
        executionId: string;
        status: string;
        pollUrl: string;
      };
      expect(body.status).toBe("accepted");
      expect(body.pollUrl).toBe(`/webhooks/executions/${body.executionId}`);

      const repo = baseDeps.webhookInvocationsRepo!;
      for (let i = 0; i < 50; i++) {
        const row = await repo.findByExecutionId(body.executionId);
        if (row && row.status !== "accepted" && row.status !== "running") break;
        await new Promise((r) => setTimeout(r, 10));
      }

      const final = await repo.findByExecutionId(body.executionId);
      expect(final?.status).toBe("success");
      expect(final?.result).toEqual({ status: "ok", data: { echo: "ok" } });
      expect(runImpl).toHaveBeenCalledWith("send_message", { text: "hi" });
    });

    it("runs the action with no session actor even inside an ambient scope", async () => {
      // Webhooks are a machine-credential surface: executions record no actor
      // (NULL) by contract. The router enforces this with withoutSessionActor,
      // so it must hold even if ambient capture is ever mounted above it —
      // simulated here by driving the request inside a session-actor scope.
      const ambient: SessionActor = { kind: "guardian", userId: "seat-1", via: "cookie" };
      const capturedInRun: Promise<SessionActor | undefined>[] = [];
      const runImpl = rs.fn(async () => {
        capturedInRun.push(currentSessionActor());
        return { status: "ok" } as ActionResult;
      });
      const app = buildApp(baseDeps, runImpl);

      const res = await runWithSessionActor(ambient, () =>
        app.request("/webhooks/send_message", {
          method: "POST",
          headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ args: { text: "hi" } }),
        }),
      );
      expect(res.status).toBe(202);

      const { executionId } = (await res.json()) as { executionId: string };
      const repo = baseDeps.webhookInvocationsRepo!;
      for (let i = 0; i < 50; i++) {
        const row = await repo.findByExecutionId(executionId);
        if (row && row.status !== "accepted" && row.status !== "running") break;
        await new Promise((r) => setTimeout(r, 10));
      }

      expect(capturedInRun).toHaveLength(1);
      expect(await capturedInRun[0]).toBeUndefined();
    });
  });

  describe("GET /webhooks/executions/:id", () => {
    it("returns 404 for unknown execution ids", async () => {
      const app = buildApp(baseDeps, async () => ({ status: "ok" }));
      const res = await app.request("/webhooks/executions/does-not-exist", {
        headers: { "x-api-key": API_KEY },
      });
      expect(res.status).toBe(404);
    });

    it("returns the invocation response shape for a baseline success", async () => {
      const app = buildApp(baseDeps, async () => ({ status: "ok" }));
      const id = baseline.webhookInvocations.succeededWithCallbackId;

      const res = await app.request(`/webhooks/executions/${id}`, {
        headers: { "x-api-key": API_KEY },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        executionId: string;
        status: string;
        callback: { status: string; requested: boolean };
      };
      expect(body.executionId).toBe(id);
      expect(body.status).toBe("success");
      expect(body.callback.requested).toBe(true);
      expect(body.callback.status).toBe("succeeded");
    });

    it("returns 400 for invalid path segments", async () => {
      const app = buildApp(baseDeps, async () => ({ status: "ok" }));
      const res = await app.request("/webhooks/executions/%ZZ", {
        headers: { "x-api-key": API_KEY },
      });
      expect(res.status).toBe(400);
    });
  });
});
