// @rstest-environment jsdom
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "@/i18n";
import { UnknownEntry } from "./triage";
import type { LinkTarget, PeopleRow, PeopleView } from "./people-model";

// The recommendation as it reaches the two People surfaces: the Latest stream's
// dense buttons and the Directory's row menu. What is pinned here is that an
// exact name-match is *offered*, never taken — it names a target, reveals every
// match with its bond, and leaves the full picker and the other choices in
// place. `recommendedLinkTargets` (people-model.test.ts) already pins which
// people match; this pins what the guardian then sees and that viewing writes
// nothing.

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

const alicia: LinkTarget = { id: "alicia", displayName: "Alicia Chen", bondLevel: "acquaintance" };
const aliciaToo: LinkTarget = {
  id: "alicia-2",
  displayName: "alicia chen",
  bondLevel: "inner-circle",
};
const bob: LinkTarget = { id: "bob", displayName: "Bob Ng", bondLevel: "other" };

function accountRow(displayName: string): PeopleRow {
  return {
    kind: "account",
    id: "telegram:u-1",
    displayName,
    level: "unknown",
    accounts: [{ channel: "telegram", channelUserId: "u-1", displayName }],
    addresses: ["u-1"],
    latest: null,
    messageCount: 0,
  };
}

function renderEntry(props: {
  row?: PeopleRow;
  people?: LinkTarget[];
  recommendations?: LinkTarget[];
  variant?: PeopleView;
}) {
  // A write only ever reaches the client here; the tests assert it never fires.
  // The provider is what lets `usePeopleWrites` mount, nothing more.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(
    <UnknownEntry
      row={props.row ?? accountRow("Alicia Chen")}
      people={props.people ?? [alicia, bob]}
      recommendations={props.recommendations ?? [alicia]}
      variant={props.variant ?? "latest"}
    />,
    { wrapper },
  );
}

describe("UnknownEntry recommendations", () => {
  it("names the single recommended person on the Latest link action, and writes nothing", () => {
    const fetchSpy = rs.spyOn(globalThis, "fetch");
    renderEntry({ recommendations: [alicia] });

    // The link action itself identifies the target — a guardian reads who is
    // recommended without opening anything.
    expect(screen.getByRole("button", { name: "Link to Alicia Chen" })).toBeTruthy();
    // The other placement choices are untouched.
    expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Treat as stranger" })).toBeTruthy();
    // Surfacing a recommendation is a read.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reveals the recommended person with their bond and keeps the full picker", async () => {
    const user = userEvent.setup();
    const fetchSpy = rs.spyOn(globalThis, "fetch");
    renderEntry({ recommendations: [alicia], people: [alicia, bob] });

    await user.click(screen.getByRole("button", { name: "Link to Alicia Chen" }));

    // The match, offered as a one-click link with enough context to tell people
    // apart — but not taken.
    expect(await screen.findByRole("button", { name: /Alicia Chen · Acquaintance/ })).toBeTruthy();
    // The normal picker over every eligible person is still there.
    expect(screen.getByText("Link to existing person")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("counts several exact matches and reveals them all, choosing none", async () => {
    const user = userEvent.setup();
    renderEntry({ recommendations: [alicia, aliciaToo], people: [alicia, aliciaToo, bob] });

    await user.click(screen.getByRole("button", { name: "Link — 2 suggested" }));

    // Both are offered, each with its own bond, and Rome has picked neither.
    expect(screen.getByRole("button", { name: /Alicia Chen · Acquaintance/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /alicia chen · Inner circle/ })).toBeTruthy();
  });

  it("links the recommended person the guardian actually clicks, not the first match", async () => {
    // With several matches, the write has to carry the id of the one clicked. A
    // regression that always linked the first match would pass every test above
    // this one, so this pins the id on the wire itself.
    const user = userEvent.setup();
    const fetchSpy = rs
      .spyOn(globalThis, "fetch")
      .mockImplementation((async () => Response.json({}, { status: 200 })) as typeof fetch);
    renderEntry({ recommendations: [alicia, aliciaToo], people: [alicia, aliciaToo, bob] });

    await user.click(screen.getByRole("button", { name: "Link — 2 suggested" }));
    // The SECOND match, whose id differs from the first.
    await user.click(await screen.findByRole("button", { name: /alicia chen · Inner circle/ }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0];
    // POST /api/people/:id/accounts, carrying the clicked person's id — not the
    // first match's ("alicia").
    expect(String(url)).toBe("/api/people/alicia-2/accounts");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("names the recommended person in the Directory row menu", async () => {
    const user = userEvent.setup();
    renderEntry({ variant: "directory", recommendations: [alicia] });

    await user.click(screen.getByRole("button", { name: "Actions for Alicia Chen" }));
    expect(await screen.findByRole("menuitem", { name: "Link to Alicia Chen" })).toBeTruthy();
  });

  it("leaves the plain choices when nothing matches", () => {
    renderEntry({ row: accountRow("Nobody Here"), people: [bob], recommendations: [] });

    expect(screen.getByRole("button", { name: "Link" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Treat as stranger" })).toBeTruthy();
    // No recommendation is invented for an account whose name matches nobody.
    expect(screen.queryByRole("button", { name: /^Link to/ })).toBeNull();
  });
});
