// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ApprovalRecord } from "@/lib/chat-types";
import { ApprovalCard } from "./ApprovalCard";

const mockUseTabStatus = rs.hoisted(() => rs.fn());
const mockFetchApproval = rs.hoisted(() => rs.fn());
const mockResolveApproval = rs.hoisted(() => rs.fn());

rs.mock("@/hooks/use-tab-status", () => ({
  useTabStatus: mockUseTabStatus,
}));

rs.mock("@/lib/chat-api", () => ({
  fetchApproval: mockFetchApproval,
  resolveApproval: mockResolveApproval,
}));

rs.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const record = (patch: Partial<ApprovalRecord>): ApprovalRecord => ({
  id: "appr-1",
  status: "pending",
  executionState: null,
  executionError: null,
  ...patch,
});

const lastTabStatus = () => mockUseTabStatus.mock.calls.at(-1)?.[0];

function mountCard() {
  return render(
    <ApprovalCard
      approvalId="appr-1"
      preview={{ kind: "generic", title: "Send email", summary: "To the team" }}
      status="pending"
      onResolved={() => {}}
    />,
  );
}

describe("ApprovalCard tab status", () => {
  beforeEach(() => {
    mockUseTabStatus.mockReset();
    mockFetchApproval.mockReset();
    mockResolveApproval.mockReset();
  });

  afterEach(cleanup);

  it("waits for the server before claiming Needs you", () => {
    mockFetchApproval.mockReturnValue(new Promise(() => {}));
    mountCard();
    expect(lastTabStatus()).toBe("idle");
  });

  it("claims Needs you while the server says the approval is pending", async () => {
    mockFetchApproval.mockResolvedValue(record({ status: "pending" }));
    mountCard();
    await waitFor(() => expect(lastTabStatus()).toBe("needs-you"));
  });

  it("stays idle for an approval the server already resolved", async () => {
    mockFetchApproval.mockResolvedValue(record({ status: "rejected" }));
    mountCard();
    await waitFor(() => expect(screen.getByText("approvals.status.rejected")).toBeTruthy());
    expect(lastTabStatus()).toBe("idle");
  });

  it("does not count an approved action that is still running", async () => {
    mockFetchApproval.mockResolvedValue(record({ status: "approved", executionState: "running" }));
    mountCard();
    await waitFor(() => expect(screen.getByText("approvals.status.executing")).toBeTruthy());
    expect(lastTabStatus()).toBe("idle");
  });

  it("releases the claim once the guardian approves", async () => {
    mockFetchApproval.mockResolvedValue(record({ status: "pending" }));
    mockResolveApproval.mockResolvedValue({ ok: true });
    mountCard();
    await waitFor(() => expect(lastTabStatus()).toBe("needs-you"));

    fireEvent.click(screen.getByText("approvals.actions.approve"));
    await waitFor(() => expect(lastTabStatus()).toBe("idle"));
  });
});
