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
    expect(el.className).toContain("size-9");
  });

  it("draws a brand mark a kind shares with another, such as the Slack bot's", () => {
    expect(tile("brand:slack_bot", "Slack bot").querySelector("svg")).not.toBeNull();
  });

  it("draws a provider's glyph", () => {
    const el = tile("glyph:gmail", "Gmail");
    expect(el.querySelector("svg")).not.toBeNull();
    expect(el.textContent).toBe("");
    expect(el.className).toContain("size-9");
  });

  it("draws Gmail's own multicolor mark, not a generic envelope", () => {
    const el = tile("glyph:gmail", "Gmail");
    const fills = [...el.querySelectorAll("path")].map((path) => path.getAttribute("fill"));
    expect(fills).toEqual(["#4285f4", "#34a853", "#fbbc04", "#ea4335", "#c5221f"]);
    expect(el.querySelector("svg")?.getAttribute("viewBox")).toBe("0 49.4 512 399.42");
  });

  it("draws Google Calendar's own multicolor mark", () => {
    const el = tile("glyph:calendar", "Calendar");
    const fills = new Set(
      [...el.querySelectorAll("path")].map((path) => path.getAttribute("fill")),
    );
    expect(fills).toContain("#4285F4");
    expect(fills).toContain("#EA4335");
    expect(fills).toContain("#FBBC04");
    expect(fills).toContain("#34A853");
  });

  it("still draws a service with no logo with its monochrome glyph", () => {
    const el = tile("glyph:outlook", "Outlook");
    expect(el.querySelector("svg")?.getAttribute("stroke")).toBe("currentColor");
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
    expect(el.className).toContain("size-9");
  });
});
