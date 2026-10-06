// @rstest-environment jsdom
import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import { PendingUploadsList } from "./PendingUploadsList";

const image = { id: "image", file: new File(["image"], "shot.png", { type: "image/png" }) };
const text = { id: "text", file: new File(["text"], "notes.txt", { type: "text/plain" }) };
const createUrl = rs.fn();
const revokeUrl = rs.fn();

beforeEach(async () => {
  await i18n.changeLanguage("en");
  let id = 0;
  createUrl.mockReset().mockImplementation(() => `blob:preview-${++id}`);
  revokeUrl.mockReset();
  rs.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = createUrl;
      static revokeObjectURL = revokeUrl;
    },
  );
});

afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

function cards() {
  return screen.getAllByRole("listitem");
}

describe("pending attachment previews", () => {
  it("numbers image and file cards in send order, visibly and for screen readers", () => {
    const remove = rs.fn();
    render(<PendingUploadsList uploads={[image, text]} onRemove={remove} disabled={false} />);
    const [first, second] = cards();

    expect(within(first).getByAltText("shot.png").getAttribute("src")).toBe("blob:preview-1");
    expect(within(first).getByText("#File 1")).toBeTruthy();
    expect(within(first).getByText("1")).toBeTruthy();
    expect(first.getAttribute("title")).toBe("#File 1 · shot.png");

    expect(within(second).getByText("#File 2")).toBeTruthy();
    expect(within(second).getByText("2")).toBeTruthy();
    expect(second.getAttribute("title")).toBe("#File 2 · notes.txt");

    fireEvent.click(screen.getByRole("button", { name: "Remove shot.png" }));
    expect(remove).toHaveBeenCalledWith("image");
  });

  it("falls back to a numbered file card when an image cannot be decoded", () => {
    render(<PendingUploadsList uploads={[image]} onRemove={rs.fn()} disabled={false} />);
    fireEvent.error(screen.getByAltText("shot.png"));
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("#File 1")).toBeTruthy();
    expect(screen.getByText("shot.png")).toBeTruthy();
    expect(screen.getByText("png")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove shot.png" })).toBeTruthy();
  });

  it("replaces removal with per-file progress on every card kind and keeps the preview", () => {
    const props = { uploads: [image, text], onRemove: rs.fn(), disabled: false };
    const view = render(<PendingUploadsList {...props} uploadProgress={0.5} />);
    const src = screen.getByAltText("shot.png").getAttribute("src");
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(
      screen
        .getByRole("progressbar", { name: "Upload progress for shot.png" })
        .getAttribute("aria-valuenow"),
    ).toBe("90");
    expect(
      screen
        .getByRole("progressbar", { name: "Upload progress for notes.txt" })
        .getAttribute("aria-valuenow"),
    ).toBe("0");
    view.rerender(<PendingUploadsList {...props} uploadProgress={null} />);
    expect(
      screen
        .getByRole("progressbar", { name: "Upload progress for shot.png" })
        .hasAttribute("aria-valuenow"),
    ).toBe(false);
    view.rerender(<PendingUploadsList {...props} />);
    expect(screen.getByAltText("shot.png").getAttribute("src")).toBe(src);
    expect(screen.getByRole("button", { name: "Remove shot.png" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove notes.txt" })).toBeTruthy();
    expect(revokeUrl).not.toHaveBeenCalled();
  });

  it("offers no removal while the composer is busy", () => {
    render(<PendingUploadsList uploads={[image, text]} onRemove={rs.fn()} disabled />);
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("releases every Strict Mode object URL when attachments leave the tray", () => {
    const props = { onRemove: rs.fn(), disabled: false };
    const view = render(
      <StrictMode>
        <PendingUploadsList {...props} uploads={[image, text]} />
      </StrictMode>,
    );
    view.rerender(
      <StrictMode>
        <PendingUploadsList {...props} uploads={[text]} />
      </StrictMode>,
    );
    expect(revokeUrl.mock.calls.map(([url]) => url).sort()).toEqual(
      createUrl.mock.results.map(({ value }) => value).sort(),
    );
    expect(screen.getByText("#File 1")).toBeTruthy();
  });

  it("renders the first lines of a text file as its thumbnail", async () => {
    const doc = {
      id: "doc",
      file: new File(["# Sample Title\nContent snippet\n"], "sample.md", { type: "" }),
    };
    const { container } = render(
      <PendingUploadsList uploads={[doc]} onRemove={rs.fn()} disabled={false} />,
    );
    expect(await screen.findByText(/# Sample Title\s+Content snippet$/)).toBeTruthy();
    const page = container.querySelector("[data-pending-doc-page]");
    expect(page?.className).toContain("text-aux");
    expect(page?.className).not.toContain("font-mono");
    expect(screen.getByText("sample.md")).toBeTruthy();
  });

  it("reads code by extension even when the browser reports no text MIME type", async () => {
    const code = {
      id: "code",
      file: new File(["class Main {}"], "Main.java", { type: "" }),
    };
    const { container } = render(
      <PendingUploadsList uploads={[code]} onRemove={rs.fn()} disabled={false} />,
    );
    expect(await screen.findByText("class Main {}")).toBeTruthy();
    expect(container.querySelector("[data-pending-doc-page]")?.className).toContain("font-mono");
  });

  it("shows the kind glyph and extension for binary files, including text-named binaries", async () => {
    const pdf = { id: "pdf", file: new File(["%PDF"], "manual.pdf", { type: "application/pdf" }) };
    const stream = {
      id: "stream",
      file: new File([new Uint8Array([0x47, 0x00, 0x11])], "clip.ts", { type: "video/mp2t" }),
    };
    const { container } = render(
      <PendingUploadsList uploads={[pdf, stream]} onRemove={rs.fn()} disabled={false} />,
    );
    expect(screen.getByText("pdf")).toBeTruthy();
    expect(screen.getByText("manual.pdf")).toBeTruthy();
    // Let the `.ts` read settle, then confirm the NUL byte kept it off the page.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector("[data-pending-doc-page]")).toBeNull();
    expect(screen.getByText("ts")).toBeTruthy();
  });
});
