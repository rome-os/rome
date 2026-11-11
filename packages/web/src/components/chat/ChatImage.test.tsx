// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import Markdown from "@/components/markdown";
import { ThemeProvider } from "@/hooks/use-theme";
import en from "@/i18n/locales/en/chat.json";
import zh from "@/i18n/locales/zh-CN/chat.json";
import ChatMarkdown from "./ChatMarkdown";

const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { chat: en }, "zh-CN": { chat: zh } } });

// jsdom never loads an image and has no modal dialog, and the viewer only
// opens for a loaded image.
const imageProps = ["complete", "naturalHeight", "naturalWidth"] as const;
const loaded = { complete: true, naturalHeight: 100, naturalWidth: 200 };
beforeEach(() => {
  for (const name of imageProps) {
    Object.defineProperty(HTMLImageElement.prototype, name, {
      configurable: true,
      get: () => loaded[name],
    });
  }
  Object.defineProperty(HTMLImageElement.prototype, "currentSrc", {
    configurable: true,
    get(this: HTMLImageElement) {
      return this.src;
    },
  });
  HTMLImageElement.prototype.decode = () => Promise.resolve();
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute("open");
  };
});

afterEach(() => {
  cleanup();
  for (const name of [...imageProps, "currentSrc"]) {
    delete (HTMLImageElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

function Message({ text, chat = true }: { text: string; chat?: boolean }) {
  const MarkdownComponent = chat ? ChatMarkdown : Markdown;
  return (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <MemoryRouter>
          <MarkdownComponent>{text}</MarkdownComponent>
        </MemoryRouter>
      </ThemeProvider>
    </I18nextProvider>
  );
}

describe("ChatImage", () => {
  it("renders a reply picture in a capped image with Streamdown's hooks", () => {
    const { container } = render(<Message text="![Sky](https://example.com/sky.jpg)" />);
    const image = screen.getByRole("img", { name: "Sky" }) as HTMLImageElement;
    expect(image.getAttribute("src")).toBe("https://example.com/sky.jpg");
    expect(image.dataset.streamdown).toBe("image");
    expect(image.className).toContain("max-h-72");
    expect(image.className).toContain("max-w-full");
    expect(container.querySelector('[data-streamdown="image-wrapper"] [data-rmiz]')).not.toBeNull();
  });

  it("maps a project file to the asset route", () => {
    render(<Message text="![Chart](/projects/demo/out/chart%20one.png)" />);
    const source = new URL((screen.getByRole("img", { name: "Chart" }) as HTMLImageElement).src);
    expect(source.pathname).toBe("/api/projects/asset/chart%20one.png");
    expect(source.searchParams.get("path")).toBe("projects/demo/out/chart one.png");
  });

  it("keeps lazy and async attributes from the renderer", () => {
    render(<Message text="![Sky](https://example.com/sky.jpg)" />);
    const image = screen.getByRole("img", { name: "Sky" });
    expect(image.getAttribute("loading")).toBe("lazy");
    expect(image.getAttribute("decoding")).toBe("async");
  });

  it("opens the viewer, which offers a download", async () => {
    render(<Message text="![Sky](https://example.com/sky.jpg)" />);
    const open = await screen.findByRole("button", { name: "Preview: Sky" });
    await act(async () => {
      fireEvent.click(open);
    });
    expect(screen.getByRole("button", { name: "Download" }, { hidden: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Zoom in" }, { hidden: true })).toBeTruthy();
  });

  it("shows text instead of a broken icon when the picture fails to load", () => {
    render(<Message text="![Gone](https://example.com/missing.png)" />);
    fireEvent.error(screen.getByRole("img", { name: "Gone" }));
    expect(screen.getByText("Image not available")).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Gone" })).toBeNull();
  });

  it("keeps the default Streamdown image outside chat", () => {
    const { container } = render(
      <Message chat={false} text="![Sky](https://example.com/sky.jpg)" />,
    );
    expect(container.querySelector("[data-rmiz]")).toBeNull();
    expect(container.querySelector('img[data-streamdown="image"]')).not.toBeNull();
  });

  it("keeps the same image element while the message grows", () => {
    const view = render(<Message text="![Sky](https://example.com/sky.jpg)" />);
    const before = screen.getByRole("img", { name: "Sky" });
    view.rerender(<Message text={"![Sky](https://example.com/sky.jpg)\n\nMore text"} />);
    expect(screen.getByRole("img", { name: "Sky" })).toBe(before);
  });
});
