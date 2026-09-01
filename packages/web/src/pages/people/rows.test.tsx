// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "@/i18n";
import { DirectoryRow } from "./rows";
import type { PeopleRow } from "./people-model";

// The roster's row. It is rendered by the page and by the design note's
// specimens (`dev/mdx/docs/people-demo.tsx`), so what it offers is a contract
// between the two — a row that only the page could drive would leave the note
// describing something else.

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function row(over: Partial<PeopleRow> = {}): PeopleRow {
  return {
    kind: "person",
    id: "wei-chen",
    displayName: "Wei Chen",
    level: "inner-circle",
    accounts: [{ channel: "telegram", channelUserId: "418820113", displayName: "wei_c" }],
    addresses: ["418820113"],
    latest: null,
    messageCount: 0,
    ...over,
  };
}

describe("DirectoryRow", () => {
  it("names the identifier a person is recognized by", async () => {
    render(<DirectoryRow row={row()} />);
    expect(screen.getByText("418820113")).toBeTruthy();
  });

  it("says the same thing about a contact nobody has heard from as about anyone else", () => {
    // The directory read carries nothing about what was said, so there is
    // nothing to distinguish these rows by — and a contacts list has no reason
    // to.
    render(<DirectoryRow row={row({ kind: "account" })} />);
    expect(screen.getByText("418820113")).toBeTruthy();
  });

  it("makes the avatar the selection control, and exposes the state as state", async () => {
    // Selecting is what the avatar does in the roster — the design's way into
    // the bulk bar. `aria-pressed` is how that reaches assistive tech; a tint
    // alone would say it only to the sighted.
    const user = userEvent.setup();
    const onToggleSelect = rs.fn();
    render(<DirectoryRow row={row()} selected={false} onToggleSelect={onToggleSelect} />);

    const select = screen.getByRole("button", { name: "Select Wei Chen" });
    expect(select.getAttribute("aria-pressed")).toBe("false");
    await user.click(select);
    expect(onToggleSelect).toHaveBeenCalledOnce();
  });

  it("leaves the avatar an ornament where nothing can be selected", () => {
    // The page does not carry selection until the bulk bar lands (#67), and a
    // control that does nothing is worse than no control: it takes a tab stop
    // and promises an action.
    render(<DirectoryRow row={row()} />);
    expect(screen.queryByRole("button", { name: /^Select/ })).toBeNull();
  });

  it("keeps the guardian out of the selection, whatever the caller offers", () => {
    // This is the guardian's own row: not moved, not merged, not selected.
    render(
      <DirectoryRow
        row={row({ id: "me", displayName: "Mock Guardian", level: "guardian" })}
        onToggleSelect={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /^Select/ })).toBeNull();
    expect(screen.getByText("That is you. Full access to every surface.")).toBeTruthy();
  });
});
