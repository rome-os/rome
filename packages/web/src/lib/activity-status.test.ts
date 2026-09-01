import { describe, expect, it } from "@rstest/core";
import {
  getApprovalDisplayStatus,
  hasActivityError,
  matchesActivityFilter,
} from "@/lib/activity-status";

describe("getApprovalDisplayStatus", () => {
  it("marks approved action executions with execution errors as execution_failed", () => {
    expect(
      getApprovalDisplayStatus({
        type: "action_execution",
        status: "approved",
        executionError: "boom",
        executedAt: null,
      }),
    ).toBe("execution_failed");
  });
});

describe("hasActivityError", () => {
  it("treats failed webhook callbacks as errors", () => {
    expect(
      hasActivityError({
        kind: "webhook_invocation",
        data: {
          status: "success",
          error: null,
          callbackStatus: "failed",
          callbackError: "HTTP 502",
        },
      }),
    ).toBe(true);
  });

  it("treats execution_failed approvals as errors", () => {
    expect(
      hasActivityError({
        kind: "approval",
        data: {
          type: "action_execution",
          status: "approved",
          executionError: "boom",
          executedAt: null,
        },
      }),
    ).toBe(true);
  });
});

describe("matchesActivityFilter", () => {
  it("includes failed webhook callbacks in the error filter", () => {
    expect(
      matchesActivityFilter(
        {
          kind: "webhook_invocation",
          data: {
            status: "success",
            error: null,
            callbackStatus: "failed",
            callbackError: "HTTP 502",
          },
        },
        "error",
      ),
    ).toBe(true);
  });
});
