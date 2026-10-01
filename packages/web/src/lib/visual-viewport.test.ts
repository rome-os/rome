import { describe, expect, it } from "@rstest/core";
import {
  overscrollCorrection,
  trackVisualViewport,
  usableViewportHeight,
  VIEWPORT_HEIGHT_VAR,
} from "./visual-viewport";

describe("usableViewportHeight", () => {
  it("is the visual viewport's height while the page is unzoomed", () => {
    expect(usableViewportHeight({ height: 512, pageTop: 0, scale: 1 })).toBe(512);
  });

  it("falls back to the stylesheet while the page is pinch-zoomed", () => {
    expect(usableViewportHeight({ height: 300, pageTop: 0, scale: 2 })).toBeNull();
  });
});

describe("overscrollCorrection", () => {
  it("scrolls a page panned past its end back to the end", () => {
    // iOS panned the page up by the keyboard's 332px, then the page shrank to
    // the 512px above the keyboard.
    expect(overscrollCorrection({ height: 512, pageTop: 332, scale: 1 }, 512)).toBe(0);
  });

  it("brings a long page back so its end meets the visible bottom", () => {
    expect(overscrollCorrection({ height: 844, pageTop: 1500, scale: 1 }, 2000)).toBe(1156);
  });

  it("leaves a page alone while its end is at or below the visible bottom", () => {
    expect(overscrollCorrection({ height: 512, pageTop: 400, scale: 1 }, 2000)).toBeNull();
    expect(overscrollCorrection({ height: 844, pageTop: 0, scale: 1 }, 844)).toBeNull();
  });
});

describe("trackVisualViewport", () => {
  function fakeWindow(initial: { height: number; pageTop: number; scale: number }) {
    const listeners = new Map<string, () => void>();
    const viewport = {
      ...initial,
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    };
    const properties = new Map<string, string>();
    const scrolls: number[] = [];
    let documentHeight = 844;
    const win = {
      visualViewport: viewport,
      document: {
        documentElement: {
          style: {
            setProperty: (name: string, value: string) => properties.set(name, value),
            removeProperty: (name: string) => properties.delete(name),
          },
        },
        body: {
          get scrollHeight() {
            return documentHeight;
          },
        },
      },
      scrollTo: (_x: number, y: number) => scrolls.push(y),
    } as unknown as Window;
    return {
      win,
      viewport,
      properties,
      scrolls,
      listeners,
      setDocumentHeight: (height: number) => {
        documentHeight = height;
      },
    };
  }

  it("publishes the height at once and follows the keyboard opening and closing", () => {
    const page = fakeWindow({ height: 844, pageTop: 0, scale: 1 });
    trackVisualViewport(page.win);
    expect(page.properties.get(VIEWPORT_HEIGHT_VAR)).toBe("844px");

    page.viewport.height = 512;
    page.viewport.pageTop = 332;
    page.setDocumentHeight(512);
    page.listeners.get("resize")?.();
    expect(page.properties.get(VIEWPORT_HEIGHT_VAR)).toBe("512px");
    expect(page.scrolls).toEqual([0]);

    page.viewport.height = 844;
    page.viewport.pageTop = 0;
    page.setDocumentHeight(844);
    page.listeners.get("resize")?.();
    expect(page.properties.get(VIEWPORT_HEIGHT_VAR)).toBe("844px");
    expect(page.scrolls).toEqual([0]);
  });

  it("drops the override while zoomed and stops listening when disposed", () => {
    const page = fakeWindow({ height: 844, pageTop: 0, scale: 1 });
    const stop = trackVisualViewport(page.win);
    page.viewport.scale = 2;
    page.viewport.height = 422;
    page.listeners.get("resize")?.();
    expect(page.properties.has(VIEWPORT_HEIGHT_VAR)).toBe(false);

    stop();
    expect(page.listeners.size).toBe(0);
  });

  it("does nothing where the browser has no visual viewport", () => {
    expect(() =>
      trackVisualViewport({ visualViewport: null } as unknown as Window)(),
    ).not.toThrow();
  });
});
