// jsdom implements neither ResizeObserver nor scrollIntoView, and Radix
// primitives (which the kit's components are built on) construct the first on
// mount and call the second whenever a roving selection moves. Stub both once
// here instead of in each file's beforeAll; individual files may still override
// them.
//
// jsdom is this package's default environment, but the `typeof window` guard
// keeps the setup safe for a file that opts into the node environment with a
// `// @rstest-environment node` docblock — the same guard `packages/web` uses.
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
