// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n";
import type { Approval } from "@/pages/ActivityPage";
import { MemoryRouter } from "react-router-dom";
import { useApprovals } from "@/hooks/use-approvals";
import { pairingFixtures } from "@/pages/dev/pairing-fixtures";
import { pairingPayload } from "@rome/api-types/approvals";
import { PairingApproval, ApprovalHistoryButton, PairingApprovals } from "./PairingApproval";

function ActivitySlice() {
  const query = useApprovals();
  return (
    <>
      {query.data
        ?.filter((row) => pairingPayload(row))
        .map((row) => (
          <PairingApproval key={row.id} approval={row} />
        ))}
      <ApprovalHistoryButton />
    </>
  );
}

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
    const code = "RP-0123ABCD";
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
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <div data-testid="activity">
            <ActivitySlice />
          </div>
          <div data-testid="connections">
            <PairingApprovals connectionIds={["telegram"]} />
          </div>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    const activity = within(screen.getByTestId("activity"));
    const connections = within(screen.getByTestId("connections"));
    await activity.findByRole("button", { name: "Approve" });
    expect(activity.getByText("ID alice")).toBeTruthy();
    expect(activity.getByText("Telegram")).toBeTruthy();
    for (const slice of [activity, connections]) {
      const summary = slice.getByText("Pair with a verification code");
      expect(summary.closest("details")?.open).toBe(false);
      fireEvent.click(summary);
    }
    await activity.findByText(code);
    expect(activity.getAllByText(code)).toHaveLength(1);
    expect(connections.getAllByText(code)).toHaveLength(1);
    expect(
      activity.getByText("Send this code to the bot in a private Telegram message from Alice."),
    ).toBeTruthy();
    expect(activity.getByText(/Valid for 10 minutes/)).toBeTruthy();
    fireEvent.click(activity.getByRole("button", { name: "Copy" }));
    await activity.findByRole("button", { name: "Code copied" });
    expect(writeText).toHaveBeenCalledWith(code);
    fireEvent.click(connections.getByRole("button", { name: "Approve" }));
    expect(resolve).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Alice \(alice\).*guardian authority/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(activity.getByText("Approved")).toBeTruthy());
    expect(connections.queryByText("Approved")).toBeNull();
    expect(connections.getByText(/No pending pairing requests/)).toBeTruthy();
    expect(activity.queryByText(code)).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);
    fireEvent.focus(activity.getByText("Approved", { exact: true }));
    expect((await screen.findByRole("tooltip")).textContent).toContain("verified-owner");
    client.clear();
  });

  it("shows the conflict even after the request leaves Connections", async () => {
    const error = "This account is already linked. Pairing was not approved.";
    const notify = rs.spyOn(toast, "error").mockImplementation(() => "test-toast");
    let resolved = false;
    rs.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("/resolve")) {
        resolved = true;
        return Response.json({ error }, { status: 409 });
      }
      if (String(input).endsWith("/code")) return Response.json({ code: "RP-0123ABCD" });
      return Response.json(
        resolved
          ? []
          : [
              {
                id: "conflict",
                type: "person_mapping",
                status: "pending",
                createdAt: new Date().toISOString(),
                payload: {
                  action: "channel_pairing",
                  channel: "telegram",
                  connectionId: "bot",
                  channelUserId: "alice",
                  displayName: "Alice",
                  expiresAt: Date.now() + 600_000,
                  failedAttempts: 0,
                  lastGuidanceAt: Date.now(),
                },
              },
            ],
      );
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <PairingApprovals />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Approve" }),
    );
    await screen.findByText(/No pending pairing requests/);
    expect(notify).toHaveBeenCalledWith(error);
    expect(screen.queryByRole("dialog")).toBeNull();
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
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <PairingApprovals />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    await screen.findByText(/No pending pairing requests/);
    expect(screen.queryByText("Expired")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(fetch.mock.calls.every(([url]) => String(url) === "/api/approvals")).toBe(true);
    client.clear();
  });
  it("keeps loaded history in Activity and only active requests in Connections", async () => {
    const makeRow = (id: string, status: "pending" | "approved"): Approval => ({
      id,
      type: "person_mapping",
      status,
      requestedBy: "telegram:alice",
      description: "Pair",
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      resolvedBy: null,
      executedAt: null,
      executionError: null,
      payload: {
        action: "channel_pairing",
        channel: "telegram",
        connectionId: "telegram",
        channelUserId: id,
        displayName: id,
        expiresAt: Date.now() + 600_000,
        failedAttempts: 0,
        lastGuidanceAt: Date.now(),
      },
    });
    const first = [
      makeRow("pending-user", "pending"),
      ...Array.from({ length: 100 }, (_, n) => makeRow(`history-${n}`, "approved")),
    ];
    const fetch = rs.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/code")) return Response.json({ code: "ROME-PAIR-EXAMPLE" });
      return Response.json(
        url.includes("pairingHistoryOffset=100") ? [makeRow("earlier-user", "approved")] : first,
      );
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <div data-testid="activity">
            <ActivitySlice />
          </div>
          <div data-testid="connections">
            <PairingApprovals connectionIds={["telegram"]} />
          </div>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    const activity = within(screen.getByTestId("activity"));
    const connections = within(screen.getByTestId("connections"));
    fireEvent.click(await activity.findByRole("button", { name: "Load earlier pairing requests" }));
    await activity.findByText("earlier-user");
    expect(connections.queryByText("earlier-user")).toBeNull();
    expect(connections.queryByText("history-0")).toBeNull();
    expect(
      connections.getByRole("link", { name: "View all requests in Activity" }).getAttribute("href"),
    ).toBe("/activity");
    expect(connections.queryByRole("button", { name: "Load earlier pairing requests" })).toBeNull();
    expect(activity.getByText("pending-user")).toBeTruthy();
    expect(activity.queryByRole("button", { name: "Load earlier pairing requests" })).toBeNull();
    expect(fetch.mock.calls.some(([url]) => String(url).includes("pairingHistoryOffset=100"))).toBe(
      true,
    );
    client.clear();
  });
});

it("waits for refreshed approval state when the code endpoint returns null", async () => {
  const approval = pairingFixtures()[0];
  rs.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ code: null }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    render(
      <QueryClientProvider client={client}>
        <PairingApproval approval={approval} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(client.isFetching()).toBe(0));
    fireEvent.click(screen.getByText("Pair with a verification code"));
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  } finally {
    client.clear();
  }
});
