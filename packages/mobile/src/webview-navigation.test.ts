import { describe, expect, it, rs } from "@rstest/core";
import {
  handleHardwareBack,
  PULL_TO_REFRESH_MESSAGE,
  PULL_TO_REFRESH_RELOAD_TIMEOUT_MS,
  PULL_TO_REFRESH_SCRIPT,
  PullToRefreshController,
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
  let popperOpen = false;
  const fields: { tagName: string; value: string; textContent: string }[] = [];
  const window = {
    document: {
      body: { hasAttribute: (name: string) => bodyAttributes.has(name) },
      scrollingElement: root,
      documentElement: root,
      querySelector: (selector: string) =>
        popperOpen && selector === "[data-radix-popper-content-wrapper]" ? {} : null,
      querySelectorAll: () => fields,
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
  const installMessages = posted.splice(0);

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
    installMessages,
    addField: (tagName: string, text: string) =>
      fields.push(
        tagName === "TEXTAREA"
          ? { tagName, value: text, textContent: "" }
          : { tagName, value: "", textContent: text },
      ),
    lockScroll: () => bodyAttributes.add("data-scroll-locked"),
    openPopper: () => {
      popperOpen = true;
    },
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

  it("posts cancel when it installs, so a pull the previous document left retracts", () => {
    expect(page().installMessages).toEqual([{ phase: "cancel" }]);
  });

  it("reports distance 0 when the finger moves back above the start, so release does not reload", () => {
    const p = page();
    const target = element(p.body);
    p.start(target, 100);
    p.move(target, 140);
    p.move(target, 90);
    p.end(target);
    expect(p.posted).toEqual([
      { phase: "move", distance: 30 },
      { phase: "move", distance: 0 },
      { phase: "end", distance: 0 },
    ]);
  });

  it("ignores a pull while a textarea or contenteditable holds unsent text", () => {
    const textarea = page();
    textarea.addField("TEXTAREA", "half-typed message");
    const a = element(textarea.body);
    textarea.start(a, 100);
    textarea.move(a, 200);

    const editor = page();
    editor.addField("DIV", "draft");
    const b = element(editor.body);
    editor.start(b, 100);
    editor.move(b, 200);

    expect([...textarea.posted, ...editor.posted]).toEqual([]);

    const blank = page();
    blank.addField("TEXTAREA", "  \n");
    const c = element(blank.body);
    blank.start(c, 100);
    blank.move(c, 140);
    expect(blank.posted).toEqual([{ phase: "move", distance: 30 }]);
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

    const popover = page();
    popover.openPopper();
    const popoverContent = element(popover.body);
    popover.start(popoverContent, 100);
    popover.move(popoverContent, 200);

    const selected = page();
    selected.select("copied text");
    const text = element(selected.body);
    selected.start(text, 100);
    selected.move(text, 200);

    expect([...editable.posted, ...locked.posted, ...popover.posted, ...selected.posted]).toEqual(
      [],
    );
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

describe("PullToRefreshController", () => {
  function controller() {
    const calls: string[] = [];
    const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
    const pull = new PullToRefreshController(
      {
        showPull: (distance) => calls.push(`show ${distance}`),
        settle: (distance) => calls.push(`settle ${distance}`),
        setReloading: (reloading) => calls.push(`reloading ${reloading}`),
        thresholdReached: () => calls.push("threshold"),
        reload: () => calls.push("reload"),
      },
      (run, ms) => {
        const timer = { run, ms, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    );
    return { pull, calls, timers };
  }

  it("reloads on a release past the threshold and settles when the load ends", () => {
    const { pull, calls, timers } = controller();
    pull.handle({ phase: "move", distance: 40 });
    pull.handle({ phase: "move", distance: 80 });
    pull.handle({ phase: "end", distance: 80 });
    pull.handle({ phase: "move", distance: 30 });
    pull.loadEnded();
    expect(calls).toEqual([
      "show 40",
      "show 80",
      "threshold",
      "reloading true",
      "settle 72",
      "reload",
      "reloading false",
      "settle 0",
    ]);
    expect(timers[0]?.cancelled).toBe(true);
  });

  it("retracts without reloading on a short release or a cancel", () => {
    const { pull, calls } = controller();
    pull.handle({ phase: "move", distance: 40 });
    pull.handle({ phase: "end", distance: 40 });
    pull.handle({ phase: "move", distance: 20 });
    pull.handle({ phase: "cancel" });
    expect(calls).toEqual(["show 40", "settle 0", "show 20", "settle 0"]);
  });

  it("retracts a partial pull when the WebView remounts", () => {
    const { pull, calls } = controller();
    pull.handle({ phase: "move", distance: 30 });
    pull.reset();
    pull.reset();
    expect(calls).toEqual(["show 30", "settle 0"]);
  });

  it("unlocks the gesture when a reload never reports its end", () => {
    const { pull, calls, timers } = controller();
    pull.handle({ phase: "end", distance: 90 });
    expect(timers.map((timer) => timer.ms)).toEqual([PULL_TO_REFRESH_RELOAD_TIMEOUT_MS]);
    timers[0]?.run();
    pull.handle({ phase: "move", distance: 10 });
    expect(calls).toEqual([
      "reloading true",
      "settle 72",
      "reload",
      "reloading false",
      "settle 0",
      "show 10",
    ]);
  });

  it("drops the pending timeout on dispose", () => {
    const { pull, timers } = controller();
    pull.handle({ phase: "end", distance: 90 });
    pull.dispose();
    expect(timers[0]?.cancelled).toBe(true);
  });
});
