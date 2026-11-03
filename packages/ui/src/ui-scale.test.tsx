import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { Dialog } from "./dialog.js";
import { UiScaleProvider, useUiScale } from "./ui-scale.js";

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function Scale() {
  return <output>{useUiScale()}</output>;
}

function mockPointer(initial: boolean) {
  let matches = initial;
  const listeners = new Set<() => void>();
  const matchMedia = rs.fn(() => ({
    get matches() {
      return matches;
    },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
  rs.spyOn(window, "matchMedia").mockImplementation(
    matchMedia as unknown as typeof window.matchMedia,
  );
  return {
    listeners,
    change(next: boolean) {
      matches = next;
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}

describe("platform scale selection", () => {
  it("updates auto scale when the primary pointer changes and removes the listener", () => {
    const pointer = mockPointer(false);
    const { unmount } = render(
      <UiScaleProvider>
        <Scale />
      </UiScaleProvider>,
    );
    expect(screen.getByRole("status").textContent).toBe("medium");
    pointer.change(true);
    expect(screen.getByRole("status").textContent).toBe("large");
    unmount();
    expect(pointer.listeners.size).toBe(0);
  });

  it("preserves an explicit scale when pointer capability changes", () => {
    const pointer = mockPointer(true);
    render(
      <UiScaleProvider scale="medium">
        <Scale />
      </UiScaleProvider>,
    );
    pointer.change(false);
    pointer.change(true);
    expect(screen.getByRole("status").textContent).toBe("medium");
    expect(pointer.listeners.size).toBe(0);
  });

  it("carries the nearest nested scale into a dialog portaled to the body", () => {
    render(
      <UiScaleProvider scale="large">
        <UiScaleProvider scale="medium">
          <Dialog open onClose={() => {}} aria-label="Scale preview">
            <Scale />
          </Dialog>
        </UiScaleProvider>
      </UiScaleProvider>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.closest("[data-ui-scale]")?.getAttribute("data-ui-scale")).toBe("medium");
    expect(dialog.querySelector("output")?.textContent).toBe("medium");
  });
});
