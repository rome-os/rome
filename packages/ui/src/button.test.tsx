import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { ArrowRight, Plus } from "lucide-react";

import { Button } from "./button.js";

afterEach(cleanup);

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
