// @rstest-environment jsdom
import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

describe("pending attachment previews", () => {
  it("previews images while numbering mixed attachments in send order", () => {
    const remove = rs.fn();
    render(<PendingUploadsList uploads={[image, text]} onRemove={remove} disabled={false} />);
    expect(screen.getByAltText("shot.png").getAttribute("src")).toBe("blob:preview-1");
    expect(screen.getByText("#File 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove shot.png" }));
    expect(remove).toHaveBeenCalledWith("image");
  });

  it("falls back to the numbered chip when an image cannot be decoded", () => {
    render(<PendingUploadsList uploads={[image]} onRemove={rs.fn()} disabled={false} />);
    fireEvent.error(screen.getByAltText("shot.png"));
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("#File 1")).toBeTruthy();
    expect(screen.getByText("shot.png")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove shot.png" })).toBeTruthy();
  });

  it("replaces removal with per-file progress and keeps the preview through cancellation", () => {
    const props = { uploads: [image, text], onRemove: rs.fn(), disabled: false };
    const view = render(<PendingUploadsList {...props} uploadProgress={0.5} />);
    const src = screen.getByAltText("shot.png").getAttribute("src");
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(
      screen
        .getByRole("progressbar", { name: "Upload progress for shot.png" })
        .getAttribute("aria-valuenow"),
    ).toBe("90");
    view.rerender(<PendingUploadsList {...props} uploadProgress={null} />);
    expect(
      screen
        .getByRole("progressbar", { name: "Upload progress for shot.png" })
        .hasAttribute("aria-valuenow"),
    ).toBe(false);
    view.rerender(<PendingUploadsList {...props} />);
    expect(screen.getByAltText("shot.png").getAttribute("src")).toBe(src);
    expect(screen.getByRole("button", { name: "Remove shot.png" })).toBeTruthy();
    expect(revokeUrl).not.toHaveBeenCalled();
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

  it("renders document card preview with snippet and remove control", async () => {
    const doc = {
      id: "doc",
      file: new File(["# Sample Title\nContent snippet"], "sample.md", { type: "text/markdown" }),
    };
    const remove = rs.fn();
    render(<PendingUploadsList uploads={[doc]} onRemove={remove} disabled={false} />);
    expect(await screen.findByText("# Sample Title")).toBeTruthy();
    expect(screen.getByText("sample.md")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove sample.md" }));
    expect(remove).toHaveBeenCalledWith("doc");
  });

  it("renders distinct category badges for PDF and code files", async () => {
    const pdf = { id: "pdf", file: new File([], "manual.pdf", { type: "application/pdf" }) };
    const code = {
      id: "code",
      file: new File(["def main():\n  pass"], "app.py", { type: "text/x-python" }),
    };
    render(<PendingUploadsList uploads={[pdf, code]} onRemove={rs.fn()} disabled={false} />);
    expect(screen.getByText("PDF")).toBeTruthy();
    expect(screen.getByText("manual.pdf")).toBeTruthy();
    expect(await screen.findByText(/def main/)).toBeTruthy();
    expect(screen.getByText("app.py")).toBeTruthy();
  });
});
