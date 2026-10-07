// @rstest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import { VideoPreviewContent } from "./VideoPreviewContent";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(cleanup);

const style = {
  top: 40,
  left: 80,
  width: 960,
  height: 540,
  transform: "translate(12px,8px) scale(1)",
};

function preview(onUnzoom = rs.fn()) {
  return {
    img: <img src="blob:poster" alt="clip.mp4" style={style} />,
    modalState: "LOADED" as const,
    onUnzoom,
    buttonUnzoom: <button type="button">Unused library control</button>,
    isZoomImgLoaded: true,
    src: "blob:clip",
  };
}

function player(container: HTMLElement) {
  return container.querySelector<HTMLVideoElement>("[data-preview-video]");
}

describe("video preview", () => {
  it("plays the file over the landed poster, in its box", () => {
    const { container } = render(<VideoPreviewContent {...preview()} />);
    const video = player(container);
    expect(video?.getAttribute("src")).toBe("blob:clip");
    expect(video?.getAttribute("poster")).toBe("blob:poster");
    expect(video?.controls).toBe(true);
    expect(video?.autoplay).toBe(true);
    expect(video?.style.width).toBe("960px");
    expect(video?.style.transform).toBe("translate(12px,8px) scale(1)");
  });

  it("leaves the return to the poster, cropped back to the card", () => {
    const props = preview();
    const view = render(<VideoPreviewContent {...props} modalState="LOADING" />);
    expect(player(view.container)).toBeNull();
    view.rerender(<VideoPreviewContent {...props} />);
    expect(player(view.container)).not.toBeNull();
    view.rerender(<VideoPreviewContent {...props} modalState="UNLOADING" />);
    expect(player(view.container)).toBeNull();
    expect(screen.getByAltText<HTMLImageElement>("clip.mp4").style.clipPath).toMatch(
      /^inset\(0% 21\.875% round/,
    );
  });

  it("closes from the backdrop and the close button, not from the player", () => {
    const onUnzoom = rs.fn();
    const { container } = render(<VideoPreviewContent {...preview(onUnzoom)} />);
    fireEvent.click(player(container)!);
    fireEvent.wheel(player(container)!, { deltaY: 120 });
    expect(onUnzoom).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector("[data-preview-state]")!);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onUnzoom).toHaveBeenCalledTimes(2);
  });
});
