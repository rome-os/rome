// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import "@/i18n";
import * as conciergeModule from "@/hooks/use-concierge" with { rstest: "importActual" };

// The main chat's load, which each test sets.
const main = rs.hoisted(() => ({ loading: true, failed: false }));
rs.mock("@/hooks/use-concierge", () => ({
  ...conciergeModule,
  useConciergeChat: () => ({
    chatId: main.loading || main.failed ? null : "concierge",
    loading: main.loading,
    failed: main.failed,
    retry: () => {},
  }),
}));
rs.mock("./RecentChats", () => ({ RecentChats: () => null }));
rs.mock("./AppGrid", () => ({ AppGrid: () => null }));
rs.mock("./DesktopTitlebar", () => ({ DesktopTitlebar: () => null }));
rs.mock("./ProfileMenu", () => ({ ProfileMenu: () => null }));
rs.mock("./use-chat-peek", () => ({
  useChatPeek: () => ({ tile: undefined, open: false, onEnter: () => {}, onLeave: () => {} }),
}));
rs.mock("../components/upgrade-countdown-banner", () => ({ UpgradeCountdownBanner: () => null }));
rs.mock("./UpgradeIndicator", () => ({ UpgradeIndicator: () => null }));
rs.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({ data: {} }),
  useInvalidateSettings: () => () => Promise.resolve(),
}));
rs.mock("@/hooks/use-desktop", () => ({ useDesktop: () => false }));

import { SlotOutlet, SlotProvider } from "../components/slot";
import { CONCIERGE_LEADING_SLOT } from "@/components/concierge/ConciergeHeaderStatus";
import { RomeShellLayout } from "./RomeShellLayout";

beforeEach(() => {
  main.loading = true;
  main.failed = false;
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

/** The main chat's page: it floats its header, which claims the leading slot, unless `covered`. */
function MainChat({ mounted, covered }: { mounted: boolean; covered: boolean }) {
  return mounted && !covered ? <SlotOutlet name={CONCIERGE_LEADING_SLOT} /> : <div>page</div>;
}

function shell(page: { mounted: boolean; covered: boolean }) {
  const tree = (state: { mounted: boolean; covered: boolean }) => (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/message"]}>
        <SlotProvider>
          <Routes>
            <Route element={<RomeShellLayout />}>
              <Route path="/message" element={<MainChat {...state} />} />
            </Route>
          </Routes>
        </SlotProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree(page));
  return {
    bar: () => view.container.querySelector("[data-mobile-header]"),
    rerender: (state: { mounted: boolean; covered: boolean }) =>
      act(() => view.rerender(tree(state))),
  };
}

describe("RomeShellLayout on the main chat", () => {
  it("shows no phone bar while the main chat loads, nor once it floats its header", () => {
    const view = shell({ mounted: false, covered: false });
    expect(view.bar()).toBeNull();

    main.loading = false;
    view.rerender({ mounted: false, covered: false });
    expect(view.bar()).toBeNull();

    view.rerender({ mounted: true, covered: false });
    expect(view.bar()).toBeNull();
  });

  it("gives the bar back while a tool pane covers the chat, and takes it again after", () => {
    main.loading = false;
    const view = shell({ mounted: true, covered: false });
    expect(view.bar()).toBeNull();

    view.rerender({ mounted: true, covered: true });
    expect(view.bar()).not.toBeNull();

    view.rerender({ mounted: true, covered: false });
    expect(view.bar()).toBeNull();
  });

  it("keeps the bar on a main chat that failed to load", () => {
    main.loading = false;
    main.failed = true;
    const view = shell({ mounted: false, covered: false });
    expect(view.bar()).not.toBeNull();
  });
});
