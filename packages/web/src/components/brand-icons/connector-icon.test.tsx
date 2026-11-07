// @rstest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { ConnectorIcon } from "./connector-icon";

afterEach(cleanup);

const tile = (icon: string | null | undefined, label: string) =>
  render(<ConnectorIcon icon={icon} label={label} />).container.firstElementChild as HTMLElement;

describe("ConnectorIcon", () => {
  it("draws the brand mark of one of Rome's own connections, on the Settings badge", () => {
    const el = tile("brand:github", "GitHub");
    expect(el.querySelector("svg")).not.toBeNull();
    expect(el.textContent).toBe("");
    expect(el.className).toContain("h-9 w-9");
  });

  it("draws a brand mark a kind shares with another, such as the Slack bot's", () => {
    expect(tile("brand:slack_bot", "Slack bot").querySelector("svg")).not.toBeNull();
  });

  it("draws a provider's glyph", () => {
    const el = tile("glyph:gmail", "Gmail");
    expect(el.querySelector("svg")).not.toBeNull();
    expect(el.textContent).toBe("");
    expect(el.className).toContain("h-9 w-9");
  });

  it.each([
    ["no id", null],
    ["no id at all", undefined],
    ["an id this build does not draw", "brand:fax"],
    ["a glyph it does not draw", "glyph:fax"],
    ["an id of an unknown kind", "emoji:x"],
    ["an id with no source", "gmail"],
  ])("falls back to a tile with the initial for %s", (_, icon) => {
    const el = tile(icon, "linear");
    expect(el.querySelector("svg")).toBeNull();
    expect(el.textContent).toBe("L");
    expect(el.className).toContain("h-9 w-9");
  });
});
