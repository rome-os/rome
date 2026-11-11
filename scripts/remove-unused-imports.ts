#!/usr/bin/env tsx
/**
 * Remove the imports a file never uses.
 *
 *   pnpm remove-unused-imports [--dry] [--no-format] <file|folder> [...]
 *
 * Paths are relative to the current directory. A folder stands for every
 * tracked script under it. Afterwards Biome formats and sorts the imports of
 * every changed file, unless `--no-format` is given.
 *
 * A binding is used when an identifier anywhere else in the file, JSDoc
 * included, resolves to it, or when an `export { name }` re-exports it. A
 * declaration loses each unused binding, and goes away when none is left.
 * Side-effect imports (`import "./x.js"`) and `import x = require()` stay.
 * Each file is read alone, without its imports, so a big package costs a parse
 * per file and no type check.
 */

import { statSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { biomeFormat, git, trackedFiles } from "./move-files.js";

const SCRIPT = /\.[cm]?[jt]sx?$/;

export interface UnusedImportsPlan {
  /** New text for every file that loses an import, keyed by its absolute path. */
  edits: Map<string, string>;
  /** Number of bindings removed across `edits`. */
  removed: number;
}

/** A text replacement over [start, end). */
export interface Change {
  start: number;
  end: number;
  next: string;
}

/** `text` with `changes` applied. The changes must not overlap. */
export function applyChanges(text: string, changes: Change[]): string {
  let out = text;
  for (const c of [...changes].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, c.start) + c.next + out.slice(c.end);
  }
  return out;
}

/** Every identifier under `roots` outside import declarations, JSDoc included. */
export function identifiers(roots: readonly ts.Node[]): ts.Identifier[] {
  const out: ts.Identifier[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n)) return;
    if (ts.isIdentifier(n)) out.push(n);
    for (const doc of (n as { jsDoc?: ts.Node[] }).jsDoc ?? []) visit(doc);
    ts.forEachChild(n, visit);
  };
  for (const root of roots) visit(root);
  return out;
}

/** The symbol `id` names where it stands: for `{ x }` and `export { x }`, the local `x`. */
export function symbolOf(checker: ts.TypeChecker, id: ts.Identifier): ts.Symbol | undefined {
  const parent = id.parent;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === id) {
    return checker.getShorthandAssignmentValueSymbol(parent);
  }
  if (
    ts.isExportSpecifier(parent) &&
    !parent.parent.parent.moduleSpecifier &&
    (parent.propertyName ?? parent.name) === id
  ) {
    return checker.getExportSpecifierLocalTargetSymbol(parent);
  }
  return checker.getSymbolAtLocation(id);
}

/** The symbols named under `roots`, outside import declarations. */
export function referencedSymbols(
  checker: ts.TypeChecker,
  roots: readonly ts.Node[],
): Set<ts.Symbol> {
  const used = new Set<ts.Symbol>();
  for (const id of identifiers(roots)) {
    const s = symbolOf(checker, id);
    if (s) used.add(s);
  }
  return used;
}

/** A checker over `files` that reads no other file, not even the standard library. */
export function isolatedChecker(files: string[]): ts.Program {
  return ts.createProgram({
    rootNames: files,
    options: {
      noResolve: true,
      noLib: true,
      types: [],
      allowJs: true,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.Latest,
    },
  });
}

/**
 * The changes that drop every import binding of `sf` whose symbol `keep`
 * rejects, and how many bindings they drop.
 */
export function importRemovals(
  checker: ts.TypeChecker,
  sf: ts.SourceFile,
  keep: (binding: ts.Symbol) => boolean,
): { changes: Change[]; removed: number } {
  const text = sf.getFullText();
  const isUsed = (name: ts.Identifier): boolean => {
    const s = checker.getSymbolAtLocation(name);
    return s === undefined || keep(s);
  };
  const changes: Change[] = [];
  let removed = 0;
  for (const decl of sf.statements) {
    if (!ts.isImportDeclaration(decl) || !decl.importClause) continue;
    const clause = decl.importClause;
    const keepDefault = clause.name && isUsed(clause.name) ? clause.name : undefined;
    let named = "";
    let total = clause.name ? 1 : 0;
    let kept = keepDefault ? 1 : 0;
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      total++;
      if (isUsed(bindings.name)) {
        kept++;
        named = bindings.getText(sf);
      }
    } else if (bindings) {
      // `import {} from "x"` loads the module for its side effects, like `import "x"`.
      if (bindings.elements.length === 0 && !clause.name) continue;
      const elements = bindings.elements.filter((e) => isUsed(e.name));
      total += bindings.elements.length;
      kept += elements.length;
      if (elements.length > 0) named = `{ ${elements.map((e) => e.getText(sf)).join(", ")} }`;
    }
    if (kept === total) continue;
    removed += total - kept;
    if (kept === 0) {
      let end = decl.getEnd();
      if (text[end] === "\n") end++;
      changes.push({ start: decl.getStart(sf), end, next: "" });
      continue;
    }
    const parts = [keepDefault?.text, named].filter(Boolean).join(", ");
    const typeOnly = clause.isTypeOnly ? "type " : "";
    // The specifier and anything after it (`with { type: "json" }`, `;`) stay as written.
    const tail = text.slice(decl.moduleSpecifier.getStart(sf), decl.getEnd());
    changes.push({
      start: decl.getStart(sf),
      end: decl.getEnd(),
      next: `import ${typeOnly}${parts} from ${tail}`,
    });
  }
  return { changes, removed };
}

/** Plans the removals without touching the disk. `files` are absolute paths of scripts. */
export function planUnusedImports(files: string[]): UnusedImportsPlan {
  const program = isolatedChecker(files);
  const checker = program.getTypeChecker();
  const edits = new Map<string, string>();
  let removed = 0;
  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) throw new Error(`cannot read ${file}`);
    const used = referencedSymbols(checker, [sf]);
    const result = importRemovals(checker, sf, (s) => used.has(s));
    if (result.removed === 0) continue;
    edits.set(file, applyChanges(sf.getFullText(), result.changes));
    removed += result.removed;
  }
  return { edits, removed };
}

/** The tracked scripts a path names: the file itself, or every one under a folder. */
export function scriptsUnder(repoRoot: string, path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return trackedFiles(repoRoot, [path]).filter((f) => SCRIPT.test(f) && !f.endsWith(".d.ts"));
}

function main(argv: string[]): void {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const dry = flags.delete("--dry");
  const format = !flags.delete("--no-format");
  const paths = argv.filter((a) => !a.startsWith("--"));
  if (paths.length === 0 || flags.size > 0) {
    console.error("usage: pnpm remove-unused-imports [--dry] [--no-format] <file|folder> [...]");
    process.exit(2);
  }
  // pnpm runs a root script from the repo root; INIT_CWD is where it was typed.
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const repoRoot = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  const files = [...new Set(paths.flatMap((p) => scriptsUnder(repoRoot, resolve(cwd, p))))];
  const plan = planUnusedImports(files);
  if (!dry) {
    for (const [file, text] of plan.edits) writeFileSync(file, text);
    if (format && !biomeFormat(repoRoot, [...plan.edits.keys()])) {
      console.log(
        "Biome could not run, so the changed files are not formatted. Run `biome check --write` on them.",
      );
    }
  }
  console.log(
    `${dry ? "Would remove" : "Removed"} ${plan.removed} unused imports in ${plan.edits.size} of ${files.length} files.`,
  );
  for (const file of plan.edits.keys()) console.log(`  ${relative(repoRoot, file)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
