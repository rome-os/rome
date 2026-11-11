// @rstest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import { downloadImage, ImagePreviewContent } from "./ImagePreviewContent";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(cleanup);

function preview(onUnzoom = rs.fn()) {
  return {
    img: <img src="test.png" alt="Test image" />,
    modalState: "LOADED" as const,
    onUnzoom,
    buttonUnzoom: <button type="button">Unused library control</button>,
    isZoomImgLoaded: true,
  };
}

describe("image preview controls", () => {
  it.each([
    [640, 240, 0, 31.25],
    [240, 640, 31.25, 0],
    [240, 240, 0, 0],
  ])("returns a %s × %s image to its square crop", (width, height, insetY, insetX) => {
    const props = preview();
    const imageRef = { current: null as HTMLImageElement | null };
    const onTransitionEnd = rs.fn();
    props.img = (
      <img
        ref={imageRef}
        src="test.png"
        alt="Test image"
        style={{ width, height, transform: "scale(0.4)" }}
        onTransitionEnd={onTransitionEnd}
      />
    );
    const view = render(<ImagePreviewContent {...props} />);
    const image = screen.getByAltText<HTMLImageElement>("Test image");
    expect(image.style.clipPath).toBe("inset(0% 0% round 0% / 0%)");
    view.rerender(<ImagePreviewContent {...props} modalState="UNLOADING" />);
    expect(image.style.clipPath.startsWith(`inset(${insetY}% ${insetX}% round`)).toBe(true);
    expect(image.style.transform).toBe("scale(0.4)");
    expect(imageRef.current).toBe(image);
    fireEvent.transitionEnd(image, { propertyName: "clip-path" });
    expect(onTransitionEnd).not.toHaveBeenCalled();
    fireEvent.transitionEnd(image, { propertyName: "transform" });
    expect(onTransitionEnd).toHaveBeenCalledTimes(1);
  });

  it("zooms within bounds and resets to fit", () => {
    render(<ImagePreviewContent {...preview()} />);
    expect((screen.getByRole("button", { name: "Zoom out" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    for (let i = 0; i < 20; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    }
    expect(screen.getByLabelText("Zoom").textContent).toBe("400%");
    expect((screen.getByRole("button", { name: "Zoom in" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(screen.getByLabelText("Zoom").textContent).toBe("375%");
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByLabelText("Zoom").textContent).toBe("100%");
  });

  it("handles wheel and keyboard zoom without closing the preview", () => {
    const props = preview();
    render(<ImagePreviewContent {...props} />);
    const image = screen.getByAltText("Test image");
    fireEvent.wheel(image, { deltaY: -100 });
    expect(screen.getByLabelText("Zoom").textContent).toBe("125%");
    fireEvent.keyDown(image, { key: "+" });
    expect(screen.getByLabelText("Zoom").textContent).toBe("150%");
    fireEvent.keyDown(image, { key: "-" });
    fireEvent.keyDown(image, { key: "0" });
    expect(screen.getByLabelText("Zoom").textContent).toBe("100%");
    expect(props.onUnzoom).not.toHaveBeenCalled();
  });

  it("closes from the backdrop or close button, but not from the image", () => {
    const props = preview();
    const { container } = render(<ImagePreviewContent {...props} />);
    fireEvent.click(screen.getByAltText("Test image"));
    expect(props.onUnzoom).not.toHaveBeenCalled();
    fireEvent.click(container.firstElementChild!);
    expect(props.onUnzoom).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(props.onUnzoom).toHaveBeenCalledTimes(2);
  });

  it("reopens at the fitted size", () => {
    const props = preview();
    const view = render(<ImagePreviewContent {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    view.rerender(<ImagePreviewContent {...props} modalState="UNLOADED" />);
    view.rerender(<ImagePreviewContent {...props} />);
    expect(screen.getByLabelText("Zoom").textContent).toBe("100%");
  });
});

describe("image preview in a reply", () => {
  afterEach(() => {
    rs.restoreAllMocks();
  });

  it("shows no download button outside a reply", () => {
    const view = render(<ImagePreviewContent {...preview()} />);
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    view.rerender(<ImagePreviewContent {...preview()} inReply />);
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
  });

  it("crops a composer preview to its square card but not a reply picture", () => {
    const props = preview();
    props.img = (
      <img
        src="test.png"
        alt="Test image"
        style={{ width: 640, height: 240, transform: "scale(0.4)" }}
      />
    );
    const view = render(<ImagePreviewContent {...props} modalState="UNLOADING" />);
    expect(screen.getByAltText<HTMLImageElement>("Test image").style.clipPath).toContain(
      "inset(0% 31.25%",
    );
    view.rerender(<ImagePreviewContent {...props} modalState="UNLOADING" inReply />);
    expect(screen.getByAltText<HTMLImageElement>("Test image").style.clipPath).toBe("");
  });

  it("downloads a same-origin picture through a link named after the file", () => {
    const click = rs.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const open = rs.spyOn(window, "open").mockImplementation(() => null);
    downloadImage("/api/projects/asset/image%20one.png?path=projects/demo/image%20one.png");
    expect(click).toHaveBeenCalledTimes(1);
    const link = click.mock.contexts[0] as HTMLAnchorElement;
    expect(link.download).toBe("image one.png");
    expect(new URL(link.href).pathname).toBe("/api/projects/asset/image%20one.png");
    expect(open).not.toHaveBeenCalled();
  });

  it("opens a cross-origin picture in a new tab without fetching it", () => {
    const click = rs.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const open = rs.spyOn(window, "open").mockImplementation(() => null);
    const fetchSpy = rs.fn();
    rs.stubGlobal("fetch", fetchSpy);
    downloadImage("https://example.com/picture.jpg");
    rs.unstubAllGlobals();
    expect(open).toHaveBeenCalledWith(
      "https://example.com/picture.jpg",
      "_blank",
      "noopener,noreferrer",
    );
    expect(click).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("taps Download inside the click, so the new tab keeps the user's gesture", () => {
    const open = rs.spyOn(window, "open").mockImplementation(() => null);
    render(
      <ImagePreviewContent
        {...preview()}
        img={<img src="https://example.com/picture.jpg" alt="Test image" />}
        inReply
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("downloads downloadSrc when the viewer still shows a smaller picture", () => {
    const open = rs.spyOn(window, "open").mockImplementation(() => null);
    render(
      <ImagePreviewContent
        {...preview()}
        img={<img src="https://example.com/small.webp" alt="Test image" />}
        inReply
        downloadSrc="https://example.com/original.png"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(open).toHaveBeenCalledWith(
      "https://example.com/original.png",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
