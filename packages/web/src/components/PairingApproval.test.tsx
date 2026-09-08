// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n";
import type { Approval } from "@/pages/ActivityPage";
import { PairingApprovals } from "./PairingApproval";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

describe("shared pairing approvals", () => {
  it("shows one code per request, copies exactly, and updates both slices after confirmed approval", async () => {
    const approval: Approval = {
      id: "request",
      type: "person_mapping",
      status: "pending",
      requestedBy: "telegram:alice",
      description: "Pair Alice",
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      resolvedBy: null,
      executedAt: null,
      executionError: null,
      payload: {
        action: "channel_pairing",
        channel: "telegram",
        connectionId: "telegram",
        channelUserId: "alice",
        displayName: "Alice",
        expiresAt: Date.now() + 600_000,
        failedAttempts: 0,
        lastGuidanceAt: Date.now(),
      },
    };
    const code = "ROME-PAIR-0123456789ABCDEF0123";
    const writeText = rs.fn(async (_value: string) => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const resolve = rs.fn();
    rs.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/resolve")) {
        resolve(init);
        approval.status = "approved";
        approval.resolvedBy = "verified-owner";
        approval.resolvedAt = new Date().toISOString();
        return Response.json({ ok: true });
      }
      if (url.endsWith("/code")) return Response.json({ code });
      return Response.json([
        approval,
        { ...approval, id: "other", payload: { action: "auto_mapped_existing" } },
      ]);
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <div data-testid="activity">
          <PairingApprovals />
        </div>
        <div data-testid="connections">
          <PairingApprovals connectionIds={["telegram"]} />
        </div>
      </QueryClientProvider>,
    );
    const activity = within(screen.getByTestId("activity"));
    const connections = within(screen.getByTestId("connections"));
    await activity.findByText(code);
    expect(activity.getAllByText(code)).toHaveLength(1);
    expect(connections.getAllByText(code)).toHaveLength(1);
    expect(activity.getByText(/private telegram message from Alice/)).toBeTruthy();
    fireEvent.click(activity.getByRole("button", { name: "Copy code" }));
    await activity.findByText("Code copied");
    expect(writeText).toHaveBeenCalledWith(code);
    fireEvent.click(connections.getByRole("button", { name: "Approve" }));
    expect(resolve).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Alice \(alice\).*guardian authority/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(activity.getByText("Approved")).toBeTruthy());
    expect(connections.getByText("Approved")).toBeTruthy();
    expect(activity.queryByText(code)).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(activity.getByText(/verified-owner/)).toBeTruthy();
    client.clear();
  });

  it("does not offer actions or fetch a code for an expired request", async () => {
    const fetch = rs.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json([
        {
          id: "expired",
          type: "person_mapping",
          status: "pending",
          createdAt: new Date().toISOString(),
          resolvedBy: null,
          payload: {
            action: "channel_pairing",
            channel: "feishu",
            connectionId: "feishu",
            channelUserId: "alice",
            displayName: "Alice",
            expiresAt: Date.now() - 1,
            failedAttempts: 0,
            lastGuidanceAt: 0,
          },
        },
      ]),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <PairingApprovals />
      </QueryClientProvider>,
    );
    await screen.findByText("Expired");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(fetch.mock.calls.every(([url]) => String(url) === "/api/approvals")).toBe(true);
    client.clear();
  });
});
