import { describe, expect, it, rs } from "@rstest/core";
import {
  handleHardwareBack,
  PULL_TO_REFRESH_MESSAGE,
  PULL_TO_REFRESH_SCRIPT,
  type PullToRefreshEvent,
  parsePullToRefreshMessage,
} from "./webview-navigation.js";

describe("handleHardwareBack", () => {
  it("steps the WebView back when it has history", () => {
    const goBack = rs.fn();
    expect(handleHardwareBack(true, { goBack })).toBe(true);
    expect(goBack).toHaveBeenCalledTimes(1);
  });

  it("lets the system handle the press when the WebView has no history", () => {
    const goBack = rs.fn();
    expect(handleHardwareBack(false, { goBack })).toBe(false);
    expect(handleHardwareBack(true, null)).toBe(false);
    expect(goBack).not.toHaveBeenCalled();
  });
});

describe("parsePullToRefreshMessage", () => {
  it("accepts pull events", () => {
    const encode = (message: object) =>
      JSON.stringify({ type: PULL_TO_REFRESH_MESSAGE, ...message });
    expect(parsePullToRefreshMessage(encode({ phase: "move", distance: 12 }))).toEqual({
      phase: "move",
      distance: 12,
    });
    expect(parsePullToRefreshMessage(encode({ phase: "end", distance: 80 }))).toEqual({
      phase: "end",
      distance: 80,
    });
    expect(parsePullToRefreshMessage(encode({ phase: "cancel" }))).toEqual({ phase: "cancel" });
  });

  it("ignores other messages", () => {
    expect(parsePullToRefreshMessage("not json")).toBeNull();
    expect(parsePullToRefreshMessage("null")).toBeNull();
    expect(
      parsePullToRefreshMessage(JSON.stringify({ type: "other", phase: "cancel" })),
    ).toBeNull();
    expect(
      parsePullToRefreshMessage(
        JSON.stringify({ type: PULL_TO_REFRESH_MESSAGE, phase: "move", distance: -1 }),
      ),
    ).toBeNull();
    expect(
      parsePullToRefreshMessage(
        JSON.stringify({ type: PULL_TO_REFRESH_MESSAGE, phase: "end", distance: "80" }),
      ),
    ).toBeNull();
  });
});

interface FakeElement {
  nodeType: 1;
  tagName: string;
  scrollTop: number;
  isContentEditable: boolean;
  parentElement: FakeElement | null;
}

type Listener = (event: FakeTouchEvent) => void;

interface FakeTouchEvent {
  target: FakeElement;
  touches: { clientX: number; clientY: number }[];
  defaultPrevented: boolean;
}

function element(parent: FakeElement | null, tagName = "DIV"): FakeElement {
  return { nodeType: 1, tagName, scrollTop: 0, isContentEditable: false, parentElement: parent };
}

function page() {
  const root = element(null, "HTML");
  const body = element(root, "BODY");
  const bodyAttributes = new Set<string>();
  const listeners = new Map<string, Listener[]>();
  const posted: PullToRefreshEvent[] = [];
  let selection = "";
  const window = {
    document: {
      body: { hasAttribute: (name: string) => bodyAttributes.has(name) },
      scrollingElement: root,
      documentElement: root,
    },
    scrollY: 0,
    getSelection: () => selection,
    ReactNativeWebView: {
      postMessage(data: string) {
        const event = parsePullToRefreshMessage(data);
        if (!event) throw new Error(`unexpected message ${data}`);
        posted.push(event);
      },
    },
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };
  new Function("window", PULL_TO_REFRESH_SCRIPT)(window);

  function dispatch(
    type: string,
    target: FakeElement,
    touches: { clientX: number; clientY: number }[],
    defaultPrevented = false,
  ) {
    for (const listener of listeners.get(type) ?? []) {
      listener({ target, touches, defaultPrevented });
    }
  }

  return {
    window,
    root,
    body,
    posted,
    lockScroll: () => bodyAttributes.add("data-scroll-locked"),
    select: (text: string) => {
      selection = text;
    },
    start: (target: FakeElement, y = 100, x = 50) =>
      dispatch("touchstart", target, [{ clientX: x, clientY: y }]),
    move: (target: FakeElement, y: number, x = 50, defaultPrevented = false) =>
      dispatch("touchmove", target, [{ clientX: x, clientY: y }], defaultPrevented),
    end: (target: FakeElement) => dispatch("touchend", target, []),
  };
}

describe("PULL_TO_REFRESH_SCRIPT", () => {
  it("reports a downward pull from the top of the page", () => {
    const p = page();
    const target = element(p.body);
    p.start(target, 100);
    p.move(target, 105);
    p.move(target, 140);
    p.move(target, 200);
    p.end(target);
    expect(p.posted).toEqual([
      { phase: "move", distance: 30 },
      { phase: "move", distance: 90 },
      { phase: "end", distance: 90 },
    ]);
  });

  it("installs once per document", () => {
    const p = page();
    new Function("window", PULL_TO_REFRESH_SCRIPT)(p.window);
    const target = element(p.body);
    p.start(target, 100);
    p.move(target, 140);
    expect(p.posted).toEqual([{ phase: "move", distance: 30 }]);
  });

  it("ignores a pull while the document is scrolled", () => {
    const p = page();
    p.root.scrollTop = 40;
    const target = element(p.body);
    p.start(target, 100);
    p.move(target, 200);
    p.end(target);
    expect(p.posted).toEqual([]);
  });

  it("ignores a pull inside an inner pane that is scrolled down", () => {
    const p = page();
    const pane = element(p.body);
    pane.scrollTop = 300;
    const message = element(pane);
    p.start(message, 100);
    p.move(message, 200);
    p.end(message);
    expect(p.posted).toEqual([]);
  });

  it("ignores pulls on editable fields, under an open overlay, or with a text selection", () => {
    const editable = page();
    const field = element(editable.body, "TEXTAREA");
    editable.start(field, 100);
    editable.move(field, 200);

    const locked = page();
    locked.lockScroll();
    const target = element(locked.body);
    locked.start(target, 100);
    locked.move(target, 200);

    const selected = page();
    selected.select("copied text");
    const text = element(selected.body);
    selected.start(text, 100);
    selected.move(text, 200);

    expect([...editable.posted, ...locked.posted, ...selected.posted]).toEqual([]);
  });

  it("ignores upward and sideways swipes", () => {
    const p = page();
    const target = element(p.body);
    p.start(target, 100);
    p.move(target, 90);
    p.move(target, 200);
    p.start(target, 100, 50);
    p.move(target, 108, 90);
    p.move(target, 200, 90);
    expect(p.posted).toEqual([]);
  });

  it("cancels a pull when the page takes over the gesture", () => {
    const p = page();
    const target = element(p.body);
    p.start(target, 100);
    p.move(target, 140);
    p.move(target, 160, 50, true);
    p.end(target);
    expect(p.posted).toEqual([{ phase: "move", distance: 30 }, { phase: "cancel" }]);
  });

  it("cancels a pull when the touched pane starts scrolling", () => {
    const p = page();
    const pane = element(p.body);
    const target = element(pane);
    p.start(target, 100);
    p.move(target, 140);
    pane.scrollTop = 5;
    p.move(target, 150);
    expect(p.posted).toEqual([{ phase: "move", distance: 30 }, { phase: "cancel" }]);
  });
});
