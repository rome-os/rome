// jsdom implements neither ResizeObserver nor scrollIntoView, and the Radix
// primitives behind @rome-os/ui call both.
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
}
