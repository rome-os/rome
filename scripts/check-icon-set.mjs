/**
 * Rome draws its glyphs from one set, lucide. Its icons share a 24px grid, a
 * stroke, and optical keylines (a circle drawn larger than a square, a play
 * triangle nudged right), so any two of them sit level beside each other. A
 * glyph from a second set brings its own grid and stroke, and reads lighter or
 * heavier than its neighbours however carefully it is placed.
 *
 * Two halves keep it one set:
 *   - no workspace depends on, or imports, another icon library;
 *   - the tool icons served as files under `packages/web/public/builtin-icons/`
 *     are lucide drawings, generated from the installed `lucide-react`.
 *
 * `node scripts/check-icon-set.mjs --write` regenerates the tool icons.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { blankComments } from "./check-padding-scale.mjs";
import { AREA_PATHS } from "./ci-changed-areas.mjs";

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Icon libraries other than lucide. A package here is a second icon set. */
export const OTHER_ICON_LIBRARIES = [
  "@radix-ui/react-icons",
  "react-icons",
  "@heroicons/react",
  "@tabler/icons-react",
  "@phosphor-icons/react",
  "react-feather",
  "feather-icons",
  "@mui/icons-material",
  "@fortawesome/react-fontawesome",
  "@fortawesome/free-solid-svg-icons",
  "@fortawesome/free-regular-svg-icons",
  "@iconify/react",
  "@remixicon/react",
  "lucide-static",
];

const WORKSPACE_ROOTS = ["packages", "rome_apps"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".turbo"]);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

const rel = (path) => relative(repoRoot, path).split(sep).join("/");

/**
 * The workspaces CI runs this check for: the ones under a rest-shard prefix,
 * since the rest shard is the one that runs it. That is every package that
 * renders UI; core and the CLIs draw no glyphs.
 */
export function workspaceDirs() {
  const dirs = [];
  for (const root of WORKSPACE_ROOTS) {
    for (const entry of readdirSync(join(repoRoot, root), { withFileTypes: true })) {
      const dir = join(repoRoot, root, entry.name);
      if (
        entry.isDirectory() &&
        AREA_PATHS.rest.some((prefix) => `${rel(dir)}/`.startsWith(prefix))
      ) {
        dirs.push(dir);
      }
    }
  }
  return dirs;
}

/** Every `package.json` dependency on another icon library, as `file  name`. */
export function findIconDependencies() {
  const found = [];
  for (const dir of [repoRoot, ...workspaceDirs()]) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (OTHER_ICON_LIBRARIES.includes(name))
          found.push(`${rel(join(dir, "package.json"))}  ${name}`);
      }
    }
  }
  return found;
}

/** Matches the specifier of a static import, re-export, `import()`, or `require()`. */
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;

export const isOtherIconLibrary = (specifier) =>
  OTHER_ICON_LIBRARIES.some((name) => specifier === name || specifier.startsWith(`${name}/`));

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) yield path;
  }
}

/** Every import of another icon library in workspace source, as `file:line  specifier`. */
export function findIconImports() {
  const found = [];
  for (const dir of workspaceDirs()) {
    for (const path of sourceFiles(dir)) {
      const text = blankComments(readFileSync(path, "utf8"), false);
      for (const match of text.matchAll(SPECIFIER)) {
        if (!isOtherIconLibrary(match[1])) continue;
        const line = text.slice(0, match.index).split("\n").length;
        found.push(`${rel(path)}:${line}  ${match[1]}`);
      }
    }
  }
  return found;
}

/**
 * The tool icons, by file name, and the lucide glyph each one is. Core serves
 * them as image URLs (`packages/core/src/api/builtin-tool-apps.ts`), so they
 * are files rather than components and cannot follow `currentColor`.
 */
export const BUILTIN_ICONS = {
  "browser.svg": "Globe",
  "files.svg": "FileText",
  "image.svg": "Image",
  "notebook.svg": "Notebook",
  "search.svg": "Search",
  "subagent.svg": "Bot",
  "tasks.svg": "SquareCheckBig",
  "terminal.svg": "Terminal",
};

export const BUILTIN_ICON_DIR = join(repoRoot, "packages/web/public/builtin-icons");

/** The stroke the files have always carried, since an image cannot inherit a colour. */
const BUILTIN_STROKE = "#374151";

/** The SVG file for one lucide glyph, rendered by the dashboard's installed `lucide-react`. */
export function renderBuiltinIcon(glyph) {
  const require = createRequire(join(repoRoot, "packages/web/package.json"));
  const { createElement } = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const Icon = require("lucide-react")[glyph];
  if (!Icon) throw new Error(`lucide-react has no icon named ${glyph}`);
  // Only the root's size and class go: a child <rect> needs its own width and height.
  const markup = renderToStaticMarkup(createElement(Icon, { color: BUILTIN_STROKE })).replace(
    /^<svg[^>]*>/,
    (root) => root.replace(/ (width|height|class)="[^"]*"/g, ""),
  );
  return `${markup}\n`;
}

if (process.argv.includes("--write")) {
  for (const [file, glyph] of Object.entries(BUILTIN_ICONS)) {
    writeFileSync(join(BUILTIN_ICON_DIR, file), renderBuiltinIcon(glyph));
  }
}
