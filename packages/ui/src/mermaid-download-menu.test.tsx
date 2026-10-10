// @rstest-environment jsdom

import { afterEach, describe, expect, it } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef, useState } from "react";
import { MermaidDownloadMenuLayer } from "./mermaid-download-menu.js";

function Fixture({
  onDownload,
  disabledFormats = [],
}: {
  onDownload: (format: string) => void;
  disabledFormats?: string[];
}) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const sourceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const closeOutside = (event: MouseEvent) => {
      if (sourceRef.current && !event.composedPath().includes(sourceRef.current)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, []);
  return (
    <div ref={setRoot} data-testid="root">
      <div data-streamdown="mermaid-block-actions">
        <div ref={sourceRef}>
          <button type="button" onClick={() => setOpen((value) => !value)}>
            Download diagram
          </button>
          {open ? (
            <div data-testid="source-menu">
              {[
                ["svg", "SVG"],
                ["png", "PNG"],
                ["mmd", "MMD"],
              ].map(([format, label]) => (
                <button
                  aria-label={`Download diagram as ${label}`}
                  disabled={disabledFormats.includes(format)}
                  key={format}
                  onClick={() => {
                    onDownload(format);
                    setOpen(false);
                  }}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <button type="button">Copy</button>
      </div>
      <MermaidDownloadMenuLayer root={root} />
    </div>
  );
}

afterEach(cleanup);

describe("Mermaid download menu layer", () => {
  it("focuses the first enabled format inside an app Shadow DOM", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const container = document.createElement("div");
    shadow.append(container);
    try {
      render(<Fixture disabledFormats={["svg"]} onDownload={() => {}} />, { container });
      const trigger = within(container).getByRole("button", { name: "Download diagram" });
      trigger.focus();
      fireEvent.click(trigger);

      await waitFor(() => {
        expect(shadow.activeElement?.getAttribute("aria-label")).toBe("Download diagram as PNG");
      });
      fireEvent.keyDown(shadow.activeElement!, { key: "ArrowDown" });
      expect(shadow.activeElement?.getAttribute("aria-label")).toBe("Download diagram as MMD");
      fireEvent.keyDown(shadow.activeElement!, { key: "Escape" });
      await waitFor(() => expect(shadow.querySelector('[role="menu"]')).toBeNull());
      expect(shadow.activeElement).toBe(trigger);
    } finally {
      host.remove();
    }
  });

  it.each(["{Enter}", " "])("supports a keyboard-only download opened with %s", async (key) => {
    const user = userEvent.setup();
    const downloads: string[] = [];
    render(<Fixture onDownload={(format) => downloads.push(format)} />);
    const trigger = screen.getByRole("button", { name: "Download diagram" });

    await user.tab();
    expect(document.activeElement).toBe(trigger);
    await user.keyboard(key);
    const svg = await screen.findByRole("menuitem", { name: "Download diagram as SVG" });
    await waitFor(() => expect(document.activeElement).toBe(svg));

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "Download diagram as PNG" }),
    );
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "Download diagram as MMD" }),
    );
    await user.keyboard(key);

    expect(downloads).toEqual(["mmd"]);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("skips disabled formats and supports arrow, Home, and End navigation", async () => {
    const user = userEvent.setup();
    render(<Fixture disabledFormats={["svg"]} onDownload={() => {}} />);
    await user.tab();
    await user.keyboard("{Enter}");
    const png = await screen.findByRole("menuitem", { name: "Download diagram as PNG" });
    const mmd = screen.getByRole("menuitem", { name: "Download diagram as MMD" });
    await waitFor(() => expect(document.activeElement).toBe(png));

    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(mmd);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(png);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(mmd);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(png);
  });

  it.each(["{Escape}", "{Tab}"])("closes with %s and restores trigger focus", async (key) => {
    const user = userEvent.setup();
    render(<Fixture onDownload={() => {}} />);
    const trigger = screen.getByRole("button", { name: "Download diagram" });
    await user.tab();
    await user.keyboard("{Enter}");
    const svg = await screen.findByRole("menuitem", { name: "Download diagram as SVG" });
    await waitFor(() => expect(document.activeElement).toBe(svg));

    await user.keyboard(key);

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("moves every format into a portal and delegates the selected download", async () => {
    const downloads: string[] = [];
    render(<Fixture onDownload={(format) => downloads.push(format)} />);

    fireEvent.click(screen.getByRole("button", { name: "Download diagram" }));
    const item = await screen.findByRole("menuitem", { name: "Download diagram as MMD" });
    const root = screen.getByTestId("root");

    expect(root.contains(item)).toBe(false);
    expect(screen.getByTestId("source-menu").style.display).toBe("none");
    fireEvent.mouseDown(item);
    fireEvent.click(item);

    expect(downloads).toEqual(["mmd"]);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("preserves focus on an outside control when a pointer click dismisses the menu", async () => {
    const user = userEvent.setup();
    render(<Fixture onDownload={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Download diagram" }));
    await screen.findByRole("menu");
    const copy = screen.getByRole("button", { name: "Copy" });

    await user.click(copy);

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(copy);
  });

  it("restores focus to the download trigger when Escape closes the menu", async () => {
    render(<Fixture onDownload={() => {}} />);
    const trigger = screen.getByRole("button", { name: "Download diagram" });
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu");

    fireEvent.keyDown(menu, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});
