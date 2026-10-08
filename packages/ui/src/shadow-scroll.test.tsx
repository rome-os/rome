import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { Dialog, DialogBody, DialogTitle } from "./dialog.js";
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

function wheel(target: Element, deltaY: number) {
  const event = new WheelEvent("wheel", {
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
