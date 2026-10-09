import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";

import { Button } from "./button.js";
import { Calendar } from "./calendar.js";
import { Toggle } from "./toggle.js";

afterEach(cleanup);

/** The class tokens that shrink the control while it is held. */
function pressScale(node: Element): string[] {
  return [...node.classList].filter((token) => /(^|:)scale-/.test(token));
}

describe("Button press feedback", () => {
  it("scales on press by default", () => {
    render(<Button>Save</Button>);
    expect(pressScale(screen.getByRole("button"))).toHaveLength(1);
  });

  it("drops the scale when press is none", () => {
    render(<Button press="none">Save</Button>);
    expect(pressScale(screen.getByRole("button"))).toEqual([]);
  });

  it("leaves Toggle unscaled, since it paints its own pressed state", () => {
    render(<Toggle pressed={false} onPressedChange={() => {}} aria-label="Bold" />);
    expect(pressScale(screen.getByRole("button"))).toEqual([]);
  });

  it("leaves calendar days unscaled, so a pressed day cannot open a gap in a range band", () => {
    const { container } = render(<Calendar mode="single" defaultMonth={new Date(2026, 7, 1)} />);
    const days = container.querySelectorAll("button[data-day]");
    expect(days.length).toBeGreaterThan(0);
    for (const day of days) expect(pressScale(day)).toEqual([]);
  });
});
