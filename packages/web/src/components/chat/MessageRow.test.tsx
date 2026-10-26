// @rstest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { MessageRow } from "./MessageRow";

afterEach(cleanup);

describe("MessageRow header line", () => {
  it("lets the accessory's items wrap onto their own line instead of shrinking", () => {
    render(
      <MessageRow
        name="Flint"
        avatar={<span />}
        subtitle={<span>2 steps</span>}
        headerAccessory={<ul data-testid="accessory" className="contents" />}
      />,
    );
    const line = screen.getByText("Flint").parentElement?.parentElement as HTMLElement;
    // Wrapping and clipping live on one element, so a wrapped item's left edge
    // (its separator) falls outside it. The padding that insets the header from
    // the gutter sits on its parent, outside the clip.
    expect(line.className).toContain("flex-wrap");
    expect(line.className).toContain("overflow-hidden");
    expect(line.className).not.toMatch(/(^|\s)p[lx]?-/);
    expect(line.parentElement?.className).toContain("pl-3");
    // The name and trace form one unbreakable group on the fixed-height line.
    const group = screen.getByText("Flint").parentElement as HTMLElement;
    expect(group.className).toContain("h-5");
    expect(group.contains(screen.getByText("2 steps"))).toBe(true);
    // The accessory is flattened into the line's items.
    expect(screen.getByTestId("accessory").parentElement?.className).toBe("contents");
    expect(line.contains(screen.getByTestId("accessory"))).toBe(true);
  });
});
