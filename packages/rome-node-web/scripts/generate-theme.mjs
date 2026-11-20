import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const themeNamespace = await import("../../web/src/lib/theme.ts");
const { buildThemeCss, DEFAULT_THEME_NAME, getThemeDefinitions } =
  "buildThemeCss" in themeNamespace ? themeNamespace : themeNamespace.default;

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = resolve(rootDir, "src/generated-ember-theme.css");

const ember = getThemeDefinitions().find((theme) => theme.id === DEFAULT_THEME_NAME);
if (!ember) {
  throw new Error(
    `Default theme "${DEFAULT_THEME_NAME}" not found in packages/web/src/lib/themes.ts`,
  );
}

const css = `/* Generated from packages/web/src/lib/themes.ts (${ember.id}). Do not edit by hand. */\n${buildThemeCss([ember])}\n`;

let previous = "";
try {
  previous = readFileSync(outPath, "utf8");
} catch {
  // First generation.
}
if (previous !== css) {
  writeFileSync(outPath, css, "utf8");
}
