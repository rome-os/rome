// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
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
  rs.restoreAllMocks();
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

  it("leaves a tap on a linked picture to the link", () => {
    const { container } = render(
      <Message text="[![Sky](https://example.com/sky.jpg)](https://example.org/target)" />,
    );
    const image = screen.getByRole("img", { name: "Sky" });
    expect(image.closest("a")?.getAttribute("href")).toBe("https://example.org/target");
    expect(image.className).toContain("max-h-72");
    expect(container.querySelector("[data-rmiz]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Preview: Sky" })).toBeNull();
  });

  it("gives a linked asset picture the thumbnail but no viewer", () => {
    const { container } = render(
      <Message text="[![Chart](/projects/demo/chart.png)](https://example.org/target)" />,
    );
    const image = screen.getByRole("img", { name: "Chart" });
    expect(image.closest("a")?.getAttribute("href")).toBe("https://example.org/target");
    expect(new URL((image as HTMLImageElement).src).searchParams.get("w")).toBe("900");
    expect(container.querySelector("[data-rmiz]")).toBeNull();
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

  it("asks the server for a 900 px thumbnail of an asset picture", () => {
    render(<Message text="![Chart](/projects/demo/out/chart%20one.png)" />);
    const source = new URL((screen.getByRole("img", { name: "Chart" }) as HTMLImageElement).src);
    expect(source.pathname).toBe("/api/projects/asset/chart%20one.png");
    expect(source.searchParams.getAll("w")).toEqual(["900"]);
    expect(source.searchParams.get("path")).toBe("projects/demo/out/chart one.png");
    render(<Message text="![Note](/memory/pictures/note.png)" />);
    const memory = new URL((screen.getByRole("img", { name: "Note" }) as HTMLImageElement).src);
    expect([memory.pathname, memory.searchParams.get("w")]).toEqual([
      "/api/memory/asset/note.png",
      "900",
    ]);
  });

  it.each([
    [
      "adds w after an existing query",
      "/api/projects/asset/a.png?path=projects%2Fa.png&v=2",
      "v=2&w=900",
    ],
    [
      "keeps a width already asked for",
      "/api/projects/asset/a.png?path=projects%2Fa.png&w=600",
      "w=600",
    ],
  ])("%s", (_name, src, tail) => {
    render(<Message text={`![A](${src})`} />);
    const image = screen.getByRole("img", { name: "A" });
    expect(image.getAttribute("src")).toBe(
      `/api/projects/asset/a.png?path=projects%2Fa.png&${tail}`,
    );
  });

  it("asks the server for a 900 px thumbnail of a stored picture", () => {
    const src = "/api/assets/0123456789abcdef0123456789abcdef.png";
    render(<Message text={`![Shot](${src})`} />);
    expect(screen.getByRole("img", { name: "Shot" }).getAttribute("src")).toBe(`${src}?w=900`);
  });

  it("plays a stored video and audio file in place, without a thumbnail width", () => {
    const id = "0123456789abcdef0123456789abcdef";
    const { container } = render(
      <Message text={`![Clip](/api/assets/${id}.mp4)\n\n![Song](/api/assets/${id}.mp3)`} />,
    );
    const video = container.querySelector("video") as HTMLVideoElement;
    expect(video.getAttribute("src")).toBe(`/api/assets/${id}.mp4`);
    expect(video.controls).toBe(true);
    expect(video.getAttribute("preload")).toBe("metadata");
    const audio = container.querySelector("audio") as HTMLAudioElement;
    expect(audio.getAttribute("src")).toBe(`/api/assets/${id}.mp3`);
    expect(audio.controls).toBe(true);
    expect(container.querySelector("img")).toBeNull();
  });

  it("keeps the file reachable as a chip when a video or audio file cannot be played", () => {
    const id = "0123456789abcdef0123456789abcdef";
    const { container } = render(
      <Message text={`![Clip](/api/assets/${id}.webm)\n\n![Song](/api/assets/${id}.mp3)`} />,
    );
    fireEvent.error(container.querySelector("video") as HTMLVideoElement);
    fireEvent.error(container.querySelector("audio") as HTMLAudioElement);

    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("audio")).toBeNull();
    const clip = screen.getByText("Clip").closest("a") as HTMLAnchorElement;
    expect(clip.getAttribute("href")).toBe(`/api/assets/${id}.webm`);
    expect(clip.getAttribute("download")).toBe("Clip");
    const song = screen.getByText("Song").closest("a") as HTMLAnchorElement;
    expect(song.getAttribute("href")).toBe(`/api/assets/${id}.mp3`);
  });

  it.each([
    "https://example.com/sky.jpg?w=1",
    "/api/share/token/projects/asset/a.png?path=projects%2Fa.png",
    "/api/projects/assets/a.png?path=projects%2Fa.png",
  ])("leaves %s as it is", (src) => {
    render(<Message text={`![A](${src})`} />);
    expect(screen.getByRole("img", { name: "A" }).getAttribute("src")).toBe(src);
  });

  it("shows the original in the viewer and downloads it before it has loaded", async () => {
    // The thumbnail decodes at once. The original never finishes, so the viewer
    // still shows the thumbnail when Download is tapped.
    HTMLImageElement.prototype.decode = function decode(this: HTMLImageElement) {
      return this.src.includes("w=900") ? Promise.resolve() : new Promise<void>(() => {});
    };
    const click = rs.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<Message text="![Chart](/projects/demo/chart.png)" />);
    const open = await screen.findByRole("button", { name: "Preview: Chart" });
    await act(async () => {
      fireEvent.click(open);
    });
    const modal = document.querySelector<HTMLImageElement>("[data-rmiz-modal-img]")!;
    expect(new URL(modal.src).searchParams.get("w")).toBe("900");
    fireEvent.click(screen.getByRole("button", { name: "Download" }, { hidden: true }));
    const link = click.mock.contexts[0] as HTMLAnchorElement;
    const saved = new URL(link.href);
    expect(saved.pathname).toBe("/api/projects/asset/chart.png");
    expect(saved.searchParams.get("path")).toBe("projects/demo/chart.png");
    expect(saved.searchParams.has("w")).toBe(false);
  });

  it("swaps the viewer to the original once it has loaded", async () => {
    render(<Message text="![Chart](/projects/demo/chart.png)" />);
    const open = await screen.findByRole("button", { name: "Preview: Chart" });
    await act(async () => {
      fireEvent.click(open);
    });
    const modal = () => document.querySelector<HTMLImageElement>("[data-rmiz-modal-img]")!;
    expect(new URL(modal().src).searchParams.get("w")).toBe("900");
    await act(async () => {
      fireEvent.transitionEnd(modal(), { propertyName: "transform" });
    });
    expect(new URL(modal().src).searchParams.has("w")).toBe(false);
  });

  it.each([
    ["a phone", false, 16],
    ["a wide screen", true, 64],
  ])("leaves %s a viewer margin of %s px", async (_name, wide, margin) => {
    const query = (q: string) => ({
      matches: wide && q === "(min-width: 48rem)",
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    rs.spyOn(window, "matchMedia").mockImplementation(query as never);
    rs.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 100,
      bottom: 50,
      width: 100,
      height: 50,
      toJSON: () => ({}),
    });
    render(<Message text="![Chart](/projects/demo/chart.png)" />);
    const open = await screen.findByRole("button", { name: "Preview: Chart" });
    await act(async () => {
      fireEvent.click(open);
    });
    const modal = document.querySelector<HTMLImageElement>("[data-rmiz-modal-img]")!;
    // The open picture fills the window less the margin on both sides.
    expect(Math.round(Number.parseFloat(modal.style.width))).toBe(window.innerWidth - 2 * margin);
  });

  it.each([
    ["a title before it", "**Hanauma Bay**\n![Bay](https://example.com/bay.jpg)", "Hanauma Bay"],
    ["a caption after it", "![Bay](https://example.com/bay.jpg)\nWaikiki", "Waikiki"],
    [
      "a linked picture",
      "Waikiki\n[![Bay](https://example.com/bay.jpg)](https://example.org/x)",
      "Waikiki",
    ],
  ])("puts a picture on its own line when text follows %s in the same paragraph", (_name, text, caption) => {
    const { container } = render(<Message text={text} />);
    const wrapper = container.querySelector<HTMLElement>('[data-streamdown="image-wrapper"]')!;
    // The text and the picture share one paragraph, so only a block-level
    // wrapper keeps the text above or below the picture, not beside it.
    expect(wrapper.closest("p")?.textContent).toContain(caption);
    expect(wrapper.textContent).not.toContain(caption);
    const classes = wrapper.className.split(/\s+/);
    expect(classes).toContain("block");
    expect(classes).not.toContain("inline-block");
    expect(classes).toContain("max-w-full");
  });

  it("keeps a failed picture's fallback on its own line", () => {
    const { container } = render(
      <Message text={"Waikiki\n![Gone](https://example.com/gone.png)"} />,
    );
    fireEvent.error(screen.getByRole("img", { name: "Gone" }));
    const wrapper = container.querySelector('[data-streamdown="image-wrapper"]')!;
    expect(wrapper.className.split(/\s+/)).toContain("block");
    expect(wrapper.querySelector('[data-streamdown="image-fallback"]')).not.toBeNull();
  });
});
