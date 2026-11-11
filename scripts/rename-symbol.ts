#!/usr/bin/env tsx
/**
 * Rename a top-level declaration and every reference to it in its package,
 * with TypeScript's own rename, the one an editor runs.
 *
 *   pnpm rename-symbol [--dry] [--no-format] <file> <old> <new>
 *
 * The path is relative to the current directory. `<old>` is declared at the
 * top of `<file>`. The rename reaches every file the package's tsconfig
 * includes, follows imports and re-exports, and turns `{ old }` into
 * `{ old: new }` so an object key stays. Afterwards Biome formats every
 * changed file, unless `--no-format` is given.
 *
 * TypeScript does not check that the new name is free, so run the type check
 * afterwards: a clash shows up there as a duplicate or shadowed name.
 */

import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { biomeFormat, git } from "./move-files.js";
import {
  PREFERENCES,
  type PackageService,
  packageService,
  topLevelDeclarations,
} from "./ts-service.js";

/** Renames `from` to `to` in memory. Throws when TypeScript refuses the rename. */
export function renameSymbol(file: string, from: string, to: string): PackageService {
  const pkg = packageService(file);
  const text = pkg.text(file);
  if (text === undefined) throw new Error(`cannot read ${file}`);
  const name = topLevelDeclarations(file, text, [from]).nameOf.get(from) as ts.Identifier;
  const pos = name.getStart();
  const info = pkg.service.getRenameInfo(file, pos, PREFERENCES);
  if (!info.canRename) throw new Error(info.localizedErrorMessage);
  const locations = pkg.service.findRenameLocations(file, pos, false, true, PREFERENCES) ?? [];
  const byFile = new Map<string, ts.TextChange[]>();
  for (const loc of locations) {
    const changes = byFile.get(loc.fileName) ?? [];
    changes.push({
      span: loc.textSpan,
      newText: `${loc.prefixText ?? ""}${to}${loc.suffixText ?? ""}`,
    });
    byFile.set(loc.fileName, changes);
  }
  pkg.apply([...byFile].map(([fileName, textChanges]) => ({ fileName, textChanges })));
  return pkg;
}

function main(argv: string[]): void {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const dry = flags.delete("--dry");
  const format = !flags.delete("--no-format");
  const args = argv.filter((a) => !a.startsWith("--"));
  if (args.length !== 3 || flags.size > 0) {
    console.error("usage: pnpm rename-symbol [--dry] [--no-format] <file> <old> <new>");
    process.exit(2);
  }
  // pnpm runs a root script from the repo root; INIT_CWD is where it was typed.
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const repoRoot = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  const [file, from, to] = args;
  const pkg = renameSymbol(resolve(cwd, file), from, to);
  const changed = pkg.changed();
  if (!dry) {
    pkg.write();
    if (format && !biomeFormat(repoRoot, changed)) {
      console.log(
        "Biome could not run, so the changed files are not formatted. Run `biome check --write` on them.",
      );
    }
  }
  console.log(`${dry ? "Would rename" : "Renamed"} ${from} to ${to} in ${changed.length} files.`);
  for (const f of changed) console.log(`  ${relative(repoRoot, f)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
