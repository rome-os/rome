// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const preview = (over: Partial<Extract<PreviewPayload, { kind: "secret_access" }>> = {}) =>
  ({
    kind: "secret_access",
    name: "GITHUB_TOKEN",
    ttlMinutes: 15,
    reason: "Push the release tag",
    title: "Use GITHUB_TOKEN for 15 min",
    summary: "Push the release tag",
    ...over,
  }) as PreviewPayload;

const record = (patch: Partial<ApprovalRecord>): ApprovalRecord => ({
  id: "appr-1",
  status: "pending",
  executionState: null,
  executionError: null,
  ...patch,
});

function mount(
  p: PreviewPayload,
  settled: "fold" | "full" = "fold",
  actionName = "system:vault_apply",
) {
  return render(
    <ApprovalCard
      approvalId="appr-1"
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

afterEach(cleanup);

describe("a secret-access approval card", () => {
  it("asks for the name, the duration and the reason, in a neutral card with no action name", async () => {
    mockFetchApproval.mockResolvedValue(record({ status: "pending" }));
    const { container } = mount(preview());

    expect(screen.getByText("GITHUB_TOKEN")).toBeTruthy();
    expect(screen.getByText("15 min")).toBeTruthy();
    expect(screen.getByText("Push the release tag")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow 15 min" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
    expect(screen.queryByText("Guardian approval needed")).toBeNull();
    expect(screen.queryByText("vault_apply")).toBeNull();
    expect(container.querySelector("[class*='warning']")).toBeNull();
    await waitFor(() =>
      expect(container.querySelector("[data-chat-pending-card='approval']")).toBeTruthy(),
    );
  });

  it("takes the duration from the request", () => {
    mockFetchApproval.mockReturnValue(new Promise(() => {}));
    mount(preview({ ttlMinutes: 180 }));
    expect(screen.getByRole("button", { name: "Allow 180 min" })).toBeTruthy();
  });

  it("sends the guardian's answer", async () => {
    mockFetchApproval.mockResolvedValue(record({ status: "pending" }));
    mockResolveApproval.mockResolvedValue({ ok: true });
    mount(preview());
    fireEvent.click(screen.getByRole("button", { name: "Allow 15 min" }));
    await waitFor(() => expect(mockResolveApproval).toHaveBeenCalledWith("appr-1", "approve"));
  });

  it("folds an allowed request to one line, without the reason", async () => {
    mockFetchApproval.mockResolvedValue(record({ status: "approved" }));
    mount(preview());
    const fold = await screen.findByRole("button", { name: "Allowed GITHUB_TOKEN · 15 min" });
    expect(fold.textContent).toBe("Allowed GITHUB_TOKEN · 15 min");
    expect(screen.queryByText("Push the release tag")).toBeNull();
    // Opened, it shows the request again, now with no answers to give.
    fold.click();
    expect(await screen.findByText("Push the release tag")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("folds a rejected request to one line", async () => {
    mockFetchApproval.mockResolvedValue(record({ status: "rejected" }));
    mount(preview());
    const fold = await screen.findByRole("button", { name: "Rejected GITHUB_TOKEN" });
    expect(fold.textContent).toBe("Rejected GITHUB_TOKEN");
    expect(screen.queryByText("Push the release tag")).toBeNull();
  });

  it("reads a request Rome turned down as any approval does", async () => {
    mockFetchApproval.mockResolvedValue(
      record({ status: "rejected", resolvedBy: "rome:task-ended" }),
    );
    mount(preview());
    expect(await screen.findByText(/^Turned down/)).toBeTruthy();
  });

  it("wraps a long name anywhere, on the card and folded", async () => {
    const name = "PRODUCTION_DATABASE_READONLY_REPLICA_PASSWORD_2026";
    mockFetchApproval.mockResolvedValue(record({ status: "pending" }));
    const pending = mount(preview({ name }));
    expect(screen.getByText(name).className).toContain("wrap-anywhere");
    pending.unmount();

    mockFetchApproval.mockResolvedValue(record({ status: "approved" }));
    mount(preview({ name }));
    const line = await screen.findByText(`Allowed ${name} · 15 min`);
    expect(line.className).toContain("wrap-anywhere");
  });

  it("speaks Chinese", async () => {
    await i18n.changeLanguage("zh-CN");
    try {
      mockFetchApproval.mockResolvedValue(record({ status: "pending" }));
      mount(preview());
      expect(screen.getByText("15 分钟")).toBeTruthy();
      expect(screen.getByRole("button", { name: "允许 15 分钟" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "拒绝" })).toBeTruthy();
      cleanup();

      mockFetchApproval.mockResolvedValue(record({ status: "approved" }));
      mount(preview());
      expect(await screen.findByText("已允许 GITHUB_TOKEN · 15 分钟")).toBeTruthy();
      cleanup();

      mockFetchApproval.mockResolvedValue(record({ status: "rejected" }));
      mount(preview());
      expect(await screen.findByText("已拒绝 GITHUB_TOKEN")).toBeTruthy();
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});

describe("the generic approval card", () => {
  it("keeps its warning frame, action name and title", async () => {
    mockFetchApproval.mockResolvedValue(record({ status: "pending" }));
    mount({ kind: "generic", title: "Send email", summary: "To the team" }, "full", "send_email");
    expect(screen.getByText("Guardian approval needed")).toBeTruthy();
    expect(screen.getByText("send_email")).toBeTruthy();
    expect(screen.getByText("Send email")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("still folds to its title and outcome", async () => {
    mockFetchApproval.mockResolvedValue(record({ status: "approved" }));
    mount({ kind: "generic", title: "Send email", summary: "To the team" });
    const fold = await screen.findByRole("button", { name: /Send email/ });
    expect(fold.textContent).toBe("Send emailApproved");
  });
});
