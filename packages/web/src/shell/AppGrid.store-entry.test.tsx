// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import { AppGrid, STORAGE_KEY } from "./AppGrid";

// The sidebar's data hooks are not what this file is about, and each one would
// otherwise need its own fetch fixture. Every value is built once in the factory
// rather than per call: the installed-apps effect keys on the array identity, so
// a fresh literal per render re-runs it forever.
rs.mock("@/hooks/use-apps", () => {
  const apps: never[] = [];
  const invalidators = { list: async () => {}, updates: async () => {} };
  return { useApps: () => ({ apps }), useInvalidateApps: () => invalidators };
});
rs.mock("@/hooks/use-settings", () => {
  const settings = { data: undefined };
  const invalidate = async () => {};
  return { useSettings: () => settings, useInvalidateSettings: () => invalidate };
});
rs.mock("@/hooks/use-new-apps", () => {
  const newApps = { newAppIds: new Set<string>(), markAppsSeen: () => {} };
  return { useNewApps: () => newApps };
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([{ type: "builtin", id: "store" }]));
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete window.rome;
});

/** What `isElectronShell` reads: the desktop preload's bridge, absent in a browser. */
function asDesktopApp() {
  window.rome = {};
}

function renderSidebar(collapsed: boolean) {
  return render(
    <MemoryRouter>
      <AppGrid collapsed={collapsed} />
    </MemoryRouter>,
  );
}

const LAYOUTS: [string, boolean][] = [
  ["expanded sidebar", false],
  ["collapsed rail", true],
];

describe.each(LAYOUTS)("App Store entry in the %s", (_name, collapsed) => {
  // The Electron shell hands every new-window request to the system browser, so
  // an anchor here means Safari — outside the user's Rome session.
  it("opens the embedded sheet inside the Mac app", async () => {
    asDesktopApp();
    renderSidebar(collapsed);

    expect(screen.queryByRole("link", { name: "App Store" })).toBeNull();
    expect(screen.queryByTitle("App store")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "App Store" }));

    const frame = await screen.findByTitle("App store");
    expect(frame.tagName).toBe("IFRAME");
  });

  // A browser has tabs, and a new tab is the better answer there. Unchanged.
  it("stays an external link in a browser", () => {
    renderSidebar(collapsed);

    const link = screen.getByRole("link", { name: "App Store" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("href")).toContain("/store");
    expect(screen.queryByRole("button", { name: "App Store" })).toBeNull();
  });
});
