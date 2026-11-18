// @rstest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { useListEnd } from "./use-list-end";

// A stand-in that reports "in view" the moment it starts watching, as the
// browser does for an end already on screen.
let inView = true;
let watching = 0;
class FakeObserver {
  constructor(private callback: IntersectionObserverCallback) {}
  observe() {
    watching += 1;
    if (inView)
      this.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      );
  }
  disconnect() {
    watching -= 1;
  }
}

function List({
  enabled,
  page,
  onReached,
}: {
  enabled: boolean;
  page: number;
  onReached: () => void;
}) {
  const end = useListEnd({ enabled, page, onReached, rootMargin: "160px 0px" });
  return <div ref={end.ref} />;
}

describe("useListEnd", () => {
  beforeEach(() => {
    inView = true;
    watching = 0;
    rs.stubGlobal("IntersectionObserver", FakeObserver);
  });
  afterEach(() => {
    cleanup();
    rs.unstubAllGlobals();
  });

  it("asks for more when the end is in view, and again for each new page", () => {
    const onReached = rs.fn();
    const { rerender } = render(<List enabled page={20} onReached={onReached} />);
    expect(onReached).toHaveBeenCalledTimes(1);
    act(() => rerender(<List enabled page={20} onReached={onReached} />));
    expect(onReached).toHaveBeenCalledTimes(1);
    act(() => rerender(<List enabled page={40} onReached={onReached} />));
    expect(onReached).toHaveBeenCalledTimes(2);
  });

  it("does not watch while disabled, and stops watching on unmount", () => {
    const onReached = rs.fn();
    const { rerender, unmount } = render(<List enabled={false} page={20} onReached={onReached} />);
    expect(onReached).not.toHaveBeenCalled();
    expect(watching).toBe(0);
    inView = false;
    act(() => rerender(<List enabled page={20} onReached={onReached} />));
    expect(watching).toBe(1);
    unmount();
    expect(watching).toBe(0);
  });
});
