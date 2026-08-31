import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { FilterChipGroup, type FilterChipOption } from "./filter-chip-group.js";

afterEach(cleanup);

const OPTIONS: FilterChipOption[] = [
  { value: "all", label: "All", count: 12 },
  { value: "inner-circle", label: "Inner circle", count: 3 },
  { value: "acquaintance", label: "Acquaintance", count: 4 },
];

function renderGroup(value = "all", onValueChange = () => {}) {
  return render(
    <FilterChipGroup
      aria-label="Filter people by bond"
      options={OPTIONS}
      value={value}
      onValueChange={onValueChange}
    />,
  );
}

const chip = (name: string | RegExp) => screen.getByRole("radio", { name });
const countOf = (name: RegExp) =>
  within(chip(name)).getByText((_, el) => el?.getAttribute("data-slot") === "filter-chip-count");

describe("FilterChipGroup", () => {
  it("exposes a named radiogroup, not a tablist", () => {
    renderGroup();

    // The chips filter one list rather than revealing a panel each, so
    // announcing a tablist would send assistive tech looking for tabpanels
    // that do not exist.
    expect(screen.getByRole("radiogroup", { name: "Filter people by bond" })).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("marks only the chip matching `value` as checked", () => {
    renderGroup("inner-circle");

    expect(chip(/^Inner circle/).getAttribute("aria-checked")).toBe("true");
    for (const other of [/^All/, /^Acquaintance/]) {
      expect(chip(other).getAttribute("aria-checked")).toBe("false");
    }
  });

  it("reports the chosen value", async () => {
    const onValueChange = rs.fn();
    const user = userEvent.setup();
    renderGroup("all", onValueChange);

    await user.click(chip(/^Acquaintance/));

    expect(onValueChange).toHaveBeenCalledWith("acquaintance");
  });

  it("paints the selected chip's count with the chip's own foreground", () => {
    renderGroup("all");

    // The selected chip's fill is `--primary`, and `--subtle-foreground` is a
    // light-surface value that measures 1.34:1 on it. The count is the only
    // report of how many rows the filter matches, so it takes the chip's
    // partner foreground instead.
    expect(countOf(/^All/).className).toContain("text-primary-foreground");
    expect(countOf(/^All/).className).not.toContain("text-subtle-foreground");
    expect(countOf(/^Inner circle/).className).toContain("text-subtle-foreground");
  });

  it("reserves the border width in both states so selecting one cannot shift the row", () => {
    renderGroup("all");

    // `box-sizing` only absorbs a border on an axis with a specified size, and
    // a chip's width grows with its label. A width that appeared only when
    // unselected would move every chip after the one you picked.
    for (const c of screen.getAllByRole("radio")) {
      expect(c.className).toContain("border");
      expect(c.className).not.toContain("border-0");
    }
    expect(chip(/^All/).className).toContain("border-transparent");
    expect(chip(/^Inner circle/).className).toContain("border-border-strong");
  });

  it("moves the selection with the arrow keys", async () => {
    const onValueChange = rs.fn();
    const user = userEvent.setup();
    renderGroup("all", onValueChange);

    chip(/^All/).focus();
    // Held rather than tapped: roving focus lands on the next chip in a
    // macrotask, and the selection only follows while the arrow is still
    // down — a keydown/keyup pair in one tick is not a gesture a person makes.
    await user.keyboard("{ArrowRight>}");
    await waitFor(() => expect(onValueChange).toHaveBeenCalledWith("inner-circle"));
    await user.keyboard("{/ArrowRight}");
  });

  it("omits the count when an option has none", () => {
    render(
      <FilterChipGroup
        aria-label="Filter people by bond"
        options={[{ value: "all", label: "All" }]}
        value="all"
        onValueChange={() => {}}
      />,
    );

    expect(
      within(chip(/^All/)).queryByText(
        (_, el) => el?.getAttribute("data-slot") === "filter-chip-count",
      ),
    ).toBeNull();
  });
});
