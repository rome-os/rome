#!/usr/bin/env tsx
/**
 * Shows the imports between a set of files and every context, to decide which
 * import rules the set can take in rules/contexts.ts.
 *
 *   pnpm context-arrows [--all] [--as <context>] <file or folder> [...]
 *
 * The set is a context folder, such as `packages/core/src/favors`, or the
 * files about to move into one. `--as access` names the context the set
 * becomes, and adds the files already in its folder to the set. Paths are relative to the current directory
 * and must lie under packages/core/src. Every other file there counts toward
 * its context, the first folder under src/. The files at the top of src/
 * count together as `src root` and get no proposed rule.
 *
 * It prints the imports leaving the set and the imports reaching it, grouped
 * by context, with up to five import sites each, or all of them with `--all`.
 * Then it names each direction with no import at all, which a rule can forbid
 * today, and each direction with crossings, which a rule can forbid once they
 * are fixed or listed. Type-only imports and tests count, as they do for the
 * rules.
 */

import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { scanImports, type ScannedImport } from "./import-rules.js";
import { contextOf, FORBIDDEN_DEPENDENCIES } from "./rules/contexts.js";

const ROOT = "src root";
const SITES_SHOWN = 5;

/** One import between the set and the rest of src/. */
export interface Crossing {
  from: string;
  line: number;
  to: string;
}

export interface ContextArrows {
  /** The set's name in a rule: `as`, else its context when every file shares one, else `<set>`. */
  name: string;
  files: string[];
  /** Imports leaving the set, by the context they reach. */
  outgoing: Map<string, Crossing[]>;
  /** Imports reaching the set, by the context they come from. */
  incoming: Map<string, Crossing[]>;
  /** Every context under src/ outside the set, `src root` excluded. */
  others: string[];
}

/**
 * Groups the file imports that cross the boundary of `set`. A file is in the
 * set when its path equals an entry of `set` or lies under one, both relative
 * to src/. `as` names the context the set becomes, whose folder joins the set.
 */
export function contextArrows(
  imports: readonly ScannedImport[],
  paths: readonly string[],
  as?: string,
): ContextArrows {
  const set = as ? [...paths, as] : paths;
  const inSet = (path: string) => set.some((s) => path === s || path.startsWith(`${s}/`));
  const group = (path: string) => (path.includes("/") ? contextOf(path) : ROOT);
  const files = new Set<string>();
  const contexts = new Set<string>();
  const outgoing = new Map<string, Crossing[]>();
  const incoming = new Map<string, Crossing[]>();
  const add = (map: Map<string, Crossing[]>, key: string, crossing: Crossing) =>
    map.set(key, [...(map.get(key) ?? []), crossing]);

  for (const imp of imports) {
    if (inSet(imp.from)) files.add(imp.from);
    else if (group(imp.from) !== ROOT) contexts.add(group(imp.from));
    if (imp.kind !== "file" || imp.to.startsWith("../")) continue;
    const crossing = { from: imp.from, line: imp.line, to: imp.to };
    if (inSet(imp.from) && !inSet(imp.to)) add(outgoing, group(imp.to), crossing);
    if (!inSet(imp.from) && inSet(imp.to)) add(incoming, group(imp.from), crossing);
  }

  const setContexts = new Set([...files].map(group));
  const name =
    as ?? (setContexts.size === 1 && !setContexts.has(ROOT) ? [...setContexts][0] : "<set>");
  const others = [...contexts].filter((c) => c !== name).sort();
  return { name, files: [...files].sort(), outgoing, incoming, others };
}

/** Renders the report the CLI prints. */
export function formatContextArrows(arrows: ContextArrows, all = false): string {
  const { name, outgoing, incoming, others } = arrows;
  const out: string[] = [`${name}: ${arrows.files.length} file(s)`, ""];

  const section = (title: string, map: Map<string, Crossing[]>) => {
    out.push(title);
    if (map.size === 0) out.push("  none");
    const byCount = [...map].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    for (const [context, crossings] of byCount) {
      const importers = new Set(crossings.map((c) => c.from)).size;
      out.push(`  ${context}: ${crossings.length} import(s) in ${importers} file(s)`);
      const shown = all ? crossings : crossings.slice(0, SITES_SHOWN);
      for (const c of shown) out.push(`    ${c.from}:${c.line} → ${c.to}`);
      if (shown.length < crossings.length)
        out.push(`    … ${crossings.length - shown.length} more`);
    }
    out.push("");
  };
  section(`What ${name} imports`, outgoing);
  section(`What imports ${name}`, incoming);

  const enforced = new Set(FORBIDDEN_DEPENDENCIES.map((d) => `${d.from}→${d.to}`));
  const proposals = (
    direction: (other: string) => [string, string],
    map: Map<string, Crossing[]>,
  ) => {
    const free: string[] = [];
    const blocked: string[] = [];
    for (const other of others) {
      const [from, to] = direction(other);
      if (enforced.has(`${from}→${to}`)) continue;
      const count = map.get(other)?.length ?? 0;
      if (count === 0) free.push(other);
      else blocked.push(`${other} (${count})`);
    }
    return { free, blocked };
  };
  const leaving = proposals((other) => [name, other], outgoing);
  const reaching = proposals((other) => [other, name], incoming);
  const list = (items: string[]) => (items.length > 0 ? items.join(", ") : "none");

  out.push("Rules that hold today, with no crossing to fix:");
  out.push(`  ${name} never imports: ${list(leaving.free)}`);
  out.push(`  never import ${name}: ${list(reaching.free)}`);
  out.push("Rules that hold once their crossings are fixed or listed:");
  out.push(`  ${name} never imports: ${list(leaving.blocked)}`);
  out.push(`  never import ${name}: ${list(reaching.blocked)}`);
  const existing = FORBIDDEN_DEPENDENCIES.filter((d) => d.from === name || d.to === name);
  if (existing.length > 0) {
    out.push("Rules already in lint/rules/contexts.ts:");
    for (const d of existing) out.push(`  ${d.from} never imports ${d.to}`);
  }
  return out.join("\n");
}

function main(argv: string[]): number {
  const all = argv.includes("--all");
  const asAt = argv.indexOf("--as");
  const as = asAt >= 0 ? argv[asAt + 1] : undefined;
  const paths = argv.filter((a, i) => !a.startsWith("--") && !(asAt >= 0 && i === asAt + 1));
  if (
    (paths.length === 0 && !as) ||
    (asAt >= 0 && (!as || as.startsWith("--") || as.includes("/")))
  ) {
    console.error("usage: pnpm context-arrows [--all] [--as <context>] <file or folder> [...]");
    return 2;
  }
  const core = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "core");
  const src = join(core, "src");
  // pnpm runs a root script from the repo root; INIT_CWD is where it was typed.
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const set: string[] = [];
  for (const path of paths) {
    const absolute = resolve(cwd, path);
    const inSrc = relative(src, absolute);
    if (!existsSync(absolute) || inSrc.startsWith("..") || inSrc === "") {
      console.error(`context-arrows: ${path} is not a file or folder under packages/core/src`);
      return 2;
    }
    set.push(inSrc.split(sep).join("/").replace(/\/$/, ""));
  }
  const arrows = contextArrows(scanImports(src, join(core, "tsconfig.json")), set, as);
  console.log(formatContextArrows(arrows, all));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
