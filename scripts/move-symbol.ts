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
 * tsconfig includes. An `export *` barrel of `<from>` gains an explicit
 * re-export of the moved names from `<to>`, since TypeScript leaves it be. In
 * a package Node runs, TypeScript spells a rewritten import through the `@/`
 * alias, which the build keeps as written and Node cannot resolve, so each
 * new `@/` import is respelled relative. Afterwards Biome formats every
 * changed file, unless `--no-format` is given.
 *
 * The move then lists what it leaves for a person: module mocks of `<from>`,
 * which no longer reach the moved names, namespace re-exports of `<from>`,
 * and `<from>` and `<to>` importing each other, which typechecks but can
 * throw at load time when a top-level value is read across the pair.
 */

import { existsSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { biomeFormat, git, toPosix } from "./move-files.js";
import {
  declaredNames,
  type PackageService,
  packageService,
  refuseCleanly,
  relativeAliases,
  topLevelDeclarations,
} from "./ts-service.js";

const MOVE = "Move to file";

export interface MoveResult extends PackageService {
  /** What the move leaves for a person to check, one line each. */
  review: string[];
}

/** Moves `names` from `from` to `to` in memory. Throws when TypeScript cannot move one. */
export function moveSymbol(from: string, to: string, names: string[]): MoveResult {
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
  const exported = chosen.filter(isNamedExport);
  const gathered = sf.statements
    .flatMap((s) => (s === chosen[0] ? chosen : picked(s) ? [] : [s]))
    .map((s) => s.getFullText(sf))
    .join("");
  pkg.set(from, gathered + original.slice(sf.statements[sf.statements.length - 1].getEnd()));
  const moved = ts
    .createSourceFile(from, textOf(), ts.ScriptTarget.Latest, true)
    .statements.filter(picked);
  const range = { pos: moved[0].getStart(), end: moved[moved.length - 1].getEnd() };
  const result = pkg.service.getEditsForRefactor(from, format, range, MOVE, MOVE, pkg.preferences, {
    targetFile: to,
  });
  if (!result || result.edits.length === 0)
    throw new Error(`TypeScript cannot move ${names.join(", ")}`);
  remember(result.edits);
  pkg.apply(result.edits);
  if (!pkg.bundled) {
    for (const f of pkg.changed()) {
      pkg.set(f, relativeAliases(f, pkg.text(f) ?? "", before.get(f) ?? "", pkg.pkgDir));
    }
  }
  if (created) pkg.set(to, tidyNewFile(to, pkg.text(to) ?? ""));
  const review = repairBarrels(pkg, from, to, exported);
  review.push(...leftovers(pkg, from, to));
  return Object.assign(pkg, { review });
}

/** Whether a statement carries `export` and not `export default`. */
function isNamedExport(stmt: ts.Statement): boolean {
  const mods = ts.canHaveModifiers(stmt) ? (ts.getModifiers(stmt) ?? []) : [];
  return (
    mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
    !mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
  );
}

/** The package's own source files, with the edits so far. */
function packageFiles(pkg: PackageService): ts.SourceFile[] {
  const program = pkg.service.getProgram();
  if (!program) throw new Error("cannot build the program");
  return program
    .getSourceFiles()
    .filter(
      (f) => f.fileName.startsWith(pkg.pkgDir + sep) && !f.fileName.includes("/node_modules/"),
    )
    .filter((f) => !f.isDeclarationFile);
}

/**
 * Adds to each `export * from "<from>"` barrel a re-export of the moved names
 * from `<to>`, unless the barrel already exports them. Returns a review line
 * for each `export * as ns from "<from>"`, whose users this cannot reach.
 */
function repairBarrels(
  pkg: PackageService,
  from: string,
  to: string,
  exported: ts.Statement[],
): string[] {
  const values: string[] = [];
  const types: string[] = [];
  for (const stmt of exported) {
    const typeOnly = ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt);
    for (const n of declaredNames(stmt)) (typeOnly ? types : values).push(n.text);
  }
  const review: string[] = [];
  if (values.length + types.length === 0) return review;
  for (const sf of packageFiles(pkg)) {
    if (sf.fileName === from || sf.fileName === to) continue;
    const reaches = (d: ts.ExportDeclaration, target: string): boolean =>
      d.moduleSpecifier !== undefined &&
      ts.isStringLiteral(d.moduleSpecifier) &&
      pkg.resolveImport(d.moduleSpecifier.text, sf.fileName) === target;
    const exports = sf.statements.filter(ts.isExportDeclaration);
    const star = exports.find((d) => !d.exportClause && reaches(d, from));
    for (const d of exports) {
      if (d.exportClause && ts.isNamespaceExport(d.exportClause) && reaches(d, from)) {
        review.push(
          `${sf.fileName}: re-exports ${from} as a namespace; its users still look for ${[...values, ...types].join(", ")} there`,
        );
      }
    }
    if (!star || exports.some((d) => !d.exportClause && reaches(d, to))) continue;
    const named = new Set(
      exports.flatMap((d) =>
        d.exportClause && ts.isNamedExports(d.exportClause)
          ? d.exportClause.elements.map((e) => e.name.text)
          : [],
      ),
    );
    const spec = (star.moduleSpecifier as ts.StringLiteral).text;
    const ending = spec.match(/\.[cm]?js$/)?.[0] ?? "";
    let rel = toPosix(relative(dirname(sf.fileName), to)).replace(/\.[cm]?tsx?$/, ending);
    if (!rel.startsWith(".")) rel = `./${rel}`;
    const lines = [
      [values.filter((n) => !named.has(n)), "export"],
      [types.filter((n) => !named.has(n)), "export type"],
    ]
      .filter(([ns]) => ns.length > 0)
      .map(([ns, kw]) => `\n${kw} { ${(ns as string[]).join(", ")} } from "${rel}";`);
    if (lines.length === 0) continue;
    const text = sf.getFullText();
    pkg.set(sf.fileName, text.slice(0, star.getEnd()) + lines.join("") + text.slice(star.getEnd()));
  }
  return review;
}

/** Module mocks of `<from>`, and an import cycle between `<from>` and `<to>`. */
function leftovers(pkg: PackageService, from: string, to: string): string[] {
  const review: string[] = [];
  const mock = /\b(?:rs|vi|jest)\.(?:do)?[mM]ock\(\s*["'`]([^"'`]+)["'`]/g;
  for (const sf of packageFiles(pkg)) {
    const text = sf.getFullText();
    for (const m of text.matchAll(mock)) {
      if (pkg.resolveImport(m[1], sf.fileName) !== from) continue;
      const { line } = sf.getLineAndCharacterOfPosition(m.index ?? 0);
      review.push(
        `${sf.fileName}:${line + 1}: mocks ${from}, which no longer holds the moved names`,
      );
    }
  }
  const program = pkg.service.getProgram();
  const checker = program?.getTypeChecker();
  // Only an import of a value runs at load time; a type import is erased.
  const importsValue = (a: string, b: string): boolean => {
    const sf = program?.getSourceFile(a);
    if (!sf || !checker) return false;
    return sf.statements.some((stmt) => {
      if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) return false;
      if (pkg.resolveImport(stmt.moduleSpecifier.text, a) !== b) return false;
      const clause = stmt.importClause;
      if (!clause) return true;
      if (clause.isTypeOnly) return false;
      const names: ts.Identifier[] = [];
      if (clause.name) names.push(clause.name);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const e of bindings.elements) if (!e.isTypeOnly) names.push(e.name);
      }
      return names.some((n) => {
        const local = checker.getSymbolAtLocation(n);
        if (!local) return true;
        const target = local.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(local) : local;
        return (target.flags & ts.SymbolFlags.Value) !== 0;
      });
    });
  };
  if (importsValue(from, to) && importsValue(to, from)) {
    review.push(
      `${from} and ${to} import each other; a top-level value read across them throws at load time`,
    );
  }
  return review;
}

/**
 * TypeScript prints a new file with a blank line under each doc comment and
 * none between declarations. This rewrites only the whitespace between
 * top-level statements: each comment sits on its declaration, and a blank
 * line separates declarations other than consecutive imports.
 */
export function tidyNewFile(file: string, text: string): string {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let out = text;
  const stmts = sf.statements;
  for (let i = stmts.length - 1; i >= 0; i--) {
    const stmt = stmts[i];
    const start = stmt.getStart(sf);
    let gapStart = 0;
    if (i > 0) {
      // A comment on the line of the statement before stays where it is.
      const newline = text.indexOf("\n", stmt.pos);
      if (newline === -1 || newline >= start) continue;
      gapStart = newline + 1;
    }
    const comments = (ts.getLeadingCommentRanges(text, gapStart) ?? []).filter(
      (c) => c.end <= start,
    );
    const imports = i > 0 && ts.isImportDeclaration(stmt) && ts.isImportDeclaration(stmts[i - 1]);
    const lead = i === 0 || imports ? "" : "\n";
    const body =
      comments.length === 0
        ? ""
        : `${text.slice(comments[0].pos, comments[comments.length - 1].end)}\n`;
    out = out.slice(0, gapStart) + lead + body + out.slice(start);
  }
  return out;
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
  const pkg = refuseCleanly(() => moveSymbol(resolve(cwd, from), resolve(cwd, to), names));
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
  if (pkg.review.length > 0) {
    console.log("Check by hand:");
    for (const line of pkg.review) console.log(`  ${line.replaceAll(`${repoRoot}/`, "")}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
