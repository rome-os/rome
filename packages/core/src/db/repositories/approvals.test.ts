import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { ApprovalsRepository } from "./approvals.js";
import { approvals } from "../schema.js";

describe("ApprovalsRepository", () => {
  let testDb: TestDb;
  let repo: ApprovalsRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new ApprovalsRepository(testDb.db);
  });

  afterEach(() => {
    testDb.close();
  });

  it("create() inserts approval with pending status", async () => {
    const id = await repo.create({
      type: "person_mapping",
      requestedBy: "sentinel",
      description: "Add new person: Alice",
      payload: { personId: "p-1", displayName: "Alice" },
    });

    expect(id).toBeDefined();
    const approval = await repo.findById(id);
    expect(approval).not.toBeNull();
    expect(approval!.status).toBe("pending");
    expect(approval!.type).toBe("person_mapping");
    expect(approval!.requestedBy).toBe("sentinel");
  });

  // An app compiled against an older SDK reaches create() with an unchecked
  // string, so the type union alone does not close this.
  it("create() rejects a lifecycle no resolver recognises", async () => {
    await expect(
      repo.create({
        type: "sensitive_message" as never,
        requestedBy: "some-app",
        description: "Send a message",
      }),
    ).rejects.toThrow(/Unknown approval type/);

    expect(await repo.findPending()).toHaveLength(0);
  });

  it("findPending() returns only pending approvals", async () => {
    const id1 = await repo.create({
      type: "person_mapping",
      requestedBy: "sentinel",
      description: "Add Alice",
    });
    await repo.create({
      type: "action_execution",
      requestedBy: "assistant",
      description: "Run command",
    });

    await repo.approve(id1);

    const pending = await repo.findPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].type).toBe("action_execution");
  });

  it("approve() sets status=approved and resolvedAt/resolvedBy", async () => {
    const id = await repo.create({
      type: "person_mapping",
      requestedBy: "sentinel",
      description: "Add Bob",
    });

    await repo.approve(id, "admin-user");

    const approval = await repo.findById(id);
    expect(approval!.status).toBe("approved");
    expect(approval!.resolvedBy).toBe("admin-user");
    expect(approval!.resolvedAt).toBeInstanceOf(Date);
  });

  it("reject() sets status=rejected and resolvedAt/resolvedBy", async () => {
    const id = await repo.create({
      type: "person_mapping",
      requestedBy: "sentinel",
      description: "Add Charlie",
    });

    await repo.reject(id, "admin-user");

    const approval = await repo.findById(id);
    expect(approval!.status).toBe("rejected");
    expect(approval!.resolvedBy).toBe("admin-user");
    expect(approval!.resolvedAt).toBeInstanceOf(Date);
  });

  it("findById() returns approval with full payload", async () => {
    const payload = {
      personId: "p-1",
      displayName: "Diana",
      channels: ["telegram", "slack"],
    };
    const id = await repo.create({
      type: "person_mapping",
      requestedBy: "sentinel",
      description: "Add Diana",
      payload,
    });

    const approval = await repo.findById(id);
    expect(approval).not.toBeNull();
    expect(approval!.payload).toEqual(payload);
  });

  it("resolvePending() atomically resolves pending action_execution and queues execution", async () => {
    const id = await repo.create({
      type: "action_execution",
      requestedBy: "assistant",
      description: "Execute sensitive action",
      payload: { actionName: "send_message" },
    });

    const result = await repo.resolvePending(id, "approve", "guardian-user");
    expect(result.outcome).toBe("resolved");
    if (result.outcome !== "resolved") return;
    expect(result.approval.status).toBe("approved");
    expect(result.approval.resolvedBy).toBe("guardian-user");
    expect(result.approval.executionState).toBe("queued");
    expect(result.approval.executionError).toBeNull();
  });

  it("resolvePending() returns already_resolved on second resolve attempt", async () => {
    const id = await repo.create({
      type: "action_execution",
      requestedBy: "assistant",
      description: "Execute once",
    });
    await repo.resolvePending(id, "approve");

    const second = await repo.resolvePending(id, "reject");
    expect(second.outcome).toBe("already_resolved");
  });

  it("claimExecution() claims exactly once and moves queued -> running", async () => {
    const id = await repo.create({
      type: "action_execution",
      requestedBy: "assistant",
      description: "Claim me",
    });
    await repo.resolvePending(id, "approve");

    const first = await repo.claimExecution(id);
    const second = await repo.claimExecution(id);

    expect(first).toBe(true);
    expect(second).toBe(false);
    const approval = await repo.findById(id);
    expect(approval!.executionState).toBe("running");
  });

  it("claimExecution() rejects idle (non-queued) approvals", async () => {
    const id = await repo.create({
      type: "action_execution",
      requestedBy: "assistant",
      description: "Not queued",
    });
    // Approve directly (bypasses resolvePending, so executionState stays "idle")
    await repo.approve(id);

    const claimed = await repo.claimExecution(id);
    expect(claimed).toBe(false);

    const approval = await repo.findById(id);
    expect(approval!.executionState).toBe("idle");
  });

  it("markExecuted() sets succeeded state and executedAt", async () => {
    const id = await repo.create({
      type: "action_execution",
      requestedBy: "assistant",
      description: "Finish me",
    });
    await repo.resolvePending(id, "approve");
    await repo.claimExecution(id);

    await repo.markExecuted(id);

    const approval = await repo.findById(id);
    expect(approval!.executionState).toBe("succeeded");
    expect(approval!.executionError).toBeNull();
    expect(approval!.executedAt).toBeInstanceOf(Date);
  });

  it("retryFailedExecution() re-queues failed approved action executions", async () => {
    const id = await repo.create({
      type: "action_execution",
      requestedBy: "assistant",
      description: "Retry me",
    });
    await repo.resolvePending(id, "approve");
    await repo.claimExecution(id);
    await repo.markExecutionFailed(id, "network timeout");

    const retry = await repo.retryFailedExecution(id);
    expect(retry.outcome).toBe("queued");
    if (retry.outcome !== "queued") return;
    expect(retry.approval.executionState).toBe("queued");
    expect(retry.approval.executionError).toBeNull();
    expect(retry.approval.executedAt).toBeNull();
  });

  it("retryFailedExecution() rejects non-failed approvals", async () => {
    const id = await repo.create({
      type: "action_execution",
      requestedBy: "assistant",
      description: "Already succeeded",
    });
    await repo.resolvePending(id, "approve");
    await repo.claimExecution(id);
    await repo.markExecuted(id);

    const retry = await repo.retryFailedExecution(id);
    expect(retry.outcome).toBe("not_retryable");
  });

  // findActiveRootExecutionIds — pending approvals persist indefinitely
  describe("findActiveRootExecutionIds", () => {
    async function insertApprovalRow(row: {
      id: string;
      status: "pending" | "approved" | "rejected" | "auto_approved";
      executionState: "idle" | "queued" | "running" | "succeeded" | "failed";
      rootExecutionId: string;
      createdAt: Date;
    }) {
      await testDb.db.insert(approvals).values({
        id: row.id,
        type: "action_execution",
        status: row.status,
        executionState: row.executionState,
        requestedBy: "main",
        description: `seeded approval ${row.id}`,
        payload: { rootExecutionId: row.rootExecutionId },
        createdAt: row.createdAt,
      });
    }

    it("includes a 30-day-old pending approval (no time-based auto-reject)", async () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
      await insertApprovalRow({
        id: "ancient-pending",
        status: "pending",
        executionState: "idle",
        rootExecutionId: "exec-ancient",
        createdAt: thirtyDaysAgo,
      });

      const ids = await repo.findActiveRootExecutionIds();
      expect(ids).toContain("exec-ancient");
    });

    it("includes a 365-day-old pending approval", async () => {
      const oneYearAgo = new Date(Date.now() - 365 * 86400000);
      await insertApprovalRow({
        id: "year-old-pending",
        status: "pending",
        executionState: "idle",
        rootExecutionId: "exec-year-old",
        createdAt: oneYearAgo,
      });

      const ids = await repo.findActiveRootExecutionIds();
      expect(ids).toContain("exec-year-old");
    });

    it("excludes approvals that succeeded (terminal state) even when recent", async () => {
      await insertApprovalRow({
        id: "fresh-succeeded",
        status: "approved",
        executionState: "succeeded",
        rootExecutionId: "exec-succeeded",
        createdAt: new Date(),
      });

      const ids = await repo.findActiveRootExecutionIds();
      expect(ids).not.toContain("exec-succeeded");
    });

    it("excludes rejected approvals", async () => {
      await insertApprovalRow({
        id: "fresh-rejected",
        status: "rejected",
        executionState: "idle",
        rootExecutionId: "exec-rejected",
        createdAt: new Date(),
      });

      const ids = await repo.findActiveRootExecutionIds();
      expect(ids).not.toContain("exec-rejected");
    });

    it("includes approved approvals stuck in non-terminal execution states (queued/running/failed)", async () => {
      await insertApprovalRow({
        id: "queued",
        status: "approved",
        executionState: "queued",
        rootExecutionId: "exec-queued",
        createdAt: new Date(),
      });
      await insertApprovalRow({
        id: "running",
        status: "approved",
        executionState: "running",
        rootExecutionId: "exec-running",
        createdAt: new Date(),
      });
      await insertApprovalRow({
        id: "failed",
        status: "approved",
        executionState: "failed",
        rootExecutionId: "exec-failed",
        createdAt: new Date(),
      });

      const ids = await repo.findActiveRootExecutionIds();
      expect(ids).toEqual(expect.arrayContaining(["exec-queued", "exec-running", "exec-failed"]));
    });
  });
});
