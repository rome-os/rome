// @rstest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import DesktopPage, { applyDesktopSafeAreaBottom, NamedDesktopPage } from "./DesktopPage";

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty("--rome-safe-area-bottom");
});

describe("DesktopPage", () => {
  it("scales the browser desktop to fit the available screen", async () => {
    await i18n.changeLanguage("en");

    render(<DesktopPage />);

    const iframe = screen.getByTitle("Rome Desktop");
    expect(iframe.parentElement?.className).toContain("h-[var(--rome-mobile-content-height)]");
    expect(iframe.getAttribute("src")).toBe(
      "/desktop-vnc.html?resize=scale&path=desktop-proxy/websockify",
    );
    expect(iframe.getAttribute("allow")).toBe("clipboard-read; clipboard-write");

    const setProperty = rs.fn();
    applyDesktopSafeAreaBottom(
      {
        contentDocument: { documentElement: { style: { setProperty } } },
      } as unknown as HTMLIFrameElement,
      "34px",
    );
    expect(setProperty).toHaveBeenCalledWith("--rome-safe-area-bottom", "34px");
  });

  it("shows a named desktop through its own proxy path", async () => {
    await i18n.changeLanguage("en");

    render(<DesktopPage name="wechat" />);

    expect(screen.getByTitle("Rome desktop “wechat”").getAttribute("src")).toBe(
      "/desktop-vnc.html?resize=scale&path=desktop-proxy/wechat/websockify",
    );
  });

  it("serves /desktop/:name for any name", async () => {
    await i18n.changeLanguage("en");

    render(
      <MemoryRouter initialEntries={["/desktop/notes"]}>
        <Routes>
          <Route path="/desktop/:name" element={<NamedDesktopPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTitle("Rome desktop “notes”").getAttribute("src")).toBe(
      "/desktop-vnc.html?resize=scale&path=desktop-proxy/notes/websockify",
    );
  });
});
