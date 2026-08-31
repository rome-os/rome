import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { Button } from "./button.js";
import { ButtonGroup } from "./button-group.js";

afterEach(cleanup);

describe("ButtonGroup", () => {
  it("owns the spacing and joined geometry of kit Buttons", () => {
    render(
      <ButtonGroup aria-label="History controls">
        <Button>Back</Button>
        <Button>Forward</Button>
      </ButtonGroup>,
    );

    const group = screen.getByRole("group", { name: "History controls" });
    expect(group.className).toContain("has-[>[data-slot=button-group]]:gap-2");
    expect(group.className).toContain("[&>*:not(:first-child)]:rounded-l-none");
    expect(group.className).toContain("[&>*:not(:last-child)]:rounded-r-none");

    for (const button of screen.getAllByRole("button")) {
      expect(button.dataset.slot).toBe("button");
      expect(button.className).not.toMatch(/(?:^|\s)m[trblxy]?-/);
      expect(button.className).not.toMatch(/(?:^|\s)w-/);
    }
  });
});
