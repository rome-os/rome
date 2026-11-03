import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { ArrowRight, Plus } from "lucide-react";

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

  it("keeps popup triggers and ButtonGroup segments out of the scale", () => {
    render(<Button>Save</Button>);
    const [token] = pressScale(screen.getByRole("button"));
    expect(token).toContain("not-aria-[haspopup]");
    expect(token).toContain("not-in-data-[slot=button-group]");
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

describe("Button glyph inset", () => {
  it.each([
    ["sm", "sm"],
    ["md", "md"],
    ["default", "md"],
  ] as const)("trims each marked side at size %s", (size, step) => {
    render(
      <Button size={size}>
        Continue
        <ArrowRight data-icon="inline-end" />
      </Button>,
    );
    const { className } = screen.getByRole("button");
    expect(className).toContain(`has-data-[icon=inline-end]:pr-[var(--control-px-icon-${step})]`);
    expect(className).toContain(`has-data-[icon=inline-start]:pl-[var(--control-px-icon-${step})]`);
  });

  it("keeps xs on symmetric padding", () => {
    render(
      <Button size="xs">
        <Plus data-icon="inline-start" />
        Add
      </Button>,
    );
    expect(screen.getByRole("button").className).not.toContain("control-px-icon-");
  });

  it("applies the trim to asChild content", () => {
    render(
      <Button asChild size="sm">
        <a href="/apps">
          <Plus data-icon="inline-start" />
          Apps
        </a>
      </Button>,
    );
    expect(screen.getByRole("link").className).toContain(
      "has-data-[icon=inline-start]:pl-[var(--control-px-icon-sm)]",
    );
  });
});
