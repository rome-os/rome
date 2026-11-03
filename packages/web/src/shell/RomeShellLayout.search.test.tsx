// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import "@/i18n";

// The sidebar's chat list is the weight the shell must not redraw to open the search.
const drawn = rs.hoisted(() => ({ chatList: 0 }));
rs.mock("./RecentChats", () => ({
  RecentChats: () => {
    drawn.chatList += 1;
    return <div data-testid="chat-list" />;
  },
}));
rs.mock("./AppGrid", () => ({
  AppGrid: ({ onSearch }: { onSearch: () => void }) => (
    <button type="button" onClick={onSearch}>
      open search
    </button>
  ),
}));
rs.mock("./ChatSearchDialog", () => ({
  ChatSearchDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog">search</div> : null,
}));
rs.mock("./DesktopTitlebar", () => ({ DesktopTitlebar: () => null }));
rs.mock("./ProfileMenu", () => ({ ProfileMenu: () => null }));
rs.mock("./use-chat-peek", () => ({
  useChatPeek: () => ({ tile: undefined, open: false, onEnter: () => {}, onLeave: () => {} }),
}));
rs.mock("../components/upgrade-countdown-banner", () => ({ UpgradeCountdownBanner: () => null }));
rs.mock("@/hooks/use-settings", () => ({ useSettings: () => ({ data: {} }) }));
rs.mock("@/hooks/use-desktop", () => ({ useDesktop: () => true }));

import { SlotProvider } from "../components/slot";
import { RomeShellLayout } from "./RomeShellLayout";

beforeEach(() => {
  rs.stubGlobal(
    "matchMedia",
    rs.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: rs.fn(),
      removeEventListener: rs.fn(),
    })),
  );
});
afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

function shell() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/chat"]}>
        <SlotProvider>
          <Routes>
            <Route element={<RomeShellLayout />}>
              <Route path="/chat" element={<div>page</div>} />
            </Route>
          </Routes>
        </SlotProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("RomeShellLayout chat search", () => {
  it("opens the search without drawing the sidebar's chat list again", () => {
    shell();
    expect(screen.getAllByTestId("chat-list").length).toBeGreaterThan(0);
    drawn.chatList = 0;

    act(() => screen.getByRole("button", { name: "open search" }).click());

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(drawn.chatList).toBe(0);
  });
});
