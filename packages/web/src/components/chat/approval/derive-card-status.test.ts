import { describe, expect, it } from "@rstest/core";
import type { ApprovalRecord } from "@/lib/chat-types";
import { deriveCardStatus, isTerminalCardStatus } from "./derive-card-status";

function record(overrides: Partial<ApprovalRecord>): ApprovalRecord {
  return {
    id: "appr_1",
    status: "pending",
    executionState: null,
    executionError: null,
    ...overrides,
  };
}

describe("deriveCardStatus", () => {
  it("falls back to the initial server-emitted status when no live record is loaded yet", () => {
    expect(deriveCardStatus("pending", null)).toBe("pending");
    expect(deriveCardStatus("executing", null)).toBe("executing");
    expect(deriveCardStatus("executed", null)).toBe("executed");
  });

  it("returns 'rejected' whenever the live record reports rejected, ignoring execution state", () => {
    expect(deriveCardStatus("pending", record({ status: "rejected" }))).toBe("rejected");
    expect(
      deriveCardStatus("pending", record({ status: "rejected", executionState: "running" })),
    ).toBe("rejected");
  });

  it("maps approved + succeeded execution to 'executed'", () => {
    expect(
      deriveCardStatus("pending", record({ status: "approved", executionState: "succeeded" })),
    ).toBe("executed");
    expect(
      deriveCardStatus("pending", record({ status: "auto_approved", executionState: "succeeded" })),
    ).toBe("executed");
  });

  it("maps approved + failed execution to 'failed'", () => {
    expect(
      deriveCardStatus("pending", record({ status: "approved", executionState: "failed" })),
    ).toBe("failed");
  });

  it("maps approved + running execution to 'executing'", () => {
    expect(
      deriveCardStatus("pending", record({ status: "approved", executionState: "running" })),
    ).toBe("executing");
    expect(
      deriveCardStatus("pending", record({ status: "auto_approved", executionState: "running" })),
    ).toBe("executing");
  });

  it("maps approved + idle/queued execution to 'approved'", () => {
    expect(
      deriveCardStatus("pending", record({ status: "approved", executionState: "idle" })),
    ).toBe("approved");
    expect(
      deriveCardStatus("pending", record({ status: "approved", executionState: "queued" })),
    ).toBe("approved");
    expect(deriveCardStatus("pending", record({ status: "approved" }))).toBe("approved");
  });

  it("returns 'pending' for any non-approved, non-rejected record", () => {
    expect(deriveCardStatus("executing", record({ status: "pending" }))).toBe("pending");
  });
});

describe("isTerminalCardStatus", () => {
  it("identifies rejected/executed/failed as terminal", () => {
    expect(isTerminalCardStatus("rejected")).toBe(true);
    expect(isTerminalCardStatus("executed")).toBe(true);
    expect(isTerminalCardStatus("failed")).toBe(true);
  });

  it("treats pending/approved/executing as non-terminal", () => {
    expect(isTerminalCardStatus("pending")).toBe(false);
    expect(isTerminalCardStatus("approved")).toBe(false);
    expect(isTerminalCardStatus("executing")).toBe(false);
  });
});
