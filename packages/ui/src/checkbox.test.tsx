import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { Checkbox } from "./checkbox.js";

afterEach(cleanup);

function box(): HTMLElement {
  return screen.getByRole("checkbox");
}

describe("Checkbox", () => {
  it("reports the state the caller should move to", () => {
    const onCheckedChange = rs.fn();
    const { rerender } = render(
      <Checkbox aria-label="Notify" checked={false} onCheckedChange={onCheckedChange} />,
    );

    fireEvent.click(box());
    expect(onCheckedChange).toHaveBeenLastCalledWith(true);

    rerender(<Checkbox aria-label="Notify" checked onCheckedChange={onCheckedChange} />);
    fireEvent.click(box());
    expect(onCheckedChange).toHaveBeenLastCalledWith(false);
  });

  it("tracks the state a caller drives from the callback", () => {
    function Form() {
      const [on, setOn] = useState(false);
      return (
        <Checkbox
          aria-label="Notify"
          checked={on}
          onCheckedChange={(next) => setOn(next === true)}
        />
      );
    }
    render(<Form />);

    expect(box().getAttribute("aria-checked")).toBe("false");
    fireEvent.click(box());
    expect(box().getAttribute("aria-checked")).toBe("true");
    expect(box().getAttribute("data-state")).toBe("checked");
  });

  it("announces the mixed state", () => {
    render(<Checkbox aria-label="Select all" checked="indeterminate" />);

    expect(box().getAttribute("aria-checked")).toBe("mixed");
    expect(box().getAttribute("data-state")).toBe("indeterminate");
  });

  // A box set indeterminate through `defaultChecked` has no `checked` prop, so
  // a glyph picked from that prop drew a check over `aria-checked="mixed"`.
  for (const [origin, props] of [
    ["controlled", { checked: "indeterminate" }],
    ["uncontrolled", { defaultChecked: "indeterminate" }],
  ] as const) {
    it(`draws the mixed glyph on a ${origin} indeterminate box`, () => {
      const { container } = render(<Checkbox aria-label="Select all" {...props} />);

      expect(box().getAttribute("data-state")).toBe("indeterminate");
      expect(container.querySelector(".lucide-minus")).not.toBeNull();
      expect(container.querySelector(".lucide-check")?.getAttribute("class")).toContain(
        "group-data-[state=indeterminate]:hidden",
      );
    });
  }

  it("does not report a change while disabled", () => {
    const onCheckedChange = rs.fn();
    render(<Checkbox aria-label="Notify" disabled onCheckedChange={onCheckedChange} />);

    fireEvent.click(box());

    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it("is labelled by a sibling label", () => {
    render(
      <>
        <Checkbox id="notify" />
        <label htmlFor="notify">Notify me</label>
      </>,
    );

    expect(screen.getByRole("checkbox", { name: "Notify me" })).toBeDefined();
  });

  it("sizes itself off the control scale and widens its hit area", () => {
    render(<Checkbox aria-label="Notify" />);

    const cls = [...box().classList];
    expect(cls).toContain("size-4");
    expect(box().className).not.toMatch(/--control-/);
    // The hit area grows through a pseudo-element, not the box, so a form row
    // stays the label's height.
    expect(cls).toContain("after:absolute");
    expect(cls).toContain("after:-inset-x-3");
    // Vertically it stops at half the gap a column of these sits at. A
    // symmetric 12px reaches 4px into the next box, so a click on this one's
    // bottom edge lands on its neighbour.
    expect(cls).toContain("after:-inset-y-1");
    expect(cls).not.toContain("after:-inset-3");
  });

  it("draws focus and the invalid state as an outline outside the box", () => {
    render(<Checkbox aria-label="Notify" />);

    const cls = [...box().classList];
    // The edge is carried at rest, transparent, so gaining focus changes the
    // style and the color rather than snapping the width in from the browser.
    expect(cls).toContain("outline-1");
    expect(cls).toContain("outline-offset-0");
    expect(cls).toContain("outline-transparent");
    expect(cls).toContain("focus-visible:outline-solid");
    expect(cls).toContain("focus-visible:outline-ring/50");
    // Outside the box: a checked box is filled to its border, so an inset edge
    // would land on `primary` over `primary` and mark nothing.
    expect(cls.some((token) => /^focus-visible:-outline-offset-/.test(token))).toBe(false);
    expect(cls).toContain("aria-invalid:outline-destructive");
    expect(cls.some((token) => /ring(-|$)/.test(token) && !token.includes("outline"))).toBe(false);
  });

  it("reserves its border and only recolors it when checked", () => {
    render(<Checkbox aria-label="Notify" />);

    const cls = [...box().classList];
    expect(cls).toContain("border");
    expect(cls).toContain("data-[state=checked]:border-primary");
    expect(cls.some((token) => /^data-\[state=[a-z]+\]:border(-\d+)?$/.test(token))).toBe(false);
  });
});
