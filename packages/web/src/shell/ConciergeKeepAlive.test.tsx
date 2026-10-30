// @rstest-environment jsdom
import { useState } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import * as conciergeModule from "@/hooks/use-concierge" with { rstest: "importActual" };
import { emitSessionDeleted } from "@/lib/session-deleted";
import { ConciergeKeepAlive } from "./ConciergeKeepAlive";

const page = rs.hoisted(() => ({ enabled: true, mounts: 0 }));

rs.mock("@/hooks/use-concierge", () => ({
  ...conciergeModule,
  useConciergeChat: () => ({
    chatId: page.enabled ? "concierge" : null,
    enabled: page.enabled,
    settingsLoading: false,
    loading: false,
  }),
}));

// The kept page: records its life and the location it sees.
rs.mock("@/pages/free/FreePage", () => ({
  default: () => null,
  ConciergePage: ({ active }: { active: boolean }) => {
    const location = useLocation();
    // Counts mounts, not effects: hiding a page runs its effects' cleanups too.
    useState(() => {
      page.mounts += 1;
    });
    return (
      <div data-testid="concierge-page" data-active={String(active)} data-at={location.pathname} />
    );
  },
}));

let go: (to: string) => void = () => {};
function Navigation() {
  const navigate = useNavigate();
  go = (to) => act(() => navigate(to));
  return null;
}

function shell() {
  return (
    <MemoryRouter initialEntries={["/chat"]}>
      <ConciergeKeepAlive />
      <Navigation />
    </MemoryRouter>
  );
}

function hidden(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.style.display === "none") return true;
  }
  return false;
}

beforeEach(() => {
  page.enabled = true;
  page.mounts = 0;
});
afterEach(() => cleanup());

describe("ConciergeKeepAlive", () => {
  it("mounts the page on the first visit, not before", async () => {
    render(shell());
    expect(screen.queryByTestId("concierge-page")).toBeNull();

    go("/chat/someone-else");
    expect(screen.queryByTestId("concierge-page")).toBeNull();

    go("/chat/concierge");
    expect((await screen.findByTestId("concierge-page")).dataset.active).toBe("true");
    expect(page.mounts).toBe(1);
  });

  it("keeps the page mounted, hidden, while another chat or page is on screen", async () => {
    render(shell());
    go("/chat/concierge");
    const concierge = await screen.findByTestId("concierge-page");

    go("/chat/someone-else");
    expect(screen.getByTestId("concierge-page")).toBe(concierge);
    expect(hidden(concierge)).toBe(true);
    expect(concierge.dataset.active).toBe("false");

    go("/settings");
    expect(screen.getByTestId("concierge-page")).toBe(concierge);
    expect(page.mounts).toBe(1);
  });

  it("shows the same page again, still at the address it was left at", async () => {
    render(shell());
    go("/chat/concierge");
    const concierge = await screen.findByTestId("concierge-page");
    go("/chat/someone-else");
    // A hidden page does not follow the router: that would render it for nothing.
    expect(concierge.dataset.at).toBe("/chat/concierge");

    go("/chat/concierge");
    expect(screen.getByTestId("concierge-page")).toBe(concierge);
    expect(hidden(concierge)).toBe(false);
    expect(concierge.dataset.active).toBe("true");
    expect(page.mounts).toBe(1);
  });

  it("lets go of the page when Concierge is turned off", async () => {
    const view = render(shell());
    go("/chat/concierge");
    await screen.findByTestId("concierge-page");
    go("/settings");

    page.enabled = false;
    view.rerender(shell());

    expect(screen.queryByTestId("concierge-page")).toBeNull();
  });

  it("lets go of the page when its chat is deleted, and starts afresh on the next visit", async () => {
    render(shell());
    go("/chat/concierge");
    await screen.findByTestId("concierge-page");

    act(() => emitSessionDeleted("someone-else"));
    expect(screen.getByTestId("concierge-page")).toBeTruthy();

    act(() => emitSessionDeleted("concierge"));
    expect(screen.queryByTestId("concierge-page")).toBeNull();

    // Still on the deleted chat's address: it is not mounted again behind the guardian's back.
    expect(screen.queryByTestId("concierge-page")).toBeNull();
    go("/chat");
    go("/chat/concierge");
    expect(await screen.findByTestId("concierge-page")).toBeTruthy();
    expect(page.mounts).toBe(2);
  });
});
