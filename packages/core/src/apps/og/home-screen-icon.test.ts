import { afterAll, describe, expect, it } from "@rstest/core";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedApp } from "../state.js";
import {
  HOME_SCREEN_ICON_SIZE,
  renderHomeScreenIcon,
  renderHomeScreenIconSvg,
} from "./home-screen-icon.js";
import { svgToPng } from "./rasterize.js";

const dir = mkdtempSync(join(tmpdir(), "rome-home-screen-icon-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function iconApp(name: string, svg: string): ResolvedApp {
  const path = join(dir, name);
  writeFileSync(path, svg);
  return { iconAbsolutePath: path } as ResolvedApp;
}

const tile = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="14" fill="#6a5acd"/>${body}</svg>`;

describe("renderHomeScreenIcon", () => {
  it("renders a 512 PNG", async () => {
    const png = await renderHomeScreenIcon(iconApp("glyph.svg", tile("")));
    expect(png?.readUInt32BE(16)).toBe(512);
    expect(png?.readUInt32BE(20)).toBe(512);
  });

  it("renders the same icon without the system fonts as with them", async () => {
    // Skipping the fonts is what keeps a render in milliseconds. It changes
    // nothing: resvg never draws text inside an embedded <image> SVG.
    const letter =
      '<text x="18" y="46" font-family="Noto Sans, Helvetica, Arial, sans-serif" font-size="36" fill="#fff">R</text>';
    const svg = tile(letter);
    const icon = await renderHomeScreenIcon(iconApp("text.svg", svg));
    const withFonts = await svgToPng(
      renderHomeScreenIconSvg({ mime: "image/svg+xml", bytes: Buffer.from(svg) }),
      HOME_SCREEN_ICON_SIZE,
      true,
    );
    expect(icon?.equals(withFonts)).toBe(true);
  });

  it("returns null for an app without a drawable icon", async () => {
    expect(await renderHomeScreenIcon({ iconAbsolutePath: undefined } as ResolvedApp)).toBeNull();
  });
});
