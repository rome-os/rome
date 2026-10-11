// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, render } from "@testing-library/react";
import { useContainerBelowWidth } from "./useContainerBelowWidth";

let resize: ((width: number) => void) | undefined;

function Probe({ onRender }: { onRender: (isBelow: boolean) => void }) {
  const { ref, isBelow } = useContainerBelowWidth<HTMLDivElement>(1024);
  onRender(isBelow);
  return <div ref={ref} />;
}

afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

describe("useContainerBelowWidth", () => {
  it("keeps the last layout while the element is hidden", () => {
    rs.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private callback: ResizeObserverCallback) {}
        observe(target: Element) {
          resize = (width) =>
            this.callback(
              [{ target, contentRect: { width } } as ResizeObserverEntry],
              this as unknown as ResizeObserver,
            );
        }
        disconnect() {}
      },
    );
    let isBelow: boolean | undefined;
    render(<Probe onRender={(value) => (isBelow = value)} />);

    act(() => resize?.(600));
    expect(isBelow).toBe(true);
    // display:none (an inactive tab) measures 0.
    act(() => resize?.(0));
    expect(isBelow).toBe(true);
    act(() => resize?.(1400));
    expect(isBelow).toBe(false);
    act(() => resize?.(0));
    expect(isBelow).toBe(false);
  });
});
