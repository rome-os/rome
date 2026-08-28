import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import { Hono } from "hono";
import { webhookInvocationsRoutes } from "./webhook-invocations.js";
import { createTestDb, buildTestDeps, type TestDb } from "../../test/helpers.js";
import { seedBaseline, seedFailedCallbackWebhook, type BaselineIds } from "../../test/seeds.js";
import { WebhookInvocationsRepository } from "../../db/repositories/webhook-invocations.js";

describe("Webhook-invocations API", () => {
  let testDb: TestDb;
  let app: Hono;
  let baseline: BaselineIds;

  beforeEach(async () => {
    testDb = createTestDb();
    baseline = await seedBaseline(testDb.db);
    const deps = await buildTestDeps(testDb.db);
    app = new Hono().route("/", webhookInvocationsRoutes(deps));
  });

  afterEach(() => testDb.close());

  it("orders invocations by created_at desc (newest first)", async () => {
    const res = await app.request("/webhook-invocations");
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { executionId: string; createdAt: string | number }[];

    const acceptedIdx = rows.findIndex(
      (r) => r.executionId === baseline.webhookInvocations.acceptedId,
    );
    const succeededIdx = rows.findIndex(
      (r) => r.executionId === baseline.webhookInvocations.succeededWithCallbackId,
    );
    // succeededWithCallback has a later createdAt than accepted → appears earlier.
    expect(succeededIdx).toBeLessThan(acceptedIdx);
  });

  it("filters by actionName", async () => {
    const repo = new WebhookInvocationsRepository(testDb.db);
    await repo.createAccepted({
      executionId: "other-1",
      actionName: "other_action",
      args: {},
    });

    const res = await app.request("/webhook-invocations?actionName=other_action");
    const rows = (await res.json()) as { executionId: string; actionName: string }[];
    expect(rows.every((r) => r.actionName === "other_action")).toBe(true);
    expect(rows.map((r) => r.executionId)).toContain("other-1");
    expect(rows.map((r) => r.executionId)).not.toContain(baseline.webhookInvocations.acceptedId);
  });

  it("surfaces callback state for failed deliveries (patched row)", async () => {
    const failedId = await seedFailedCallbackWebhook(testDb.db);

    const res = await app.request("/webhook-invocations");
    const rows = (await res.json()) as {
      executionId: string;
      callbackStatus: string;
      callbackError: string | null;
    }[];

    const failed = rows.find((r) => r.executionId === failedId);
    expect(failed).toBeDefined();
    expect(failed!.callbackStatus).toBe("failed");
    expect(failed!.callbackError).toBe("HTTP 502");
  });

  it("honors limit + offset for pagination", async () => {
    const limited = await app.request("/webhook-invocations?limit=1");
    expect(((await limited.json()) as unknown[]).length).toBe(1);

    const page2 = await app.request("/webhook-invocations?limit=1&offset=1");
    expect(((await page2.json()) as unknown[]).length).toBe(1);
  });
});
