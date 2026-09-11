// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PairingCodeSection, PairingConfirmationDialog, PairingRequestCard } from "./pairing-views";

afterEach(cleanup);

beforeAll(() => i18n.changeLanguage("en"));

describe("pairing presentation without query or router providers", () => {
  it("emits intent and waits for parent state before displaying approval", () => {
    const onApprove = rs.fn();
    const props = {
      name: "Alice",
      accountId: "alice",
      channel: "Telegram",
      createdAt: "2026-09-10T10:00:00.000Z",
      expiresAt: Date.UTC(2026, 8, 10, 10, 10),
      status: "pending" as const,
      onApprove,
      onReject: rs.fn(),
    };
    const view = render(<PairingRequestCard {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Approved")).toBeNull();
    view.rerender(<PairingRequestCard {...props} busy="approve" />);
    expect(screen.getByRole("button", { name: "Approving…" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Reject" }).hasAttribute("disabled")).toBe(true);
    view.rerender(<PairingRequestCard {...props} status="approved" />);
    expect(screen.getByText("Approved")).toBeTruthy();
    expect(screen.getByText(/Valid for 10 minutes/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("delegates retry and copy while rendering the supplied feedback", () => {
    const onRetry = rs.fn();
    const onCopy = rs.fn();
    const props = {
      channel: "Telegram",
      accountName: "Alice",
      defaultOpen: true,
      onCopy,
      onRetry,
    };
    const view = render(<PairingCodeSection {...props} state={{ kind: "error" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    view.rerender(
      <PairingCodeSection
        {...props}
        state={{ kind: "ready", code: "RP-12AB34CD", copied: false }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Code copied" })).toBeNull();
    view.rerender(
      <PairingCodeSection
        {...props}
        state={{ kind: "ready", code: "RP-12AB34CD", copied: true }}
      />,
    );
    expect(screen.getByRole("button", { name: "Code copied" })).toBeTruthy();
    view.rerender(<PairingCodeSection {...props} state={{ kind: "locked" }} />);
    expect(screen.queryByText("RP-12AB34CD")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });

  it("prevents dismissal while approval is in flight and leaves failure retryable", () => {
    const onCancel = rs.fn();
    const onConfirm = rs.fn();
    const props = {
      open: true,
      name: "Alice",
      accountId: "alice",
      channel: "Telegram",
      onCancel,
      onConfirm,
    };
    const view = render(<PairingConfirmationDialog {...props} busy />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Approving…" }).hasAttribute("disabled")).toBe(true);
    view.rerender(<PairingConfirmationDialog {...props} error />);
    expect(screen.getByRole("alert").textContent).toBe(
      i18n.t("pairing.resolveFailed", { ns: "activity" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
