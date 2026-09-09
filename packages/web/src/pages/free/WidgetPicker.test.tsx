// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "@/i18n";
import { WidgetPicker } from "./WidgetPicker";

// Built once in the factory rather than per call, so the array identity stays
// stable across renders and the memo downstream does not rebuild every frame.
rs.mock("@/hooks/use-apps", () => {
  const app = (id: string, displayName: string, hasFrontend = true) => ({
    id,
    displayName,
    hasFrontend,
    status: "active",
    // Given so each row's text is its display name alone. Without one the row
    // draws the initial as a letter tile, which lands in `textContent` too.
    iconUrl: `/icons/${id}.png`,
  });
  const apps = [
    app("recipe-box", "Recipe Box"),
    app("notes", "Notes"),
    // Filtered out before the list is built, so it must never appear.
    app("headless", "Headless", false),
  ];
  return { useApps: () => ({ apps }) };
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

afterEach(cleanup);

async function openPicker(onSelect = rs.fn()) {
  const user = userEvent.setup();
  render(
    <WidgetPicker onSelect={onSelect}>
      <button type="button">Add widget</button>
    </WidgetPicker>,
  );
  await user.click(screen.getByRole("button", { name: "Add widget" }));
  return { user, onSelect, search: screen.getByRole("combobox") };
}

function optionNames() {
  return screen.queryAllByRole("option").map((option) => option.textContent);
}

describe("WidgetPicker", () => {
  it("lists the built-in widgets and every app with a frontend", async () => {
    await openPicker();

    expect(optionNames()).toEqual(["Browser", "Projects", "Recipe Box", "Notes"]);
  });

  it("filters by substring rather than fuzzy match", async () => {
    const { user, search } = await openPicker();

    // cmdk's own matcher scores "Projects" above "Recipe Box" here, which would
    // put the highlight — and therefore Enter — on the wrong row.
    await user.type(search, "rec");

    expect(optionNames()).toEqual(["Recipe Box"]);
  });

  it("matches a built-in on its type as well as its label", async () => {
    const { user, search } = await openPicker();

    await user.type(search, "desktop");

    expect(optionNames()).toEqual(["Browser"]);
  });

  it("reports a query that matches nothing", async () => {
    const { user, search } = await openPicker();

    await user.type(search, "zzz");

    expect(optionNames()).toEqual([]);
    expect(screen.getByText("No apps match “zzz”.")).toBeTruthy();
  });

  it("selects the app behind a searched row on Enter", async () => {
    const { user, search, onSelect } = await openPicker();

    await user.type(search, "rec");
    await user.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledWith("app", "recipe-box");
  });

  it("selects a built-in without a target id", async () => {
    const { user, onSelect } = await openPicker();

    await user.click(screen.getByRole("option", { name: "Projects" }));

    expect(onSelect).toHaveBeenCalledWith("projects", undefined);
  });

  it("drops the query when the picker closes, so the next open starts clean", async () => {
    const { user, search } = await openPicker();

    await user.type(search, "rec");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Add widget" }));

    expect(optionNames()).toEqual(["Browser", "Projects", "Recipe Box", "Notes"]);
  });
});
