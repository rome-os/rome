#!/usr/bin/env tsx
/**
 * Lists what a set of files imports and what imports them, grouped by folder.
 *
 *   pnpm imports-of [--depth <n>] [--all] <file or folder> [...]
 *
 * Paths are relative to the current directory and must lie in one TypeScript
 * package, the nearest tsconfig.json above the first. The package's src/
 * folder is scanned when it has one, otherwise the whole package. Every file
 * outside the set counts toward its folder `<n>` levels under the scanned
 * root (1 by default), and files above that depth count toward the folder
 * holding them. Imports resolve as `pnpm lint:imports` resolves them, so
 * type-only imports, tests and every spelling of one file count the same.
 *
 * It prints the imports leaving the set and the imports reaching it, with up
 * to five import sites per folder, or all of them with `--all`. Then it names
 * the folders the set imports nothing from and the folders that import
 * nothing from it.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type ScannedImport, scanImports } from "../lint/import-rules.js";

const TOP = ".";
const SITES_SHOWN = 5;

/** One import between the set and the rest of the scanned root. */
export interface Crossing {
  from: string;
  line: number;
  to: string;
}

export interface ImportsOf {
  files: string[];
  /** Imports leaving the set, by the folder they reach. */
  outgoing: Map<string, Crossing[]>;
  /** Imports reaching the set, by the folder they come from. */
  incoming: Map<string, Crossing[]>;
  /** Every folder holding a file outside the set. */
  folders: string[];
}

/** The folder `depth` levels under the root that holds `path`, or the deepest one above it. */
export function folderOf(path: string, depth: number): string {
  const parts = path.split("/").slice(0, -1);
  return parts.length === 0 ? TOP : parts.slice(0, depth).join("/");
}

/**
 * Groups the file imports that cross the boundary of `set`. A file is in the
 * set when its path equals an entry of `set` or lies under one. Paths are
 * relative to the scanned root.
 */
export function importsOf(
  imports: readonly ScannedImport[],
  set: readonly string[],
  depth = 1,
): ImportsOf {
  const inSet = (path: string) => set.some((s) => path === s || path.startsWith(`${s}/`));
  const files = new Set<string>();
  const folders = new Set<string>();
  const outgoing = new Map<string, Crossing[]>();
  const incoming = new Map<string, Crossing[]>();
  const add = (map: Map<string, Crossing[]>, key: string, crossing: Crossing) =>
    map.set(key, [...(map.get(key) ?? []), crossing]);

  for (const imp of imports) {
    if (inSet(imp.from)) files.add(imp.from);
    else folders.add(folderOf(imp.from, depth));
    if (imp.kind !== "file" || imp.to.startsWith("../")) continue;
    if (!inSet(imp.to)) folders.add(folderOf(imp.to, depth));
    const crossing = { from: imp.from, line: imp.line, to: imp.to };
    if (inSet(imp.from) && !inSet(imp.to)) add(outgoing, folderOf(imp.to, depth), crossing);
    if (!inSet(imp.from) && inSet(imp.to)) add(incoming, folderOf(imp.from, depth), crossing);
  }
  return { files: [...files].sort(), outgoing, incoming, folders: [...folders].sort() };
}

/** Renders the report the CLI prints. */
export function formatImportsOf(report: ImportsOf, all = false): string {
  const { outgoing, incoming, folders } = report;
  const out: string[] = [`${report.files.length} file(s) in the set`, ""];

  const section = (title: string, map: Map<string, Crossing[]>) => {
    out.push(title);
    if (map.size === 0) out.push("  none");
    const byCount = [...map].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    for (const [folder, crossings] of byCount) {
      const importers = new Set(crossings.map((c) => c.from)).size;
      out.push(`  ${folder}: ${crossings.length} import(s) in ${importers} file(s)`);
      const shown = all ? crossings : crossings.slice(0, SITES_SHOWN);
      for (const c of shown) out.push(`    ${c.from}:${c.line} → ${c.to}`);
      if (shown.length < crossings.length)
        out.push(`    … ${crossings.length - shown.length} more`);
    }
    out.push("");
  };
  section("What the set imports", outgoing);
  section("What imports the set", incoming);

  const without = (map: Map<string, Crossing[]>) => {
    const none = folders.filter((f) => !map.has(f));
    return none.length > 0 ? none.join(", ") : "none";
  };
  out.push(`The set imports nothing from: ${without(outgoing)}`);
  out.push(`Nothing in these imports the set: ${without(incoming)}`);
  return out.join("\n");
}

function findTsconfig(path: string): string {
  let dir = statSync(path).isDirectory() ? path : dirname(path);
  for (;;) {
    const candidate = join(dir, "tsconfig.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no tsconfig.json above ${path}`);
    dir = parent;
  }
}

function main(argv: string[]): number {
  const usage = "usage: pnpm imports-of [--depth <n>] [--all] <file or folder> [...]";
  const all = argv.includes("--all");
  const depthAt = argv.indexOf("--depth");
  const depth = depthAt >= 0 ? Number(argv[depthAt + 1]) : 1;
  const paths = argv.filter((a, i) => !a.startsWith("--") && !(depthAt >= 0 && i === depthAt + 1));
  if (paths.length === 0 || !Number.isInteger(depth) || depth < 1) {
    console.error(usage);
    return 2;
  }
  // pnpm runs a root script from the repo root; INIT_CWD is where it was typed.
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const absolute = paths.map((p) => resolve(cwd, p));
  const missing = absolute.find((p) => !existsSync(p));
  if (missing) {
    console.error(`imports-of: ${missing} does not exist`);
    return 2;
  }
  const tsconfig = findTsconfig(absolute[0]);
  const pkgDir = dirname(tsconfig);
  const root = existsSync(join(pkgDir, "src")) ? join(pkgDir, "src") : pkgDir;
  const set: string[] = [];
  for (const path of absolute) {
    const inRoot = relative(root, path);
    if (inRoot.startsWith("..") || inRoot === "") {
      console.error(`imports-of: ${path} is not inside ${root}`);
      return 2;
    }
    set.push(inRoot.split(sep).join("/"));
  }
  console.log(`Scanned ${relative(cwd, root) || "."}`);
  console.log(formatImportsOf(importsOf(scanImports(root, tsconfig), set, depth), all));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
