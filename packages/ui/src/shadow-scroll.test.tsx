import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { Dialog, DialogBody, DialogTitle } from "./dialog.js";
import { Popover, PopoverAnchor, PopoverContent } from "./popover.js";
import { Sheet } from "./sheet.js";
import { mountShadowApp } from "./test/shadow-app.js";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

// jsdom has no layout: give the scroll area a fixed scroll geometry.
function setScrollGeometry(el: HTMLElement, scrollTop: number) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: 1000 });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: 200 });
  Object.defineProperty(el, "scrollTop", { configurable: true, value: scrollTop, writable: true });
}

function setHorizontalGeometry(el: HTMLElement, scrollLeft: number) {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: 1000 });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: 200 });
  Object.defineProperty(el, "scrollLeft", {
    configurable: true,
    value: scrollLeft,
    writable: true,
  });
}

function wheel(target: Element, deltaY: number, deltaX = 0) {
  const event = new WheelEvent("wheel", {
    deltaX,
    deltaY,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  target.dispatchEvent(event);
  return event;
}

function touchScroll(target: Element, fromY: number, toY: number) {
  const touch = (y: number) =>
    ({ identifier: 1, target, clientX: 10, clientY: y }) as unknown as Touch;
  target.dispatchEvent(
    new TouchEvent("touchstart", {
      touches: [touch(fromY)],
      changedTouches: [touch(fromY)],
      bubbles: true,
      cancelable: true,
      composed: true,
    }),
  );
  const move = new TouchEvent("touchmove", {
    touches: [touch(toY)],
    changedTouches: [touch(toY)],
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  target.dispatchEvent(move);
  return move;
}

function tallDialog() {
  return (
    <Dialog open onClose={() => {}}>
      <DialogTitle>Choose styles</DialogTitle>
      <DialogBody data-testid="body" style={{ overflowY: "auto" }}>
        <p data-testid="item">A style card</p>
      </DialogBody>
    </Dialog>
  );
}

function find(root: ParentNode, testId: string) {
  const el = root.querySelector(`[data-testid=${testId}]`);
  if (!(el instanceof HTMLElement)) throw new Error(`missing ${testId}`);
  return el;
}

describe("Dialog scroll lock inside a shadow root", () => {
  it("lets a wheel scroll the dialog body", () => {
    const { shadowRoot, mountRoot } = mountShadowApp();
    render(tallDialog(), { container: mountRoot });
    setScrollGeometry(find(shadowRoot, "body"), 0);

    // Before the fix the document-level lock saw the shadow host as the target
    // and cancelled this event.
    expect(wheel(find(shadowRoot, "item"), 100).defaultPrevented).toBe(false);
  });

  it("still cancels a wheel the body cannot absorb, so the page behind stays put", () => {
    const { shadowRoot, mountRoot } = mountShadowApp();
    render(tallDialog(), { container: mountRoot });
    const body = find(shadowRoot, "body");

    setScrollGeometry(body, 800); // already at the bottom
    expect(wheel(find(shadowRoot, "item"), 100).defaultPrevented).toBe(true);
    // Scrolling back up is still allowed from the bottom.
    expect(wheel(find(shadowRoot, "item"), -100).defaultPrevented).toBe(false);

    setScrollGeometry(body, 0); // at the top
    expect(wheel(find(shadowRoot, "item"), -100).defaultPrevented).toBe(true);
  });

  it("lets a touch drag scroll the dialog body", () => {
    const { shadowRoot, mountRoot } = mountShadowApp();
    render(tallDialog(), { container: mountRoot });
    setScrollGeometry(find(shadowRoot, "body"), 0);

    // Finger moves up → content scrolls down.
    expect(touchScroll(find(shadowRoot, "item"), 300, 200).defaultPrevented).toBe(false);
    // Finger moves down at the top → nothing to scroll, the lock cancels it.
    expect(touchScroll(find(shadowRoot, "item"), 200, 300).defaultPrevented).toBe(true);
  });

  it("runs the caller's own wheel handler", () => {
    const { shadowRoot, mountRoot } = mountShadowApp();
    let calls = 0;
    render(
      <Dialog open onClose={() => {}} onWheel={() => calls++}>
        <DialogTitle>Choose styles</DialogTitle>
        <DialogBody data-testid="body">Short</DialogBody>
      </Dialog>,
      { container: mountRoot },
    );
    wheel(find(shadowRoot, "body"), 100);
    expect(calls).toBe(1);
  });

  it("lets a wheel scroll a Sheet's scroll area", () => {
    const { shadowRoot, mountRoot } = mountShadowApp();
    render(
      <Sheet open onClose={() => {}} ariaLabel="Style">
        <div data-testid="body" style={{ overflowY: "auto" }}>
          <p data-testid="item">Style guide</p>
        </div>
      </Sheet>,
      { container: mountRoot },
    );
    setScrollGeometry(find(shadowRoot, "body"), 0);

    expect(wheel(find(shadowRoot, "item"), 100).defaultPrevented).toBe(false);
  });
  it("lets a horizontal wheel scroll a horizontal area, LTR and RTL", () => {
    const { shadowRoot, mountRoot } = mountShadowApp();
    render(
      <Dialog open onClose={() => {}}>
        <DialogTitle>Timeline</DialogTitle>
        <DialogBody data-testid="ltr" style={{ overflowX: "auto" }}>
          <p data-testid="ltr-item">Frame</p>
        </DialogBody>
        <div data-testid="rtl" style={{ overflowX: "auto", direction: "rtl" }}>
          <p data-testid="rtl-item">Frame</p>
        </div>
      </Dialog>,
      { container: mountRoot },
    );
    const ltr = find(shadowRoot, "ltr");
    const ltrItem = find(shadowRoot, "ltr-item");
    setHorizontalGeometry(ltr, 0); // at the left start
    expect(wheel(ltrItem, 0, 100).defaultPrevented).toBe(false);
    expect(wheel(ltrItem, 0, -100).defaultPrevented).toBe(true);
    setHorizontalGeometry(ltr, 800); // at the right end
    expect(wheel(ltrItem, 0, 100).defaultPrevented).toBe(true);
    expect(wheel(ltrItem, 0, -100).defaultPrevented).toBe(false);

    // RTL starts at the right edge (scrollLeft 0) and runs to -max on the left.
    const rtl = find(shadowRoot, "rtl");
    const rtlItem = find(shadowRoot, "rtl-item");
    setHorizontalGeometry(rtl, 0);
    expect(wheel(rtlItem, 0, -100).defaultPrevented).toBe(false);
    expect(wheel(rtlItem, 0, 100).defaultPrevented).toBe(true);
    setHorizontalGeometry(rtl, -800);
    expect(wheel(rtlItem, 0, -100).defaultPrevented).toBe(true);
    expect(wheel(rtlItem, 0, 100).defaultPrevented).toBe(false);
  });

  it("never lets a portalled layer's event scroll the app behind the dialog", () => {
    const { shadowRoot, appBody, mountRoot } = mountShadowApp();
    // The app's own page scroller, behind the dialog, with room to scroll.
    appBody.style.overflowY = "auto";
    setScrollGeometry(appBody, 0);
    render(
      <Dialog open onClose={() => {}}>
        <DialogTitle>Pick</DialogTitle>
        <DialogBody>
          <Popover open modal={false}>
            <PopoverAnchor />
            <PopoverContent data-testid="popover">
              <p data-testid="option">Option</p>
            </PopoverContent>
          </Popover>
        </DialogBody>
      </Dialog>,
      { container: mountRoot },
    );
    const dialog = shadowRoot.querySelector("[role=dialog]");
    const option = find(shadowRoot, "option");
    // The popover is portalled: a React child of the dialog, not a DOM child.
    expect(dialog?.contains(find(shadowRoot, "popover"))).toBe(false);

    let reachedDocument = false;
    const listener = () => {
      reachedDocument = true;
    };
    document.addEventListener("wheel", listener);
    try {
      // A walk from the option would reach the scrollable app body; the event
      // must not be let through, so the lock still sees it and cancels it.
      expect(wheel(option, 100).defaultPrevented).toBe(true);
    } finally {
      document.removeEventListener("wheel", listener);
    }
    expect(reachedDocument).toBe(true);
  });

  it("still delivers the wheel to React handlers above the dialog", () => {
    const { shadowRoot, mountRoot } = mountShadowApp();
    let outerCalls = 0;
    render(
      // e.g. a canvas zoom surface that renders the dialog
      <div onWheel={() => outerCalls++}>{tallDialog()}</div>,
      { container: mountRoot },
    );
    setScrollGeometry(find(shadowRoot, "body"), 0);

    expect(wheel(find(shadowRoot, "item"), 100).defaultPrevented).toBe(false);
    expect(outerCalls).toBe(1);
  });
});

describe("Dialog scroll lock in the plain document", () => {
  it("leaves wheel events to the lock unchanged", () => {
    render(tallDialog());
    setScrollGeometry(find(document, "body"), 0);
    let reachedDocument = false;
    const listener = () => {
      reachedDocument = true;
    };
    document.addEventListener("wheel", listener);
    try {
      wheel(find(document, "item"), 100);
    } finally {
      document.removeEventListener("wheel", listener);
    }
    expect(reachedDocument).toBe(true);
  });
});
