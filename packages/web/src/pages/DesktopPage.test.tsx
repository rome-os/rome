// @rstest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import DesktopPage, { applyDesktopSafeAreaBottom } from "./DesktopPage";

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

    const setProperty = rs.fn();
    applyDesktopSafeAreaBottom(
      {
        contentDocument: { documentElement: { style: { setProperty } } },
      } as unknown as HTMLIFrameElement,
      "34px",
    );
    expect(setProperty).toHaveBeenCalledWith("--rome-safe-area-bottom", "34px");
  });
});
