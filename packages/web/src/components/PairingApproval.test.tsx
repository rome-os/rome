// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n";
import type { Approval } from "@/pages/ActivityPage";
import { useApprovals } from "@/hooks/use-approvals";
import { pairingPayload } from "@rome/api-types/approvals";
import { PairingApproval, ApprovalHistoryButton } from "./PairingApproval";

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

function row(id: string, status: Approval["status"], resolution?: string): Approval {
  return {
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
      ...(resolution ? { resolution } : {}),
    },
  };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

describe("stored pairing requests", () => {
  it("shows each request's end and offers no action", () => {
    render(
      <>
        <PairingApproval approval={row("approved-user", "approved", "web")} />
        <PairingApproval approval={row("rejected-user", "rejected", "rejected")} />
        <PairingApproval approval={row("expired-user", "rejected", "expired")} />
        <PairingApproval approval={row("pending-user", "pending")} />
      </>,
    );
    expect(screen.getByText("Approved")).toBeTruthy();
    expect(screen.getByText("Rejected")).toBeTruthy();
    // A request still pending in storage can never be resolved, so it reads as expired.
    expect(screen.getAllByText("Expired")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("pages earlier history in Activity", async () => {
    const first = Array.from({ length: 100 }, (_, n) => row(`history-${n}`, "approved", "web"));
    const fetch = rs
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        Response.json(
          String(input).includes("pairingHistoryOffset=100")
            ? [row("earlier-user", "approved", "web")]
            : first,
        ),
      );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ActivitySlice />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Load earlier pairing requests" }));
    await screen.findByText("earlier-user");
    expect(screen.queryByRole("button", { name: "Load earlier pairing requests" })).toBeNull();
    expect(fetch.mock.calls.every(([url]) => !String(url).endsWith("/code"))).toBe(true);
    client.clear();
  });
});
