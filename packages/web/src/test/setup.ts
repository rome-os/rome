// jsdom implements neither ResizeObserver, scrollIntoView nor pointer capture.
// cmdk's Command constructs the first on mount and calls the second whenever the
// roving selection moves; Radix Select, Dialog and menus poke pointer capture.
// They are stubbed once here instead of in each file's beforeAll. Individual
// files may still override these. Node-environment tests are untouched.
if (typeof window !== "undefined") {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = () => {};
  }
  if (typeof Element.prototype.hasPointerCapture !== "function") {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
  }
}
