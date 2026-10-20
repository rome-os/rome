import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { WebhookInvocationsRepository } from "./webhook-invocations.js";

describe("WebhookInvocationsRepository", () => {
  let testDb: TestDb;
  let repo: WebhookInvocationsRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new WebhookInvocationsRepository(testDb.db);
  });

  afterEach(() => {
    testDb.close();
  });

  it("creates an accepted invocation and finds it", async () => {
    await repo.createAccepted({
      executionId: "exec-1",
      actionName: "send_message",
      args: { text: "hello" },
      callbackUrl: "https://example.com/callback",
      createdAt: new Date("2026-04-03T00:00:00Z"),
    });

    const record = await repo.findByExecutionId("exec-1");

    expect(record).toMatchObject({
      executionId: "exec-1",
      actionName: "send_message",
      args: { text: "hello" },
      callbackUrl: "https://example.com/callback",
      status: "accepted",
      callbackStatus: "pending",
    });
  });

  it("updates running, terminal, and callback-delivery fields", async () => {
    await repo.createAccepted({
      executionId: "exec-2",
      actionName: "send_message",
      args: { text: "hello" },
    });

    const finishedAt = new Date("2026-04-03T00:05:00Z");
    await repo.update("exec-2", {
      status: "running",
    });
    await repo.update("exec-2", {
      status: "success",
      result: { status: "ok", data: { ok: true } },
      finishedAt,
    });
    await repo.update("exec-2", {
      callbackStatus: "failed",
      callbackAttemptedAt: new Date("2026-04-03T00:05:30Z"),
      callbackError: "Callback failed with status 500",
      callbackResponseStatus: 500,
    });

    const record = await repo.findByExecutionId("exec-2");

    expect(record).toMatchObject({
      executionId: "exec-2",
      status: "success",
      result: { status: "ok", data: { ok: true } },
      callbackStatus: "failed",
      callbackError: "Callback failed with status 500",
      callbackResponseStatus: 500,
    });
    expect(record?.finishedAt).toEqual(finishedAt);
  });

  describe("settleInterrupted", () => {
    const boot = new Date("2026-04-04T00:00:00Z");

    it("settles accepted and running rows with the given outcome and keeps finished ones", async () => {
      await repo.createAccepted({ executionId: "accepted", actionName: "a", args: {} });
      await repo.createAccepted({ executionId: "running", actionName: "a", args: {} });
      await repo.update("running", { status: "running" });
      await repo.createAccepted({ executionId: "done", actionName: "a", args: {} });
      await repo.update("done", {
        status: "success",
        result: { status: "ok", data: { kept: true } },
        finishedAt: new Date("2026-04-03T00:05:00Z"),
      });
      const asked: string[] = [];

      const settled = await repo.settleInterrupted(boot, async (executionId) => {
        asked.push(executionId);
        return executionId === "running"
          ? { status: "cancelled", error: "stopped", finishedAt: new Date("2026-04-03T00:10:00Z") }
          : { status: "error", error: "never ran", finishedAt: boot };
      });

      expect(settled).toBe(2);
      expect(asked.sort()).toEqual(["accepted", "running"]);
      expect(await repo.findByExecutionId("accepted")).toMatchObject({
        status: "error",
        error: "never ran",
        result: null,
        finishedAt: boot,
        updatedAt: boot,
      });
      expect(await repo.findByExecutionId("running")).toMatchObject({
        status: "cancelled",
        error: "stopped",
        finishedAt: new Date("2026-04-03T00:10:00Z"),
      });
      expect(await repo.findByExecutionId("done")).toMatchObject({
        status: "success",
        result: { status: "ok", data: { kept: true } },
        finishedAt: new Date("2026-04-03T00:05:00Z"),
      });
    });
  });

  describe("listUndeliveredCallbacks", () => {
    it("lists settled rows whose callback is still pending, oldest first", async () => {
      const at = (minute: number) =>
        new Date(`2026-04-03T00:${String(minute).padStart(2, "0")}:00Z`);
      const callbackUrl = "https://hooks.example.test/callback";
      await repo.createAccepted({
        executionId: "later",
        actionName: "a",
        args: {},
        callbackUrl,
        createdAt: at(2),
      });
      await repo.createAccepted({
        executionId: "earlier",
        actionName: "a",
        args: {},
        callbackUrl,
        createdAt: at(1),
      });
      await repo.createAccepted({
        executionId: "still-running",
        actionName: "a",
        args: {},
        callbackUrl,
        createdAt: at(3),
      });
      await repo.createAccepted({
        executionId: "delivered",
        actionName: "a",
        args: {},
        callbackUrl,
        createdAt: at(4),
      });
      await repo.createAccepted({
        executionId: "no-callback",
        actionName: "a",
        args: {},
        createdAt: at(5),
      });
      await repo.update("later", { status: "error" });
      await repo.update("earlier", { status: "pending_approval" });
      await repo.update("still-running", { status: "running" });
      await repo.update("delivered", { status: "success", callbackStatus: "succeeded" });
      await repo.update("no-callback", { status: "success" });

      expect(await repo.listUndeliveredCallbacks()).toEqual(["earlier", "later"]);
    });
  });
});
