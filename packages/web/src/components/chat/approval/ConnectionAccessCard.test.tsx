// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "@/i18n";
import type { ApprovalRecord, PreviewPayload } from "@/lib/chat-types";
import { ApprovalCard } from "./ApprovalCard";

const mockFetchApproval = rs.hoisted(() => rs.fn());
const mockResolveApproval = rs.hoisted(() => rs.fn());

rs.mock("@/hooks/use-tab-status", () => ({ useTabStatus: rs.fn() }));
rs.mock("@/lib/chat-api", () => ({
  fetchApproval: mockFetchApproval,
  resolveApproval: mockResolveApproval,
}));

const preview = (
  over: Partial<Extract<PreviewPayload, { kind: "connection_access" }>> = {},
): PreviewPayload => ({
  kind: "connection_access",
  appId: "lark",
  appName: "Lark",
  connectionId: "feishu-1",
  connectionKind: "feishu",
  connectionLabel: "Rome local",
  identity: "app",
  preset: "read_and_write",
  operations: [
    { name: "feishu.document.read", sideEffect: "read-only" },
    { name: "feishu.wiki.spaces", sideEffect: "read-only" },
    { name: "feishu.document.update", sideEffect: "write" },
  ],
  reason: "Read and update your Feishu documents",
  title: "Allow Lark to access Rome local",
  summary: "Read and update your Feishu documents (2 read and 1 write operations)",
  ...over,
});

const record = (patch: Partial<ApprovalRecord>): ApprovalRecord => ({
  id: "appr-conn-1",
  status: "pending",
  executionState: null,
  executionError: null,
  ...patch,
});

function mount(
  p: PreviewPayload,
  settled: "fold" | "full" = "fold",
  actionName = "core:request_connection_access",
) {
  return render(
    <ApprovalCard
      approvalId="appr-conn-1"
      actionName={actionName}
      preview={p}
      status="pending"
      onResolved={() => {}}
      settled={settled}
    />,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  mockFetchApproval.mockReset();
  mockResolveApproval.mockReset();
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

describe("ConnectionAccessCard via ApprovalCard", () => {
  it("renders a calm neutral authorization card with grouped capabilities and expandable details", async () => {
    mockFetchApproval.mockResolvedValue(record({ status: "pending" }));
    const { container } = mount(preview());

    expect(screen.getByText("Allow Lark to access Rome local")).toBeTruthy();
    expect(screen.getByText("Read and update your Feishu documents")).toBeTruthy();
    expect(screen.getByText("Documents")).toBeTruthy();
    expect(screen.getByText("Wiki")).toBeTruthy();
    expect(screen.getByText("Write actions still ask for your approval each time")).toBeTruthy();
    expect(container.querySelector("[class*='warning']")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText("Read documents")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "View 3 permissions" }));
    expect(screen.getByText("Read documents")).toBeTruthy();
    expect(screen.getByText("List Wiki spaces")).toBeTruthy();
    expect(screen.getByText("Update documents")).toBeTruthy();

    await waitFor(() =>
      expect(container.querySelector("[data-chat-pending-card='approval']")).toBeTruthy(),
    );
  });

  it("approves through resolveApproval and folds to the granted summary", async () => {
    let status: ApprovalRecord["status"] = "pending";
    mockFetchApproval.mockImplementation(async () => record({ status }));
    mockResolveApproval.mockImplementation(async () => {
      status = "approved";
      return { ok: true };
    });

    mount(preview());
    await userEvent.click(screen.getByRole("button", { name: "Grant access" }));

    await waitFor(() => expect(mockResolveApproval).toHaveBeenCalledWith("appr-conn-1", "approve"));
    expect(await screen.findByText("Granted Lark access to Rome local")).toBeTruthy();
  });

  it("declines through resolveApproval and folds to the declined summary", async () => {
    let status: ApprovalRecord["status"] = "pending";
    mockFetchApproval.mockImplementation(async () => record({ status }));
    mockResolveApproval.mockImplementation(async () => {
      status = "rejected";
      return { ok: true };
    });

    mount(preview());
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));

    await waitFor(() => expect(mockResolveApproval).toHaveBeenCalledWith("appr-conn-1", "reject"));
    const fold = await screen.findByRole("button", {
      name: "Declined Lark access to Rome local",
    });
    await userEvent.click(fold);
    expect(screen.getByText("Allow Lark to access Rome local")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Grant access" })).toBeNull();
  });
});
