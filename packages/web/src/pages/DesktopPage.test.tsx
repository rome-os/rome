// @rstest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import i18n from "@/i18n";
import DesktopPage from "./DesktopPage";

/** The websocket path `desktop-vnc.html` reads from an iframe's src. */
function socketPath(iframe: HTMLElement): string | null {
  return new URL(iframe.getAttribute("src")!, "http://rome.local").searchParams.get("path");
}

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty("--rome-safe-area-bottom");
});

describe("DesktopPage", () => {
  it("scales the browser desktop to fit the available screen", async () => {
    await i18n.changeLanguage("en");

    render(<DesktopPage />);

    const iframe = screen.getByTitle("Rome Desktop");
    expect(iframe.getAttribute("src")).toMatch(/^\/desktop-vnc\.html\?resize=scale&path=/);
    expect(socketPath(iframe)).toBe("desktop-proxy/websockify");
    expect(iframe.getAttribute("allow")).toBe("clipboard-read; clipboard-write");
  });
});
