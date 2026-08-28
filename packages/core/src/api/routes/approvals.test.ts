import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import { Hono } from "hono";
import { approvalsRoutes } from "./approvals.js";
import { createTestDb, buildTestDeps, type TestDb } from "../../test/helpers.js";
import { seedBaseline, type BaselineIds } from "../../test/seeds.js";
import { ApprovalsRepository } from "../../db/repositories/approvals.js";
import type { ApprovalHandler } from "../../actions/approval-handler.js";

function stubApprovalHandler(): ApprovalHandler {
  return {
    onApproved: rs.fn(async () => {}),
    onRejected: rs.fn(async () => {}),
  } as unknown as ApprovalHandler;
}

describe("Approvals API", () => {
  let testDb: TestDb;
  let app: Hono;
  let approvalHandler: ApprovalHandler;
  let baseline: BaselineIds;

  beforeEach(async () => {
    testDb = createTestDb();
    baseline = await seedBaseline(testDb.db);
    approvalHandler = stubApprovalHandler();
    const deps = { ...(await buildTestDeps(testDb.db)), approvalHandler };
    app = new Hono().route("/", approvalsRoutes(deps));
  });

  afterEach(() => {
    testDb.close();
    rs.restoreAllMocks();
  });

  describe("GET /approvals", () => {
    it("lists baseline approvals (unfiltered)", async () => {
      const res = await app.request("/approvals");
      expect(res.status).toBe(200);
      const rows = (await res.json()) as { id: string; status: string }[];
      const ids = rows.map((r) => r.id);
      expect(ids).toEqual(
        expect.arrayContaining([
          baseline.approvals.pendingId,
          baseline.approvals.approvedId,
          baseline.approvals.rejectedId,
          baseline.approvals.failedExecutionId,
        ]),
      );
    });

    it("filters by status=pending", async () => {
      const res = await app.request("/approvals?status=pending");
      const rows = (await res.json()) as { id: string; status: string }[];
      expect(rows.every((r) => r.status === "pending")).toBe(true);
      expect(rows.map((r) => r.id)).toContain(baseline.approvals.pendingId);
      expect(rows.map((r) => r.id)).not.toContain(baseline.approvals.approvedId);
    });

    it("ignores invalid status values and returns everything", async () => {
      const filteredRes = await app.request("/approvals?status=not-a-status");
      const filtered = (await filteredRes.json()) as unknown[];
      const allRes = await app.request("/approvals");
      const all = (await allRes.json()) as unknown[];
      expect(filtered.length).toBe(all.length);
    });
  });

  describe("POST /approvals/:id/resolve", () => {
    it("rejects invalid actions with 400", async () => {
      const res = await app.request(`/approvals/${baseline.approvals.pendingId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "bogus" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 when the approval doesn't exist", async () => {
      const res = await app.request("/approvals/does-not-exist/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 409 when the approval is already resolved", async () => {
      const res = await app.request(`/approvals/${baseline.approvals.approvedId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      });
      expect(res.status).toBe(409);
    });

    it("approves and fires the approvalHandler.onApproved callback", async () => {
      const id = baseline.approvals.pendingId;
      const res = await app.request(`/approvals/${id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      });
      expect(res.status).toBe(202);
      await new Promise((r) => setTimeout(r, 5));
      expect(approvalHandler.onApproved).toHaveBeenCalledWith(id);
    });
  });

  describe("POST /approvals/:id/approve and /reject", () => {
    it("approves via the dedicated route", async () => {
      const id = baseline.approvals.pendingId;
      const res = await app.request(`/approvals/${id}/approve`, { method: "POST" });
      expect(res.status).toBe(202);
      await new Promise((r) => setTimeout(r, 5));
      expect(approvalHandler.onApproved).toHaveBeenCalledWith(id);
    });

    it("rejects via the dedicated route", async () => {
      const id = baseline.approvals.pendingId;
      const res = await app.request(`/approvals/${id}/reject`, { method: "POST" });
      expect(res.status).toBe(202);
      await new Promise((r) => setTimeout(r, 5));
      expect(approvalHandler.onRejected).toHaveBeenCalledWith(id);
    });
  });

  describe("chat affirmation does not auto-approve a pending approval", () => {
    it("hitting approval-adjacent routes (GET, list) leaves the pending approval unchanged", async () => {
      const id = baseline.approvals.pendingId;
      const repo = new ApprovalsRepository(testDb.db);

      await app.request(`/approvals/${id}`);
      await app.request("/approvals?status=pending");
      await app.request("/approvals");

      const before = await repo.findById(id);
      expect(before?.status).toBe("pending");
      expect(approvalHandler.onApproved).not.toHaveBeenCalled();
      expect(approvalHandler.onRejected).not.toHaveBeenCalled();
    });

    it("posting unrecognized 'chat affirmation'-style payloads to /resolve does not flip status", async () => {
      const id = baseline.approvals.pendingId;
      const repo = new ApprovalsRepository(testDb.db);

      const affirmationBodies = [
        { action: "yes" },
        { action: "send it" },
        { action: "ok" },
        { action: "approve send it" },
      ];
      for (const body of affirmationBodies) {
        const res = await app.request(`/approvals/${id}/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(400);
      }

      const after = await repo.findById(id);
      expect(after?.status).toBe("pending");
      expect(approvalHandler.onApproved).not.toHaveBeenCalled();
    });

    it("only POST /:id/approve flips a pending approval to approved", async () => {
      const id = baseline.approvals.pendingId;
      const repo = new ApprovalsRepository(testDb.db);

      const before = await repo.findById(id);
      expect(before?.status).toBe("pending");

      const res = await app.request(`/approvals/${id}/approve`, { method: "POST" });
      expect(res.status).toBe(202);

      const after = await repo.findById(id);
      expect(after?.status).toBe("approved");
    });
  });

  describe("post-approval execution is irrevocable (no cancel endpoints)", () => {
    it("does not register any cancel/recall/uncancel route", () => {
      const paths = app.routes.map((r) => `${r.method} ${r.path}`);
      const forbiddenPatterns = [/cancel/i, /recall/i, /uncancel/i, /undo/i, /revoke/i];
      const matches = paths.filter((p) => forbiddenPatterns.some((re) => re.test(p)));
      expect(matches).toEqual([]);
    });

    it("returns 404 for would-be cancel endpoints", async () => {
      const id = baseline.approvals.approvedId;
      const candidates = [
        `/approvals/${id}/cancel`,
        `/approvals/${id}/cancel-after-approve`,
        `/approvals/${id}/uncancel`,
        `/approvals/${id}/recall`,
        `/approvals/${id}/undo`,
      ];
      for (const path of candidates) {
        const res = await app.request(path, { method: "POST" });
        expect(res.status).toBe(404);
      }
    });
  });

  describe("POST /approvals/:id/retry", () => {
    it("requeues a failed execution", async () => {
      const id = baseline.approvals.failedExecutionId;
      const res = await app.request(`/approvals/${id}/retry`, { method: "POST" });
      expect(res.status).toBe(202);
      const body = (await res.json()) as {
        action: string;
        approval: { executionState: string };
      };
      expect(body.action).toBe("retry");
      expect(body.approval.executionState).toBe("queued");
      await new Promise((r) => setTimeout(r, 5));
      expect(approvalHandler.onApproved).toHaveBeenCalledWith(id);
    });

    it("returns 409 when the approval is not in a retryable state", async () => {
      const res = await app.request(`/approvals/${baseline.approvals.approvedId}/retry`, {
        method: "POST",
      });
      expect(res.status).toBe(409);
    });

    it("returns 404 for unknown id", async () => {
      const res = await app.request("/approvals/does-not-exist/retry", { method: "POST" });
      expect(res.status).toBe(404);
    });
  });
});
