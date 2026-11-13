// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@/hooks/use-theme";
import en from "@/i18n/locales/en/chat.json";
import zh from "@/i18n/locales/zh-CN/chat.json";
import ChatMarkdown from "./ChatMarkdown";
import { ConciergeBubble } from "./ConciergeBubble";
import { ImagePreviewContent } from "./composer/ImagePreviewContent";

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

function Messages({ texts }: { texts: string[] }) {
  return (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <MemoryRouter>
          {texts.map((text) => (
            <ChatMarkdown key={text}>{text}</ChatMarkdown>
          ))}
        </MemoryRouter>
      </ThemeProvider>
    </I18nextProvider>
  );
}

const MIXED = [
  "![One](/projects/demo/a.png)",
  "```pictures",
  "![Two](https://example.com/b.jpg) note",
  "![Three](https://example.com/c.jpg)",
  "```",
  "![Four](https://example.com/d.jpg)",
].join("\n\n");

/** Opens the viewer from the picture named `name` and finishes the open animation. */
async function openFrom(name: string) {
  const open = await screen.findByRole("button", { name: `Preview: ${name}` });
  await act(async () => {
    fireEvent.click(open);
  });
  const modal = () => document.querySelector<HTMLImageElement>("[data-rmiz-modal-img]");
  const opened = Array.from(
    document.querySelectorAll<HTMLImageElement>("[data-rmiz-modal-img]"),
  ).find((el) => el.closest("dialog[open]"))!;
  await act(async () => {
    fireEvent.transitionEnd(opened, { propertyName: "transform" });
  });
  return { modal, opened };
}

const dialog = () => document.querySelector<HTMLElement>("dialog[open]")!;
const counter = () => dialog().querySelector("output[aria-live]")?.textContent;
/** The open viewer, where keys go. */
const viewport = () => dialog().querySelector<HTMLElement>("[data-preview-state]")!;
const button = (name: string) =>
  within(dialog()).getByRole("button", { name }, { hidden: true }) as HTMLButtonElement;
/** What the open viewer shows now: its current image's address, ignoring `w=`. */
const shown = () => {
  const image = dialog().querySelector<HTMLImageElement>("img[data-preview-current]")!;
  return decodeURIComponent(new URL(image.src).pathname + new URL(image.src).search);
};

describe("paging a reply's pictures in the viewer", () => {
  it("pages in document order across single pictures and a picture set", async () => {
    render(<Messages texts={[MIXED]} />);
    await openFrom("One");
    expect(counter()).toBe("1 / 4");
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        fireEvent.click(button("Next picture"));
      });
      seen.push(shown());
    }
    expect(seen).toEqual(["/b.jpg", "/c.jpg", "/d.jpg"]);
    expect(counter()).toBe("4 / 4");
  });

  it("starts at the picture that was tapped", async () => {
    render(<Messages texts={[MIXED]} />);
    await openFrom("Three");
    expect(counter()).toBe("3 / 4");
    expect(button("Previous picture").disabled).toBe(false);
    expect(button("Next picture").disabled).toBe(false);
  });

  it("stops at the first and the last picture", async () => {
    render(<Messages texts={[MIXED]} />);
    await openFrom("One");
    expect(button("Previous picture").disabled).toBe(true);
    await act(async () => {
      fireEvent.keyDown(viewport(), { key: "ArrowLeft" });
    });
    expect(counter()).toBe("1 / 4");
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        fireEvent.keyDown(viewport(), { key: "ArrowRight" });
      });
    }
    expect(counter()).toBe("4 / 4");
    expect(button("Next picture").disabled).toBe(true);
    await act(async () => {
      fireEvent.keyDown(viewport(), { key: "ArrowLeft" });
    });
    expect(counter()).toBe("3 / 4");
  });

  it("pages with a sideways swipe on touch, not with a mouse drag or a short move", async () => {
    render(<Messages texts={[MIXED]} />);
    const { opened } = await openFrom("Two");
    const swipe = async (dx: number, dy: number, pointerType: string) => {
      await act(async () => {
        fireEvent.pointerDown(opened, { pointerId: 1, pointerType, clientX: 200, clientY: 300 });
        fireEvent.pointerUp(opened, {
          pointerId: 1,
          pointerType,
          clientX: 200 + dx,
          clientY: 300 + dy,
        });
      });
    };
    await swipe(-30, 0, "touch");
    await swipe(-120, 150, "touch");
    await swipe(-120, 0, "mouse");
    expect(counter()).toBe("2 / 4");
    await swipe(-120, 10, "touch");
    expect(counter()).toBe("3 / 4");
    await swipe(120, 10, "touch");
    expect(counter()).toBe("2 / 4");
  });

  it("does not swipe while zoomed in", async () => {
    render(<Messages texts={[MIXED]} />);
    const { opened } = await openFrom("Two");
    await act(async () => {
      fireEvent.click(button("Zoom in"));
    });
    await act(async () => {
      fireEvent.pointerDown(opened, {
        pointerId: 1,
        pointerType: "touch",
        clientX: 200,
        clientY: 300,
      });
      fireEvent.pointerUp(opened, {
        pointerId: 1,
        pointerType: "touch",
        clientX: 40,
        clientY: 300,
      });
    });
    expect(counter()).toBe("2 / 4");
  });

  it("resets zoom on a page change", async () => {
    render(<Messages texts={[MIXED]} />);
    await openFrom("One");
    await act(async () => {
      fireEvent.click(button("Zoom in"));
    });
    expect(within(dialog()).getByLabelText("Zoom").textContent).toBe("125%");
    await act(async () => {
      fireEvent.click(button("Next picture"));
    });
    expect(within(dialog()).getByLabelText("Zoom").textContent).toBe("100%");
  });

  it("shows no controls for a single picture", async () => {
    render(<Messages texts={["![Solo](https://example.com/a.jpg)"]} />);
    await openFrom("Solo");
    expect(dialog().querySelector("output[aria-live]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Next picture" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Previous picture" })).toBeNull();
  });

  it("leaves out a linked picture and a picture that failed to load", async () => {
    render(
      <Messages
        texts={[
          [
            "![A](https://example.com/a.jpg)",
            "[![Linked](https://example.com/l.jpg)](https://example.org/x)",
            "![Gone](https://example.com/gone.jpg)",
            "![B](https://example.com/b.jpg)",
          ].join("\n\n"),
        ]}
      />,
    );
    fireEvent.error(screen.getByRole("img", { name: "Gone" }));
    await openFrom("A");
    expect(counter()).toBe("1 / 2");
    await act(async () => {
      fireEvent.click(button("Next picture"));
    });
    expect(shown()).toBe("/b.jpg");
  });

  it("keeps the pictures of another message out of the set", async () => {
    render(
      <Messages
        texts={[
          "![A1](https://example.com/a1.jpg)\n\n![A2](https://example.com/a2.jpg)",
          "![B1](https://example.com/b1.jpg)\n\n![B2](https://example.com/b2.jpg)\n\n![B3](https://example.com/b3.jpg)",
        ]}
      />,
    );
    await openFrom("A1");
    expect(counter()).toBe("1 / 2");
    await act(async () => {
      fireEvent.click(button("Next picture"));
    });
    expect(shown()).toBe("/a2.jpg");
  });

  it("downloads the original of the picture shown, even after a page change", async () => {
    const click = rs.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<Messages texts={["![A](/projects/demo/a.png)\n\n![B](/projects/demo/b.png)"]} />);
    await openFrom("A");
    await act(async () => {
      fireEvent.click(button("Next picture"));
    });
    // The page shows the original, never a `w=` thumbnail.
    expect(
      new URL(
        dialog().querySelector<HTMLImageElement>("img[data-preview-current]")!.src,
      ).searchParams.has("w"),
    ).toBe(false);
    fireEvent.click(button("Download"));
    const link = click.mock.contexts.at(-1) as HTMLAnchorElement;
    const saved = new URL(link.href);
    expect(saved.pathname).toBe("/api/projects/asset/b.png");
    expect(saved.searchParams.get("path")).toBe("projects/demo/b.png");
    expect(saved.searchParams.has("w")).toBe(false);
  });

  it("closes a paged viewer by fading the page, not by returning to a thumbnail", async () => {
    render(<Messages texts={[MIXED]} />);
    const { opened } = await openFrom("One");
    await act(async () => {
      fireEvent.click(button("Next picture"));
    });
    // The picture the viewer grew from stays in place, hidden.
    expect(opened.style.visibility).toBe("hidden");
    await act(async () => {
      fireEvent.click(button("Close"));
    });
    expect(dialog().querySelector("[data-preview-state]")?.getAttribute("data-preview-state")).toBe(
      "UNLOADING",
    );
    expect(dialog().querySelector("img[data-preview-current]")?.className).toContain("opacity-0");
    await act(async () => {
      fireEvent.transitionEnd(opened, { propertyName: "transform" });
    });
    expect(document.querySelector("dialog[open]")).toBeNull();
  });

  it("brings the opened picture back, with its return animation, when paged home", async () => {
    render(<Messages texts={[MIXED]} />);
    const { opened } = await openFrom("One");
    await act(async () => {
      fireEvent.click(button("Next picture"));
    });
    await act(async () => {
      fireEvent.click(button("Previous picture"));
    });
    expect(opened.style.visibility).not.toBe("hidden");
    expect(counter()).toBe("1 / 4");
  });
});

describe("the composer's viewer", () => {
  const preview = (props: Record<string, unknown> = {}) => (
    <I18nextProvider i18n={i18n}>
      <ImagePreviewContent
        img={<img src="blob:test" alt="Test image" />}
        modalState="LOADED"
        onUnzoom={() => {}}
        buttonUnzoom={<button type="button">Unused library control</button>}
        isZoomImgLoaded
        {...props}
      />
    </I18nextProvider>
  );

  it("never pages, whatever it is given", async () => {
    render(
      preview({
        pictures: () => ({
          pictures: [
            { src: "a", alt: "" },
            { src: "b", alt: "" },
          ],
          index: 0,
        }),
      }),
    );
    expect(screen.queryByRole("button", { name: "Next picture" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
  });
});

describe("the viewer in a Concierge bubble", () => {
  it("does not toggle the bubble's details when its controls or its page are tapped", async () => {
    rs.stubGlobal(
      "matchMedia",
      rs.fn((query: string) => ({
        matches: query === "(hover: none)",
        media: query,
        addEventListener: rs.fn(),
        removeEventListener: rs.fn(),
      })),
    );
    render(
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <MemoryRouter>
            <ConciergeBubble
              side="start"
              copyText="copy"
              createdAt="2026-10-28T12:00:00.000Z"
              feedbackTurn={null}
            >
              <ChatMarkdown>
                {"![A](https://example.com/a.jpg)\n\n![B](https://example.com/b.jpg)"}
              </ChatMarkdown>
            </ConciergeBubble>
          </MemoryRouter>
        </ThemeProvider>
      </I18nextProvider>,
    );
    const details = screen.getByRole("button", { name: /details/i, hidden: true });
    await openFrom("A");
    for (const target of [
      () => button("Next picture"),
      () => button("Previous picture"),
      () => dialog().querySelector("output[aria-live]")!,
      () => dialog().querySelector("img[data-preview-current]")!,
      () => viewport(),
    ]) {
      await act(async () => {
        fireEvent.click(target());
      });
      expect(details.getAttribute("aria-expanded")).toBe("false");
    }
  });
});
