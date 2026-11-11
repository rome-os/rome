#!/usr/bin/env tsx
/**
 * Move top-level declarations from one file to another inside one package,
 * with TypeScript's own "Move to file" refactor, the one an editor runs.
 *
 *   pnpm move-symbol [--dry] [--no-format] <from> <to> <name> [<name> ...]
 *
 * Paths are relative to the current directory, and `<to>` may be a new file.
 * TypeScript moves each declaration with its comments, brings the imports it
 * uses, exports from `<from>` what the moved code still needs there, and
 * rewrites every import of the moved names in the files the package's
 * tsconfig includes. TypeScript spells a rewritten import through the
 * package's `@/` alias, which the build keeps as written and Node cannot
 * resolve, so each new `@/` import is respelled relative. Afterwards Biome
 * formats every changed file, unless `--no-format` is given.
 */

import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { biomeFormat, git } from "./move-files.js";
import {
  declaredNames,
  PREFERENCES,
  type PackageService,
  packageService,
  relativeAliases,
  topLevelDeclarations,
} from "./ts-service.js";

const MOVE = "Move to file";

/** Moves `names` from `from` to `to` in memory. Throws when TypeScript cannot move one. */
export function moveSymbol(from: string, to: string, names: string[]): PackageService {
  if (names.length === 0) throw new Error("no names given");
  if (resolve(from) === resolve(to)) throw new Error("<from> and <to> are the same file");
  const pkg = packageService(from);
  const created = !existsSync(to);
  const before = new Map<string, string | undefined>();
  const remember = (edits: readonly ts.FileTextChanges[]): void => {
    for (const e of edits)
      if (!before.has(e.fileName)) before.set(e.fileName, pkg.text(e.fileName));
  };
  const textOf = (): string => {
    const t = pkg.text(from);
    if (t === undefined) throw new Error(`cannot read ${from}`);
    return t;
  };
  // Every name must be there before anything moves.
  topLevelDeclarations(from, textOf(), names);
  const format = ts.getDefaultFormatCodeSettings();
  // TypeScript moves one range of statements, so the named ones first
  // gather, in file order, where the first of them stands.
  const original = textOf();
  before.set(from, original);
  const sf = ts.createSourceFile(from, original, ts.ScriptTarget.Latest, true);
  const picked = (s: ts.Statement): boolean => declaredNames(s).some((n) => names.includes(n.text));
  const chosen = sf.statements.filter(picked);
  const gathered = sf.statements
    .flatMap((s) => (s === chosen[0] ? chosen : picked(s) ? [] : [s]))
    .map((s) => s.getFullText(sf))
    .join("");
  pkg.set(from, gathered + original.slice(sf.statements[sf.statements.length - 1].getEnd()));
  const moved = ts
    .createSourceFile(from, textOf(), ts.ScriptTarget.Latest, true)
    .statements.filter(picked);
  const range = { pos: moved[0].getStart(), end: moved[moved.length - 1].getEnd() };
  const result = pkg.service.getEditsForRefactor(from, format, range, MOVE, MOVE, PREFERENCES, {
    targetFile: to,
  });
  if (!result || result.edits.length === 0)
    throw new Error(`TypeScript cannot move ${names.join(", ")}`);
  remember(result.edits);
  pkg.apply(result.edits);
  for (const f of pkg.changed()) {
    pkg.set(f, relativeAliases(f, pkg.text(f) ?? "", before.get(f) ?? "", pkg.pkgDir));
  }
  if (created) pkg.set(to, tidyNewFile(pkg.text(to) ?? ""));
  return pkg;
}

/**
 * TypeScript prints a new file with a blank line under each doc comment and
 * none between declarations. This puts the comment back on its declaration
 * and a blank line between top-level declarations; Biome does the rest.
 */
export function tidyNewFile(text: string): string {
  return text
    .replace(/(\*\/)[ \t]*\n\n+(?=\S)/g, "$1\n")
    .replace(
      /([;}])\n(?=\/\*\*|export |declare |interface |type |function |const |let |class |enum )/g,
      "$1\n\n",
    );
}

function main(argv: string[]): void {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const dry = flags.delete("--dry");
  const format = !flags.delete("--no-format");
  const [from, to, ...names] = argv.filter((a) => !a.startsWith("--"));
  if (!from || !to || names.length === 0 || flags.size > 0) {
    console.error("usage: pnpm move-symbol [--dry] [--no-format] <from> <to> <name> [<name> ...]");
    process.exit(2);
  }
  // pnpm runs a root script from the repo root; INIT_CWD is where it was typed.
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const repoRoot = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  const pkg = moveSymbol(resolve(cwd, from), resolve(cwd, to), names);
  const changed = pkg.changed();
  if (!dry) {
    pkg.write();
    if (format && !biomeFormat(repoRoot, changed)) {
      console.log(
        "Biome could not run, so the changed files are not formatted. Run `biome check --write` on them.",
      );
    }
  }
  console.log(
    `${dry ? "Would move" : "Moved"} ${names.join(", ")} to ${relative(repoRoot, resolve(cwd, to))}, changing ${changed.length} files.`,
  );
  for (const f of changed) console.log(`  ${relative(repoRoot, f)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
