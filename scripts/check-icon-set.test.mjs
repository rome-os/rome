import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  BUILTIN_ICON_DIR,
  BUILTIN_ICONS,
  findIconDependencies,
  findIconImports,
  isOtherIconLibrary,
  renderBuiltinIcon,
  workspaceDirs,
} from "./check-icon-set.mjs";

const ONE_SET =
  "Rome's glyphs come from lucide-react alone. A second icon set brings its own grid and\n" +
  "stroke, so it reads lighter or heavier than the lucide glyph beside it. Use the lucide\n" +
  "equivalent (https://lucide.dev/icons).";

test("no workspace depends on another icon library", () => {
  assert.deepEqual(findIconDependencies(), [], ONE_SET);
});

test("no source file imports another icon library", () => {
  assert.deepEqual(findIconImports(), [], ONE_SET);
});

test("every tool icon file is the lucide glyph it names", () => {
  const files = readdirSync(BUILTIN_ICON_DIR).filter((name) => name.endsWith(".svg"));
  assert.deepEqual(
    files.sort(),
    Object.keys(BUILTIN_ICONS).sort(),
    "A tool icon file needs its lucide glyph listed in BUILTIN_ICONS in scripts/check-icon-set.mjs.",
  );
  for (const [file, glyph] of Object.entries(BUILTIN_ICONS)) {
    assert.equal(
      readFileSync(join(BUILTIN_ICON_DIR, file), "utf8"),
      renderBuiltinIcon(glyph),
      `${file} is not lucide's ${glyph}. Run \`node scripts/check-icon-set.mjs --write\`.`,
    );
  }
});

test("a tool icon keeps its child shapes' geometry", () => {
  // Image draws its frame as a <rect>; without width and height it renders nothing.
  assert.match(renderBuiltinIcon("Image"), /<rect [^>]*width="18" height="18"/);
  assert.doesNotMatch(renderBuiltinIcon("Image"), /^<svg[^>]* (width|height|class)=/);
});

test("matches a library and its subpaths, and nothing that only shares a prefix", () => {
  assert.ok(isOtherIconLibrary("@radix-ui/react-icons"));
  assert.ok(isOtherIconLibrary("react-icons/fa"));
  assert.ok(isOtherIconLibrary("@heroicons/react/24/outline"));
  assert.ok(!isOtherIconLibrary("lucide-react"));
  assert.ok(!isOtherIconLibrary("@radix-ui/react-dialog"));
  assert.ok(!isOtherIconLibrary("react-icons-extra"));
});

test("scans the kit, the dashboard, and every first-party app", () => {
  const scanned = workspaceDirs().map((dir) => dir.split(/[\\/]/).slice(-2).join("/"));
  // A gate that scans nothing passes, so narrowing the scan has to fail here.
  for (const dir of [
    "packages/ui",
    "packages/web",
    "packages/app-web-sdk",
    "rome_apps/showcases",
  ]) {
    assert.ok(scanned.includes(dir), `${dir} is not scanned`);
  }
});
