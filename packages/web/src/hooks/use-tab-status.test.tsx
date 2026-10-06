// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import {
  deriveTabStatus,
  type TabStatus,
  topTabStatus,
  useFinishedUnseen,
  useTabStatus,
} from "./use-tab-status";

describe("deriveTabStatus", () => {
  it("puts a waiting card ahead of a running reply", () => {
    expect(
      deriveTabStatus({ streaming: true, awaitingGuardian: true, finishedUnseen: false }),
    ).toBe("needs-you");
  });

  it("shows a running reply over an earlier unseen finish", () => {
    expect(
      deriveTabStatus({ streaming: true, awaitingGuardian: false, finishedUnseen: true }),
    ).toBe("working");
  });

  it("is idle when nothing is pending", () => {
    expect(
      deriveTabStatus({ streaming: false, awaitingGuardian: false, finishedUnseen: false }),
    ).toBe("idle");
  });
});

describe("topTabStatus", () => {
  it("lets the chat that most needs the guardian win", () => {
    expect(topTabStatus(["done", "needs-you", "working"])).toBe("needs-you");
    expect(topTabStatus(["idle", "done"])).toBe("done");
    expect(topTabStatus([])).toBe("idle");
  });
});

describe("useFinishedUnseen", () => {
  let hidden = false;
  let focused = true;

  beforeEach(() => {
    hidden = false;
    focused = true;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    document.hasFocus = () => focused;
  });

  afterEach(cleanup);

  const mount = () =>
    renderHook(({ turnEnds }) => useFinishedUnseen(turnEnds), { initialProps: { turnEnds: 0 } });

  it("stays false when the turn ends while the guardian is watching", () => {
    const { result, rerender } = mount();
    rerender({ turnEnds: 1 });
    expect(result.current).toBe(false);
  });

  it("marks a turn that ends in a hidden tab, and clears when the tab is shown", () => {
    const { result, rerender } = mount();
    hidden = true;
    rerender({ turnEnds: 1 });
    expect(result.current).toBe(true);

    hidden = false;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current).toBe(false);
  });

  it("treats an unfocused window as away, and clears on focus", () => {
    const { result, rerender } = mount();
    focused = false;
    rerender({ turnEnds: 1 });
    expect(result.current).toBe(true);

    focused = true;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(result.current).toBe(false);
  });

  it("clears at once when the guardian is back before the listeners attach", () => {
    const { result, rerender } = mount();
    // Away when the turn ends, back by the time the listeners attach.
    let checks = 0;
    document.hasFocus = () => checks++ > 0;
    rerender({ turnEnds: 1 });
    expect(result.current).toBe(false);
  });

  it("ignores a re-render without a new turn end, such as a dropped connection", () => {
    const { result, rerender } = mount();
    hidden = true;
    rerender({ turnEnds: 0 });
    expect(result.current).toBe(false);
  });
});

describe("useTabStatus", () => {
  const PNG = "data:image/png;base64,AA";
  let toDataURL: () => string;
  const originalImage = globalThis.Image;
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;

  beforeEach(() => {
    document.head.innerHTML = '<link rel="icon" type="image/svg+xml" href="/icon.svg" />';
    // jsdom has no image decoding or canvas: stand in a loaded logo and a 2D
    // context that accepts every drawing call.
    globalThis.Image = class {
      complete = true;
      naturalWidth = 52;
      src = "";
      addEventListener() {}
    } as unknown as typeof Image;
    HTMLCanvasElement.prototype.getContext = (() =>
      new Proxy({}, { get: () => () => {}, set: () => true })) as never;
    HTMLCanvasElement.prototype.toDataURL = function () {
      return toDataURL();
    };
  });

  afterEach(() => {
    cleanup();
    globalThis.Image = originalImage;
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
    document.head.innerHTML = "";
  });

  function Badge({ status }: { status: TabStatus }) {
    useTabStatus(status);
    return null;
  }

  const link = () => document.querySelector('link[rel="icon"]') as HTMLLinkElement;

  // Runs before any badge is cached, since a cached badge skips the canvas.
  it("keeps the plain logo when the canvas cannot be read", () => {
    toDataURL = () => {
      throw new Error("tainted");
    };
    render(<Badge status="working" />);
    expect(link().getAttribute("href")).toBe("/icon.svg");
  });

  it("swaps in a PNG badge with a matching type, and restores both on release", () => {
    toDataURL = () => PNG;
    const { unmount } = render(<Badge status="working" />);
    expect(link().getAttribute("href")).toBe(PNG);
    expect(link().getAttribute("type")).toBe("image/png");

    unmount();
    expect(link().getAttribute("href")).toBe("/icon.svg");
    expect(link().getAttribute("type")).toBe("image/svg+xml");
  });

  it("falls back to the logo when a later badge cannot be drawn", () => {
    toDataURL = () => PNG;
    const { rerender } = render(<Badge status="working" />);
    expect(link().getAttribute("href")).toBe(PNG);

    toDataURL = () => {
      throw new Error("tainted");
    };
    rerender(<Badge status="needs-you" />);
    expect(link().getAttribute("href")).toBe("/icon.svg");
    expect(link().getAttribute("type")).toBe("image/svg+xml");
  });

  it("drops the PNG type on release when the logo link declared none", () => {
    document.head.innerHTML = '<link rel="icon" href="/icon.svg" />';
    toDataURL = () => PNG;
    const { unmount } = render(<Badge status="working" />);
    expect(link().getAttribute("type")).toBe("image/png");

    unmount();
    expect(link().hasAttribute("type")).toBe(false);
  });
});
