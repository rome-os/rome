import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { createTestDb, type TestDb } from "../test/db.js";
import { ApprovalsRepository } from "../apps/repositories/approvals.js";
import { RESOLVED_BY_EXPIRY, RESOLVED_BY_STOP, turnDownApprovals } from "./approval-expiry.js";

describe("turnDownApprovals", () => {
  let testDb: TestDb;
  let approvals: ApprovalsRepository;
  const onRejected = rs.fn(async () => {});

  beforeEach(() => {
    testDb = createTestDb();
    approvals = new ApprovalsRepository(testDb.db);
    onRejected.mockClear();
  });
  afterEach(() => testDb.close());

  const ask = (threadId: string) =>
    approvals.create({
      type: "action_execution",
      requestedBy: "agent:main",
      description: "Send the mail",
      payload: { actionName: "send", args: {}, channelContext: { channel: "webchat", threadId } },
    });

  it("turns down the chat's pending approvals and lets the turn carry on, told why", async () => {
    const mine = await ask("task-chat");
    await ask("other-chat");
    const turned = await turnDownApprovals({ approvals, handler: { onRejected } }, "task-chat", {
      until: Number.POSITIVE_INFINITY,
      reason: "No response within a day",
      resolvedBy: RESOLVED_BY_EXPIRY,
      continueTurn: true,
    });
    expect(turned).toBe(1);
    expect((await approvals.findById(mine))?.status).toBe("rejected");
    expect((await approvals.findById(mine))?.resolvedBy).toBe(RESOLVED_BY_EXPIRY);
    expect(onRejected).toHaveBeenCalledWith(mine, "No response within a day");
    // A repeat turns down nothing more.
    expect(
      await turnDownApprovals({ approvals, handler: { onRejected } }, "task-chat", {
        until: Number.POSITIVE_INFINITY,
        reason: "again",
        resolvedBy: RESOLVED_BY_EXPIRY,
        continueTurn: true,
      }),
    ).toBe(0);
  });

  it("runs no turn on for a stopped task, and records the stop as why", async () => {
    const mine = await ask("task-chat");
    await turnDownApprovals({ approvals, handler: { onRejected } }, "task-chat", {
      until: Number.POSITIVE_INFINITY,
      reason: "The task was stopped",
      resolvedBy: RESOLVED_BY_STOP,
      continueTurn: false,
    });
    expect(onRejected).not.toHaveBeenCalled();
    expect((await approvals.findById(mine))?.resolvedBy).toBe(RESOLVED_BY_STOP);
  });
});
