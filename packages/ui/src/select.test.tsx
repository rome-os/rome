import { cleanup, render, screen } from "@testing-library/react";
import { SettingsIcon } from "lucide-react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { Select, SelectTrigger, SelectValue } from "./select.js";

afterEach(cleanup);

/**
 * jsdom does no layout, so "the padding is symmetric" is pinned here as "the
 * left and right padding classes name the same token". The rendered result is
 * checked in a real browser.
 */
function paddingClasses(node: Element, size: "sm" | "md"): string[] {
  const prefix = `data-[size=${size}]:`;
  return [...node.classList]
    .filter((token) => token.startsWith(prefix))
    .map((token) => token.slice(prefix.length))
    .filter((token) => /^p[xlr]-/.test(token));
}

describe("SelectTrigger", () => {
  it("draws a chevron without trimming the chevron side", () => {
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Newest first" />
        </SelectTrigger>
      </Select>,
    );
    const trigger = screen.getByRole("combobox");

    expect(trigger.querySelectorAll("svg")).toHaveLength(1);
    // One symmetric `px-`, not a `pl-`/`pr-` pair: optically correcting the
    // chevron against the padded edge is the Control role's decision to make,
    // not this component's.
    expect(paddingClasses(trigger, "md")).toEqual(["px-[var(--control-px-start-md)]"]);
  });

  it("resolves the older `default` spelling to the md step", () => {
    render(
      <Select>
        <SelectTrigger size="default">
          <SelectValue placeholder="Newest first" />
        </SelectTrigger>
      </Select>,
    );

    // One name per step reaches the DOM, so a selector for the 36px trigger
    // matches whichever spelling the call site wrote.
    expect(screen.getByRole("combobox").getAttribute("data-size")).toBe("md");
  });

  it("drops the chevron under hideIcon, leaving only the caller's icon", () => {
    render(
      <Select>
        <SelectTrigger hideIcon aria-label="Sort order">
          <SettingsIcon data-testid="gear" />
        </SelectTrigger>
      </Select>,
    );
    const trigger = screen.getByRole("combobox", { name: "Sort order" });
    const icons = trigger.querySelectorAll("svg");

    expect(icons).toHaveLength(1);
    expect(icons[0]?.getAttribute("data-testid")).toBe("gear");
  });

  it("pads an icon-only trigger the same as one with a chevron, at unchanged height", () => {
    for (const size of ["sm", "md"] as const) {
      const { unmount } = render(
        <Select>
          <SelectTrigger hideIcon size={size} aria-label="Sort order">
            <SettingsIcon />
          </SelectTrigger>
        </Select>,
      );
      const trigger = screen.getByRole("combobox");

      // Dropping the chevron changes what is inside the box, never the box:
      // the padding is the start group's either way.
      expect(paddingClasses(trigger, size)).toEqual([`px-[var(--control-px-start-${size})]`]);
      expect([...trigger.classList]).toContain(`data-[size=${size}]:h-[var(--control-h-${size})]`);
      unmount();
    }
  });

  it("names an icon-only trigger through aria-labelledby too", () => {
    render(
      <Select>
        <span id="sort-label">Sort order</span>
        <SelectTrigger hideIcon aria-labelledby="sort-label">
          <SettingsIcon />
        </SelectTrigger>
      </Select>,
    );

    expect(screen.getByRole("combobox", { name: "Sort order" })).toBeTruthy();
  });

  it("rejects an icon-only trigger that carries no accessible name", () => {
    render(
      <Select>
        {/* @ts-expect-error hideIcon requires aria-label or aria-labelledby */}
        <SelectTrigger hideIcon>
          <SettingsIcon />
        </SelectTrigger>
      </Select>,
    );

    expect(screen.getByRole("combobox").getAttribute("aria-label")).toBeNull();
  });
});
