#!/usr/bin/env tsx
/**
 * Rename a top-level declaration and every reference to it in its package,
 * with TypeScript's own rename, the one an editor runs.
 *
 *   pnpm rename-symbol [--dry] [--no-format] <file> <old> <new>
 *
 * The path is relative to the current directory. `<old>` is declared at the
 * top of `<file>`. The rename reaches every file the package's tsconfig
 * includes, follows imports and re-exports, barrels included, and turns
 * `{ old }` into `{ old: new }` so an object key stays. It leaves comments
 * alone. Afterwards Biome formats every changed file, unless `--no-format` is
 * given.
 *
 * The rename refuses a new name that already means something where the old
 * one is written, a global such as `fetch` included, because there the new
 * name would capture or shadow it and the type check need not notice.
 */

import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { biomeFormat, git } from "./move-files.js";
import {
  identifierAt,
  type PackageService,
  packageService,
  refuseCleanly,
  topLevelDeclarations,
} from "./ts-service.js";

const ANY_MEANING = ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace;

/**
 * Renames `from` to `to` in memory. Throws when TypeScript refuses the rename,
 * or when `to` already resolves to something at one of the places it would be
 * written.
 */
export function renameSymbol(file: string, from: string, to: string): PackageService {
  if (!isName(to)) throw new Error(`${to} is not a name`);
  const pkg = packageService(file);
  const text = pkg.text(file);
  if (text === undefined) throw new Error(`cannot read ${file}`);
  const name = topLevelDeclarations(file, text, [from]).nameOf.get(from) as ts.Identifier;
  const pos = name.getStart();
  const info = pkg.service.getRenameInfo(file, pos, pkg.preferences);
  if (!info.canRename) throw new Error(info.localizedErrorMessage);
  // Without prefix and suffix text the rename runs through every re-export,
  // where with it TypeScript would write `export { new as old }` and stop.
  // The one place that loses is a shorthand property, handled below.
  const locations =
    pkg.service.findRenameLocations(file, pos, false, false, {
      ...pkg.preferences,
      providePrefixAndSuffixTextForRename: false,
    }) ?? [];
  const program = pkg.service.getProgram();
  if (!program) throw new Error(`cannot build the program for ${file}`);
  const checker = program.getTypeChecker();
  const byFile = new Map<string, ts.TextChange[]>();
  for (const loc of locations) {
    const sf = program.getSourceFile(loc.fileName);
    const id = sf && identifierAt(sf, loc.textSpan.start);
    if (!sf || !id) throw new Error(`cannot find ${from} at ${loc.fileName}:${loc.textSpan.start}`);
    if (bindsInScope(id) && checker.resolveName(to, id, ANY_MEANING, false)) {
      const { line } = sf.getLineAndCharacterOfPosition(loc.textSpan.start);
      throw new Error(`${to} already means something at ${loc.fileName}:${line + 1}`);
    }
    const shorthand = ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id;
    const changes = byFile.get(loc.fileName) ?? [];
    changes.push({ span: loc.textSpan, newText: shorthand ? `${from}: ${to}` : to });
    byFile.set(loc.fileName, changes);
  }
  pkg.apply([...byFile].map(([fileName, textChanges]) => ({ fileName, textChanges })));
  return pkg;
}

/** Whether `text` parses as one identifier, which a keyword does not. */
function isName(text: string): boolean {
  const sf = ts.createSourceFile("name.ts", `${text};`, ts.ScriptTarget.Latest);
  const [stmt] = sf.statements;
  return (
    sf.statements.length === 1 &&
    ts.isExpressionStatement(stmt) &&
    ts.isIdentifier(stmt.expression) &&
    stmt.expression.text === text &&
    ts.identifierToKeywordKind(stmt.expression) === undefined
  );
}

/**
 * Whether the renamed identifier is looked up in the scope it sits in. A
 * member name after a dot, the outer name of `import { old as x }`, and a
 * name re-exported from another module are not, so a binding of the new name
 * there cannot clash.
 */
function bindsInScope(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isQualifiedName(p) && p.right === id) return false;
  if (ts.isImportSpecifier(p) && p.propertyName === id) return false;
  if (ts.isExportSpecifier(p)) {
    if (p.parent.parent.moduleSpecifier) return false;
    return p.propertyName === undefined || p.propertyName === id;
  }
  return true;
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
  const pkg = refuseCleanly(() => renameSymbol(resolve(cwd, file), from, to));
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
