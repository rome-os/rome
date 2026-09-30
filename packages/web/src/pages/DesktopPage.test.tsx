// @rstest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import DesktopPage, { applyDesktopSafeAreaBottom, NamedDesktopPage } from "./DesktopPage";

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
    expect(iframe.parentElement?.className).toContain("h-[var(--rome-mobile-content-height)]");
    expect(iframe.getAttribute("src")).toMatch(/^\/desktop-vnc\.html\?resize=scale&path=/);
    expect(socketPath(iframe)).toBe("desktop-proxy/websockify");
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

    expect(socketPath(screen.getByTitle("Rome desktop “wechat”"))).toBe(
      "desktop-proxy/wechat/websockify",
    );
  });

  it("keeps a name whole on its way to the proxy", async () => {
    await i18n.changeLanguage("en");

    render(<DesktopPage name="a?b#c" />);

    // desktop-vnc.html decodes the query once. The name must still be encoded
    // then, so `?` and `#` cannot cut the socket path short.
    expect(socketPath(screen.getByTitle("Rome desktop “a?b#c”"))).toBe(
      "desktop-proxy/a%3Fb%23c/websockify",
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

    expect(socketPath(screen.getByTitle("Rome desktop “notes”"))).toBe(
      "desktop-proxy/notes/websockify",
    );
  });

  it.each([
    "/desktop/websockify",
    "/desktop/%3F",
    "/desktop/%23",
    "/desktop/Wechat",
  ])("shows no desktop at %s, a path that cannot name one", async (path) => {
    await i18n.changeLanguage("en");

    const { container } = render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/desktop/:name" element={<NamedDesktopPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByText(/There is no desktop called/)).toBeTruthy();
  });
});
