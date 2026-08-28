import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, rs } from "@rstest/core";

const scriptSource = readFileSync(new URL("./chat_action.js", import.meta.url), "utf8");

function loadScript(
  scrollRoot: {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    parentElement?: unknown;
    scrollTo?: (options: { top: number; behavior: string }) => void;
  },
  options?: {
    main?: unknown;
    querySelectorMap?: Record<string, unknown>;
  },
) {
  const window = {
    scrollTo: rs.fn(),
    getComputedStyle: rs.fn(() => ({
      overflowY: "auto",
      overflow: "auto",
    })),
  };
  const document = {
    scrollingElement: scrollRoot,
    documentElement: scrollRoot,
    body: scrollRoot,
    querySelector: rs.fn((selector: string) => {
      if (options?.querySelectorMap?.[selector] !== undefined) {
        return options.querySelectorMap[selector];
      }

      if (selector === "main") {
        return options?.main ?? null;
      }

      return null;
    }),
    querySelectorAll: rs.fn(() => []),
  };
  const context = {
    console,
    document,
    window,
    __ROME_CHATGPT_CHAT_AUTORUN__: false,
  } as Record<string, unknown>;
  context.globalThis = context;

  vm.runInNewContext(scriptSource, context);

  return { context, window };
}

describe("chat_action polling scroll", () => {
  it("scrolls downward by a fixed step instead of jumping to the bottom", () => {
    const scrollRoot = {
      scrollTop: 100,
      scrollHeight: 3000,
      clientHeight: 900,
    };
    const { context, window } = loadScript(scrollRoot);

    const nudgePollingScroll = context.nudgePollingScroll as (state: {
      lastScrollHeight: number;
    }) => { lastScrollHeight: number };
    const nextState = nudgePollingScroll({ lastScrollHeight: 0 });

    expect(scrollRoot.scrollTop).toBe(700);
    expect(window.scrollTo).toHaveBeenCalledWith(0, 700);
    expect(nextState).toEqual({ lastScrollHeight: 3000 });
  });

  it("caps the step scroll at the page bottom", () => {
    const scrollRoot = {
      scrollTop: 2200,
      scrollHeight: 3000,
      clientHeight: 500,
    };
    const { context, window } = loadScript(scrollRoot);

    const nudgePollingScroll = context.nudgePollingScroll as (state: {
      lastScrollHeight: number;
    }) => { lastScrollHeight: number };
    nudgePollingScroll({ lastScrollHeight: 0 });

    expect(scrollRoot.scrollTop).toBe(2500);
    expect(window.scrollTo).toHaveBeenCalledWith(0, 2500);
  });

  it("does not scroll when already near the bottom and content has not grown", () => {
    const scrollRoot = {
      scrollTop: 2390,
      scrollHeight: 3000,
      clientHeight: 520,
    };
    const { context, window } = loadScript(scrollRoot);

    const nudgePollingScroll = context.nudgePollingScroll as (state: {
      lastScrollHeight: number;
    }) => { lastScrollHeight: number };
    const nextState = nudgePollingScroll({ lastScrollHeight: 3000 });

    expect(scrollRoot.scrollTop).toBe(2390);
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(nextState).toEqual({ lastScrollHeight: 3000 });
  });

  it("prefers the chat container over the page root when it is scrollable", () => {
    const scrollRoot = {
      scrollTop: 0,
      scrollHeight: 1200,
      clientHeight: 1200,
    };
    const main = {
      scrollTop: 200,
      scrollHeight: 4000,
      clientHeight: 1000,
      parentElement: null,
      scrollTo: rs.fn(),
    };
    const { context, window } = loadScript(scrollRoot, { main });

    const nudgePollingScroll = context.nudgePollingScroll as (state: {
      lastScrollHeight: number;
    }) => { lastScrollHeight: number };
    nudgePollingScroll({ lastScrollHeight: 0 });

    expect(main.scrollTop).toBe(800);
    expect(main.scrollTo).toHaveBeenCalledWith({ top: 800, behavior: "auto" });
    expect(window.scrollTo).not.toHaveBeenCalled();
  });
});
