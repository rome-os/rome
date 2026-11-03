import { readdirSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));

function stylesheets(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return stylesheets(path);
    return extname(path) === ".css" ? [path] : [];
  });
}

const RAW_COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i;

describe("color policy", () => {
  // Moving a raw color out of a `.tsx` into a stylesheet gets it past the
  // utility checks while it still ignores every theme and dark mode. Theme
  // values live in `lib/themes.ts`, and `globals.css` is the one recorded
  // exception.
  it("keeps raw colors out of component stylesheets", () => {
    const offenders = stylesheets(sourceRoot).filter((path) => {
      const source = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      return RAW_COLOR.test(source);
    });

    expect(offenders.map((path) => relative(sourceRoot, path)).sort()).toEqual(["globals.css"]);
  });
});
