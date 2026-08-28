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
});
