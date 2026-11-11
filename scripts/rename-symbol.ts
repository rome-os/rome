#!/usr/bin/env tsx
/**
 * Rename a top-level declaration and every reference to it across the repo.
 *
 *   pnpm rename-symbol [--dry] [--no-format] <file> <old> <new>
 *
 * The path is relative to the current directory. `<old>` is a function,
 * class, interface, type alias, enum, namespace or variable declared at the
 * top of `<file>`. Afterwards Biome formats every changed file, unless
 * `--no-format` is given.
 *
 * Inside `<file>`, every identifier that resolves to the declaration takes the
 * new name, JSDoc `{@link}` included, and `{ old }` in an object literal
 * becomes `{ old: new }` so the key stays. Across the repo, a file whose
 * import resolves to `<file>`, by relative path or the package's `@/` alias,
 * changes the same way: `import { old }` renames the binding and its uses,
 * `import { old as x }` renames only the imported name, and `ns.old` follows a
 * namespace import. A re-export (`export { old } from`, `export *`, or
 * `export { old }` of an imported binding) carries the rename on to the
 * importers of the re-exporting file. `import("…").old` types follow too.
 *
 * It refuses when a file that would take the new name already declares it
 * anywhere, so a rename never captures or shadows another binding. An
 * `import()` call, a module mock and `export * as ns` of a renamed module may
 * reach the old name; the script lists each one for a person to check.
 */

import { writeFileSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  biomeFormat,
  git,
  moduleSpecifiers,
  readPackage,
  TS_EXTENSION,
  trackedFiles,
} from "./move-files.js";
import { declaredNames, lineOf } from "./move-symbol.js";
import {
  applyChanges,
  type Change,
  identifiers,
  isolatedChecker,
  symbolOf,
} from "./remove-unused-imports.js";

export interface Rename {
  /** Absolute path of the file that declares the name. */
  file: string;
  from: string;
  to: string;
}

export interface RenamePlan {
  /** New text for every file that changes, keyed by absolute path. */
  edits: Map<string, string>;
  /** `file:line: text` for each place that may reach the old name and was left alone. */
  review: string[];
}

const SCRIPTS = ["*.ts", "*.tsx", "*.mts", "*.cts", "*.mjs", "*.cjs", "*.js"];
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Whether anything in `sf` declares `name`, at any depth. */
function declares(sf: ts.SourceFile, name: string): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    const declName = (n as { name?: ts.Node }).name;
    if (
      declName &&
      ts.isIdentifier(declName) &&
      declName.text === name &&
      (ts.isVariableDeclaration(n) ||
        ts.isParameter(n) ||
        ts.isBindingElement(n) ||
        ts.isFunctionDeclaration(n) ||
        ts.isFunctionExpression(n) ||
        ts.isClassDeclaration(n) ||
        ts.isClassExpression(n) ||
        ts.isInterfaceDeclaration(n) ||
        ts.isTypeAliasDeclaration(n) ||
        ts.isEnumDeclaration(n) ||
        ts.isModuleDeclaration(n) ||
        ts.isTypeParameterDeclaration(n) ||
        ts.isImportSpecifier(n) ||
        ts.isImportClause(n) ||
        ts.isNamespaceImport(n) ||
        ts.isImportEqualsDeclaration(n))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/**
 * Plans the rename without touching the disk. Throws when `<old>` is not a
 * top-level declaration of the file, or a file that would take the new name
 * already declares it.
 */
export function planRename(repoRoot: string, rename: Rename): RenamePlan {
  const { file, from, to } = rename;
  if (!IDENTIFIER.test(to)) throw new Error(`${to} is not an identifier`);
  if (from === to) throw new Error("the old and new names are the same");
  const { pkgDir, parsed } = readPackage(file);
  const inPackage = (f: string): boolean => f.startsWith(pkgDir + sep);
  if (trackedFiles(repoRoot, [file]).length === 0) throw new Error(`${file} is not tracked`);
  const cache = ts.createModuleResolutionCache(pkgDir, (s) => s, parsed.options);
  const resolveSpec = (spec: string, importer: string): string | undefined => {
    const alias = spec.startsWith("@/") && inPackage(importer);
    if (!spec.startsWith(".") && !alias) return undefined;
    const hit = ts.resolveModuleName(spec, importer, parsed.options, ts.sys, cache).resolvedModule;
    return hit ? resolve(hit.resolvedFileName) : undefined;
  };

  const changes = new Map<string, Map<number, Change>>();
  const change = (path: string, node: ts.Node, sf: ts.SourceFile, next: string): void => {
    let byStart = changes.get(path);
    if (!byStart) changes.set(path, (byStart = new Map()));
    const start = node.getStart(sf);
    byStart.set(start, { start, end: node.getEnd(), next });
  };
  const sources = new Map<string, ts.SourceFile>();
  const parse = (path: string): ts.SourceFile => {
    let sf = sources.get(path);
    if (!sf) {
      sf = ts.createSourceFile(path, ts.sys.readFile(path) ?? "", ts.ScriptTarget.Latest, true);
      sources.set(path, sf);
    }
    return sf;
  };
  const refuseClash = (path: string, sf: ts.SourceFile): void => {
    if (declares(sf, to)) throw new Error(`${relative(repoRoot, path)} already declares ${to}`);
  };
  /** The modules whose export named `from` is renamed, still to visit. */
  const queue: string[] = [];
  const queued = new Set<string>();
  const enqueue = (path: string): void => {
    if (queued.has(path)) return;
    queued.add(path);
    queue.push(path);
  };

  /**
   * Renames every use of `symbol` in `path`. An `export { from }` of it
   * renames the file's own export, so the file's importers follow.
   */
  const renameUses = (
    path: string,
    checker: ts.TypeChecker,
    sf: ts.SourceFile,
    symbol: ts.Symbol,
  ) => {
    refuseClash(path, sf);
    for (const id of identifiers([sf])) {
      if (symbolOf(checker, id) !== symbol) continue;
      const parent = id.parent;
      if (ts.isShorthandPropertyAssignment(parent)) {
        change(path, id, sf, `${from}: ${to}`);
      } else if (ts.isExportSpecifier(parent) && !parent.propertyName) {
        change(path, id, sf, to);
        enqueue(path);
      } else {
        change(path, id, sf, to);
      }
    }
  };

  // The declaring file.
  {
    const program = isolatedChecker([file]);
    const checker = program.getTypeChecker();
    const sf = program.getSourceFile(file);
    if (!sf) throw new Error(`cannot read ${file}`);
    sources.set(file, sf);
    const name = sf.statements.flatMap(declaredNames).find((n) => n.text === from);
    const symbol = name && checker.getSymbolAtLocation(name);
    if (!symbol)
      throw new Error(`${from} is not declared at the top of ${relative(repoRoot, file)}`);
    renameUses(file, checker, sf, symbol);
    const exported = sf.statements.some(
      (s) =>
        declaredNames(s).includes(name) &&
        ts.canHaveModifiers(s) &&
        (ts.getModifiers(s) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
    );
    if (exported) enqueue(file);
  }

  // Each module that exports the old name, and the files that import it from there.
  const review: string[] = [];
  const scripts = trackedFiles(repoRoot, SCRIPTS);
  while (queue.length > 0) {
    const module = queue.shift() as string;
    const stem = basename(module).replace(TS_EXTENSION, "");
    for (const path of scripts) {
      if (path === module) continue;
      const text = sources.get(path)?.getFullText() ?? ts.sys.readFile(path);
      if (!text?.includes(stem)) continue;
      const sf = parse(path);
      let checker: ts.TypeChecker | undefined;
      const checkerFor = (): ts.TypeChecker => {
        if (!checker) {
          const program = isolatedChecker([path]);
          checker = program.getTypeChecker();
          // The checker's own parse of the same text, so its nodes match.
          sources.set(path, program.getSourceFile(path) as ts.SourceFile);
        }
        return checker;
      };
      for (const lit of moduleSpecifiers(sf)) {
        if (resolveSpec(lit.text, path) !== module) continue;
        const decl = lit.parent;
        const where = `${relative(repoRoot, path)}:${lineOf(sf, lit.getStart(sf))}`;
        if (ts.isImportDeclaration(decl)) {
          const bindings = decl.importClause?.namedBindings;
          if (!bindings) continue;
          // Reparse through the checker so nodes and symbols agree.
          const c = checkerFor();
          const csf = sources.get(path) as ts.SourceFile;
          const cdecl = csf.statements.find(
            (s) => ts.isImportDeclaration(s) && s.getStart(csf) === decl.getStart(sf),
          ) as ts.ImportDeclaration;
          const cb = cdecl.importClause?.namedBindings;
          if (!cb) continue;
          if (ts.isNamespaceImport(cb)) {
            const ns = c.getSymbolAtLocation(cb.name);
            const visit = (n: ts.Node): void => {
              const access =
                (ts.isPropertyAccessExpression(n) &&
                  ts.isIdentifier(n.expression) &&
                  n.expression) ||
                (ts.isQualifiedName(n) && ts.isIdentifier(n.left) && n.left);
              const member = ts.isPropertyAccessExpression(n)
                ? n.name
                : ts.isQualifiedName(n)
                  ? n.right
                  : undefined;
              if (
                access &&
                member &&
                member.text === from &&
                c.getSymbolAtLocation(access) === ns
              ) {
                change(path, member, csf, to);
              }
              ts.forEachChild(n, visit);
            };
            visit(csf);
            continue;
          }
          for (const e of cb.elements) {
            if ((e.propertyName ?? e.name).text !== from) continue;
            if (e.propertyName) {
              change(path, e.propertyName, csf, to);
            } else {
              const symbol = c.getSymbolAtLocation(e.name);
              change(path, e.name, csf, to);
              if (symbol) renameUses(path, c, csf, symbol);
            }
          }
        } else if (ts.isExportDeclaration(decl)) {
          const clause = decl.exportClause;
          if (!clause) {
            enqueue(path);
          } else if (ts.isNamespaceExport(clause)) {
            review.push(`${where} (namespace export)`);
          } else {
            for (const e of clause.elements) {
              if ((e.propertyName ?? e.name).text !== from) continue;
              if (e.propertyName) {
                change(path, e.propertyName, sf, to);
              } else {
                refuseClash(path, sf);
                change(path, e.name, sf, to);
                enqueue(path);
              }
            }
          }
        } else if (ts.isLiteralTypeNode(decl) && ts.isImportTypeNode(decl.parent)) {
          let q = decl.parent.qualifier;
          while (q && ts.isQualifiedName(q)) q = q.left;
          if (q && q.text === from) change(path, q, sf, to);
        } else {
          review.push(where);
        }
      }
    }
  }

  const edits = new Map<string, string>();
  for (const [path, byStart] of changes) {
    const text = (sources.get(path) as ts.SourceFile).getFullText();
    edits.set(path, applyChanges(text, [...byStart.values()]));
  }
  return { edits, review };
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
  const plan = planRename(repoRoot, { file: resolve(cwd, file), from, to });
  if (!dry) {
    for (const [path, text] of plan.edits) writeFileSync(path, text);
    if (format && !biomeFormat(repoRoot, [...plan.edits.keys()])) {
      console.log(
        "Biome could not run, so the changed files are not formatted. Run `biome check --write` on them.",
      );
    }
  }
  console.log(`${dry ? "Would rename" : "Renamed"} ${from} to ${to} in ${plan.edits.size} files.`);
  for (const path of plan.edits.keys()) console.log(`  ${relative(repoRoot, path)}`);
  if (plan.review.length > 0) {
    console.log(`\nThese lines reach a renamed module and may use ${from}. Check them by hand:`);
    for (const r of plan.review) console.log(`  ${r}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
