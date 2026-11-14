// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import Markdown from "@/components/markdown";
import { ThemeProvider } from "@/hooks/use-theme";
import en from "@/i18n/locales/en/chat.json";
import zh from "@/i18n/locales/zh-CN/chat.json";
import ChatMarkdown from "./ChatMarkdown";
import { ConciergeBubble } from "./ConciergeBubble";

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
  rs.unstubAllGlobals();
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

const GRID = [
  "```pictures grid",
  "![Oʻahu](https://upload.wikimedia.org/a/960px-x.jpg) Waikiki and Diamond Head, good for a first trip",
  "![Maui](/projects/demo/maui.png) Palm trees, beaches and resorts",
  "![Kauaʻi](https://www.example.com/kauai.jpg) Cliffs and waterfalls",
  "![Hawaiʻi](/memory/pictures/hawaii.png)",
  "```",
].join("\n");

const LIST = [
  "```pictures list",
  "![Hanauma Bay](https://example.com/bay.jpg) Calm water and plenty of fish, so start here.",
  "![Diamond Head](/projects/demo/head.png) A short climb with a view over the coast.",
  "```",
].join("\n");

const tiles = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>("[data-picture]"),
];
const frameClasses = (image: Element) => image.className.split(/\s+/);

describe("a pictures block in chat", () => {
  it("lays a grid out in two columns of 4:3 frames, each with a title and a note", () => {
    const { container } = render(<Message text={GRID} />);
    const set = container.querySelector<HTMLElement>("[data-chat-picture-set]")!;
    expect(set.dataset.chatPictureSet).toBe("grid");
    expect(frameClasses(set)).toContain("grid-cols-2");
    expect(container.querySelector("[data-chat-code-block]")).toBeNull();

    const all = tiles(container);
    expect(all).toHaveLength(4);
    for (const tile of all) {
      const classes = frameClasses(tile.querySelector("img")!);
      expect(classes).toContain("aspect-[4/3]");
      expect(classes).toContain("rounded-12");
      expect(classes).toContain("w-full");
    }
    const first = within(all[0]!);
    expect(first.getByText("Oʻahu").className).toContain("text-section");
    const note = first.getByText("Waikiki and Diamond Head, good for a first trip");
    expect(note.className).toContain("line-clamp-2");
    expect(note.className).toContain("text-muted-foreground");
    // A line without a note has a title only.
    expect(all[3]!.querySelectorAll("figcaption > span")).toHaveLength(1);
  });

  it("reads a bare `pictures` fence as a grid", () => {
    const text = "```pictures\n![A](https://example.com/a.jpg) one\n```";
    const { container } = render(<Message text={text} />);
    expect(
      container.querySelector("[data-chat-picture-set]")?.getAttribute("data-chat-picture-set"),
    ).toBe("grid");
  });

  it("gives one picture alone the full width", () => {
    const { container } = render(
      <Message text={"```pictures grid\n![A](https://example.com/a.jpg) one\n```"} />,
    );
    const set = container.querySelector<HTMLElement>("[data-chat-picture-set]")!;
    expect(frameClasses(set)).toContain("grid-cols-1");
    expect(frameClasses(set)).not.toContain("grid-cols-2");
  });

  it("keeps an odd count in two columns", () => {
    const text = GRID.split("\n").slice(0, 4).concat("```").join("\n");
    const { container } = render(<Message text={text} />);
    expect(tiles(container)).toHaveLength(3);
    expect(frameClasses(container.querySelector("[data-chat-picture-set]")!)).toContain(
      "grid-cols-2",
    );
  });

  it("shows the host of an outside picture on its corner, and none on a local one", () => {
    const { container } = render(<Message text={GRID} />);
    const labels = tiles(container).map(
      (tile) => tile.querySelector("[data-picture-source]")?.textContent ?? null,
    );
    expect(labels).toEqual(["upload.wikimedia.org", null, "example.com", null]);
    const label = container.querySelector<HTMLElement>("[data-picture-source]")!;
    // A tap on the label reaches the picture under it.
    expect(label.className).toContain("pointer-events-none");
  });

  it("lays a list out with a fixed-width 3:4 picture beside the title and the note", () => {
    const { container } = render(<Message text={LIST} />);
    const set = container.querySelector<HTMLElement>("[data-chat-picture-set]")!;
    expect(set.dataset.chatPictureSet).toBe("list");
    expect(frameClasses(set)).not.toContain("grid");
    const rows = tiles(container);
    expect(rows).toHaveLength(2);
    const row = rows[0]!;
    expect(frameClasses(row)).toContain("flex");
    const picture = row.querySelector("img")!;
    expect(frameClasses(picture)).toContain("aspect-[3/4]");
    const width = picture.closest("[data-picture] > div")!;
    expect(frameClasses(width)).toEqual(expect.arrayContaining(["w-35", "md:w-45", "shrink-0"]));
    expect(within(row).getByText("Hanauma Bay").className).toContain("text-section");
    // A list note is a whole paragraph, not clamped.
    const note = within(row).getByText("Calm water and plenty of fish, so start here.");
    expect(note.className).not.toContain("line-clamp");
  });

  it("asks for a 600 px thumbnail of an asset picture and leaves an outside one alone", () => {
    const { container } = render(<Message text={GRID} />);
    const sources = tiles(container).map((tile) => tile.querySelector("img")!.getAttribute("src"));
    expect(sources[0]).toBe("https://upload.wikimedia.org/a/960px-x.jpg");
    const maui = new URL(sources[1]!, "http://localhost");
    expect(maui.pathname).toBe("/api/projects/asset/maui.png");
    expect(maui.searchParams.get("path")).toBe("projects/demo/maui.png");
    expect(maui.searchParams.getAll("w")).toEqual(["600"]);
    const hawaii = new URL(sources[3]!, "http://localhost");
    expect([hawaii.pathname, hawaii.searchParams.get("w")]).toEqual([
      "/api/memory/asset/hawaii.png",
      "600",
    ]);
  });

  it("opens the viewer on a tap, and the viewer and Download use the original", async () => {
    // The thumbnail decodes at once. The original never finishes, so the viewer
    // still shows the thumbnail when Download is tapped.
    HTMLImageElement.prototype.decode = function decode(this: HTMLImageElement) {
      return this.src.includes("w=600") ? Promise.resolve() : new Promise<void>(() => {});
    };
    const click = rs.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<Message text={GRID} />);
    const open = await screen.findByRole("button", { name: "Preview: Maui" });
    await act(async () => {
      fireEvent.click(open);
    });
    const modal = () =>
      document.querySelector<HTMLImageElement>("dialog[open] [data-rmiz-modal-img]")!;
    expect(new URL(modal().src).searchParams.get("w")).toBe("600");

    fireEvent.click(screen.getByRole("button", { name: "Download" }, { hidden: true }));
    const saved = new URL((click.mock.contexts[0] as HTMLAnchorElement).href);
    expect(saved.pathname).toBe("/api/projects/asset/maui.png");
    expect(saved.searchParams.get("path")).toBe("projects/demo/maui.png");
    expect(saved.searchParams.has("w")).toBe(false);
  });

  it("swaps the viewer to the original once it has loaded", async () => {
    render(<Message text={GRID} />);
    const open = await screen.findByRole("button", { name: "Preview: Maui" });
    await act(async () => {
      fireEvent.click(open);
    });
    const modal = () =>
      document.querySelector<HTMLImageElement>("dialog[open] [data-rmiz-modal-img]")!;
    expect(new URL(modal().src).searchParams.get("w")).toBe("600");
    await act(async () => {
      fireEvent.transitionEnd(modal(), { propertyName: "transform" });
    });
    expect(new URL(modal().src).searchParams.has("w")).toBe(false);
  });

  it("opens an outside picture in the viewer as it is", async () => {
    render(<Message text={GRID} />);
    const open = await screen.findByRole("button", { name: "Preview: Kauaʻi" });
    await act(async () => {
      fireEvent.click(open);
    });
    expect(
      document.querySelector<HTMLImageElement>("dialog[open] [data-rmiz-modal-img]")!.src,
    ).toBe("https://www.example.com/kauai.jpg");
  });

  it("shows the unavailable text in the frame of a picture that fails, at the same size", () => {
    const { container } = render(<Message text={GRID} />);
    const before = ["aspect-[4/3]", "rounded-12", "w-full"];
    fireEvent.error(screen.getByRole("img", { name: "Maui" }));
    const failed = tiles(container)[1]!;
    const fallback = failed.querySelector<HTMLElement>("[data-picture-fallback]")!;
    expect(fallback.textContent).toBe("Image not available");
    expect(frameClasses(fallback)).toEqual(expect.arrayContaining(before));
    expect(screen.queryByRole("img", { name: "Maui" })).toBeNull();
    // The title and note stay, and the other tiles do not move.
    expect(within(failed).getByText("Maui")).toBeTruthy();
    expect(within(failed).getByText("Palm trees, beaches and resorts")).toBeTruthy();
    expect(tiles(container)).toHaveLength(4);
    expect(screen.getByRole("img", { name: "Oʻahu" })).toBeTruthy();
  });

  it("keeps the fallback the size of a list frame", () => {
    const { container } = render(<Message text={LIST} />);
    fireEvent.error(screen.getByRole("img", { name: "Diamond Head" }));
    const fallback = container.querySelector<HTMLElement>("[data-picture-fallback]")!;
    expect(frameClasses(fallback)).toContain("aspect-[3/4]");
    expect(frameClasses(fallback.parentElement!)).toContain("w-35");
  });

  it.each([
    ["no picture line", "```pictures grid\nnot a picture\nneither is this\n```"],
    [
      "only unsafe addresses",
      [
        "```pictures",
        "![A](javascript:alert(1)) x",
        "![B](data:image/png;base64,AAAA) y",
        "![C](http://example.com/c.jpg) z",
        "```",
      ].join("\n"),
    ],
  ])("stays a code block with %s", (_name, text) => {
    const { container } = render(<Message text={text} />);
    expect(container.querySelector("[data-chat-picture-set]")).toBeNull();
    expect(container.querySelector('[data-chat-code-block="code"]')).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[data-chat-code-block="code"]')?.textContent).toContain(
      "pictures",
    );
  });

  it("drops an unsafe line and keeps the safe ones", () => {
    const text = [
      "```pictures grid",
      "![A](javascript:alert(1)) x",
      "![B](https://example.com/b.jpg) fine",
      "free text",
      "```",
    ].join("\n");
    const { container } = render(<Message text={text} />);
    expect(tiles(container)).toHaveLength(1);
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    expect(container.innerHTML).not.toContain("javascript:");
  });

  it("leaves a half-written last line out while the fence is open", () => {
    const open = [
      "```pictures grid",
      "![A](https://example.com/a.jpg) first",
      "![B](https://example.com/b.jpg) sec",
    ].join("\n");
    const { container, rerender } = render(<Message text={open} />);
    expect(tiles(container)).toHaveLength(1);
    expect(screen.queryByRole("img", { name: "B" })).toBeNull();

    // The newline ends the line, so it counts.
    rerender(<Message text={`${open}ond\n`} />);
    expect(tiles(container)).toHaveLength(2);
    expect(screen.getByText("second")).toBeTruthy();
  });

  it("shows no broken picture for a half-written address", () => {
    const text =
      "```pictures grid\n![A](https://example.com/a.jpg) first\n![B](https://example.com/b.j";
    const { container } = render(<Message text={text} />);
    expect(container.querySelectorAll("img")).toHaveLength(1);
  });

  it("keeps a tile's image while the fence grows, so an open viewer stays mounted", async () => {
    const head = "```pictures grid\n![A](https://example.com/a.jpg) first\n";
    const { rerender } = render(<Message text={`${head}![B](https://example.com/b.jpg) two\n`} />);
    const open = await screen.findByRole("button", { name: "Preview: A" });
    await act(async () => {
      fireEvent.click(open);
    });
    const before = screen.getByRole("img", { name: "A" }, { hidden: true });
    const modal = document.querySelector("[data-rmiz-modal-img]");
    expect(modal).not.toBeNull();

    rerender(
      <Message
        text={`${head}![B](https://example.com/b.jpg) two\n![C](https://example.com/c.jpg) three\n`}
      />,
    );
    expect(screen.getByRole("img", { name: "A" }, { hidden: true })).toBe(before);
    expect(document.querySelector("[data-rmiz-modal-img]")).toBe(modal);
    expect(screen.getByRole("img", { name: "C" }, { hidden: true })).toBeTruthy();
  });

  it("shows the block as a picture set once the first line is complete", () => {
    const { container, rerender } = render(
      <Message text={"```pictures grid\n![A](https://example.com/a.jpg) fi"} />,
    );
    expect(container.querySelector("[data-chat-picture-set]")).toBeNull();
    rerender(<Message text={"```pictures grid\n![A](https://example.com/a.jpg) first\n"} />);
    expect(container.querySelector("[data-chat-picture-set]")).not.toBeNull();
  });
});

describe("a pictures block outside chat", () => {
  it("stays a code block in plain Markdown", () => {
    const { container } = render(<Message chat={false} text={GRID} />);
    expect(container.querySelector("[data-chat-picture-set]")).toBeNull();
    expect(container.querySelector("[data-picture]")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("![Maui](/projects/demo/maui.png)");
  });
});

describe("a pictures block in a Concierge bubble", () => {
  function Bubble() {
    return (
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <MemoryRouter>
            <ConciergeBubble
              side="start"
              copyText="copy"
              createdAt="2026-10-28T12:00:00.000Z"
              feedbackTurn={null}
            >
              <ChatMarkdown>{GRID}</ChatMarkdown>
            </ConciergeBubble>
          </MemoryRouter>
        </ThemeProvider>
      </I18nextProvider>
    );
  }

  it("does not toggle the bubble's details when a tile is tapped", async () => {
    rs.stubGlobal(
      "matchMedia",
      rs.fn((query: string) => ({
        matches: query === "(hover: none)",
        media: query,
        addEventListener: rs.fn(),
        removeEventListener: rs.fn(),
      })),
    );
    const { container } = render(<Bubble />);
    const details = screen.getByRole("button", { name: /details/i, hidden: true });
    expect(details.getAttribute("aria-expanded")).toBe("false");

    const zoom = container.querySelector<HTMLElement>("[data-picture] [data-rmiz]")!;
    await act(async () => {
      fireEvent.click(zoom.querySelector("img")!);
    });
    expect(details.getAttribute("aria-expanded")).toBe("false");

    // A tap on the caption beside it is the bubble's, as on any text.
    await act(async () => {
      fireEvent.click(screen.getByText("Waikiki and Diamond Head, good for a first trip"));
    });
    expect(details.getAttribute("aria-expanded")).toBe("true");
  });
});
