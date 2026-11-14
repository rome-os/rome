// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { LAST_CHAT_KEY, MODE_KEY, seedChatListMode } from "@/test/chat-list-mode";
import "@/i18n";
import * as conciergeModule from "@/hooks/use-concierge" with { rstest: "importActual" };

const main = rs.hoisted(() => ({ failed: false }));
rs.mock("@/hooks/use-concierge", () => ({
  ...conciergeModule,
  useConciergeChat: () => ({
    chatId: main.failed ? null : "concierge",
    loading: false,
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
rs.mock("@/hooks/use-desktop", () => ({ useDesktop: () => true }));

import { SlotProvider } from "../components/slot";
import { RomeShellLayout } from "./RomeShellLayout";

beforeEach(() => {
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
  localStorage.clear();
  seedChatListMode();
});

function Where() {
  const location = useLocation();
  return (
    <output data-testid="where">
      {location.pathname}
      {location.search} {JSON.stringify(location.state)}
    </output>
  );
}

function openNewChat(entry: string) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <SlotProvider>
          <Routes>
            <Route element={<RomeShellLayout />}>
              <Route path="*" element={<Where />} />
            </Route>
          </Routes>
        </SlotProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.keyDown(window, { key: "O", ctrlKey: true, shiftKey: true });
  return screen.getByTestId("where").textContent;
}

describe("Ctrl+Shift+O", () => {
  it("opens a blank ordinary chat in Chat mode", () => {
    seedChatListMode({ mode: "chat" });
    expect(openNewChat("/chat/mine")).toBe("/chat null");
  });

  it("opens a blank topic chat in Concierge mode", () => {
    seedChatListMode({ mode: "concierge" });
    expect(openNewChat("/message")).toBe('/chat {"conciergeTopic":true}');
  });

  it("opens a blank ordinary chat on a device that has not shown a mode, as before the switch", () => {
    expect(openNewChat("/chat/unlisted")).toBe("/chat null");
  });

  it("opens a blank ordinary chat when the Concierge is unavailable, whatever mode was stored", () => {
    main.failed = true;
    seedChatListMode({ mode: "concierge" });
    expect(openNewChat("/chat/mine")).toBe("/chat null");
  });

  it("keeps the sidebar hidden where the page hid it", () => {
    seedChatListMode({ mode: "chat" });
    expect(openNewChat("/chat/mine?hideSidebar=1")).toBe("/chat?hideSidebar=1 null");
  });
});
