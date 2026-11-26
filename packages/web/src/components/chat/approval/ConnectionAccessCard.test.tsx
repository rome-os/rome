// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
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

rs.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    disabled,
    onValueChange,
  }: {
    children: ReactNode;
    value: string;
    disabled?: boolean;
    onValueChange: (value: string) => void;
  }) => (
    <select
      aria-label="Expires"
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
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
    { name: "feishu.document.update", sideEffect: "write", approvalRequired: true },
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
    expect(screen.queryByText("Read documents")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "View 3 permissions" }));
    expect(screen.getByText("Read documents")).toBeTruthy();
    expect(screen.getByText("List Wiki spaces")).toBeTruthy();
    expect(screen.getByText("Update documents")).toBeTruthy();

    await waitFor(() =>
      expect(container.querySelector("[data-chat-pending-card='approval']")).toBeTruthy(),
    );
  });

  it("approves with chosen expiry via /api/app-connection-access/approvals/:id/approve", async () => {
    let status: ApprovalRecord["status"] = "pending";
    mockFetchApproval.mockImplementation(async () => record({ status }));
    const fetchSpy = rs.spyOn(globalThis, "fetch").mockImplementation(async () => {
      status = "approved";
      return new Response(JSON.stringify({ ok: true }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    });

    mount(preview());
    fireEvent.change(screen.getByRole("combobox", { name: "Expires" }), {
      target: { value: "7d" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Grant access" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("/api/app-connection-access/approvals/appr-conn-1/approve");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body)) as { expiresAt: string | null };
    expect(Date.parse(body.expiresAt!) - Date.now()).toBeGreaterThan(7 * 86_400_000 - 60_000);
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
