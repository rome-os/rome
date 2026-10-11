import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "@rstest/core";
import { buildThemeCss } from "./theme";
import { BUILTIN_THEMES } from "./themes";

// `rome run` (packages/app-web-sdk) mounts an app outside the dashboard, so it
// ships a copy of the dashboard's theme values. This test keeps that copy equal
// to what the dashboard injects. UPDATE_HOST_THEMES=1 rewrites it.
const HOST_THEMES_CSS = new URL("../../../app-web-sdk/assets/host-themes.css", import.meta.url);
const HEADER =
  "/* Generated from packages/web/src/lib/themes.ts by host-themes-css.test.ts. Do not edit. */\n";

describe("app-web-sdk host theme copy", () => {
  it("matches the dashboard's built-in themes", () => {
    const expected = `${HEADER}${buildThemeCss(BUILTIN_THEMES)}\n`;
    if (process.env.UPDATE_HOST_THEMES === "1") writeFileSync(HOST_THEMES_CSS, expected);
    expect(readFileSync(HOST_THEMES_CSS, "utf8")).toBe(expected);
  });
});
