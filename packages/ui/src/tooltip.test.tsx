import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip.js";

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

/** Focus as the browser reports it: drawn with a ring (keyboard) or not (given back, or by script). */
function focusAs(element: HTMLElement, visible: boolean) {
  const matches = Element.prototype.matches;
  rs.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector) {
    return selector === ":focus-visible" ? visible : matches.call(this, selector);
  });
  act(() => element.focus());
}

function renderTooltip() {
  render(
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger>Agent mode</TooltipTrigger>
        <TooltipContent>Agent</TooltipContent>
      </Tooltip>
    </TooltipProvider>,
  );
  return screen.getByRole("button", { name: "Agent mode" });
}

describe("TooltipTrigger", () => {
  it("opens nothing when focus comes back to it with the window, unasked", () => {
    focusAs(renderTooltip(), false);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("opens on keyboard focus", () => {
    focusAs(renderTooltip(), true);
    expect(screen.getByRole("tooltip").textContent).toBe("Agent");
  });

  it("still runs the caller's own focus handler", () => {
    const onFocus = rs.fn();
    render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger onFocus={onFocus}>Agent mode</TooltipTrigger>
          <TooltipContent>Agent</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    focusAs(screen.getByRole("button", { name: "Agent mode" }), false);
    expect(onFocus).toHaveBeenCalledTimes(1);
  });
});
