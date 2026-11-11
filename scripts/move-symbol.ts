#!/usr/bin/env tsx
/**
 * Move top-level declarations from one file to another inside one TypeScript
 * package, and rewrite every import that names them.
 *
 *   pnpm move-symbol [--dry] [--no-format] <from> <to> <name> [<name> ...]
 *
 * Paths are relative to the current directory. `<to>` may be a new file. Each
 * name is a function (with its overloads), class, interface, type alias, enum,
 * namespace or `const`/`let`/`var` declared at the top of `<from>`. A variable
 * statement that declares several names moves whole, so name all of them. The
 * declarations move with the comments directly above them, land at the end of
 * `<to>` exported, and bring along the imports they use. Afterwards Biome
 * formats and sorts the imports of every touched file, unless `--no-format` is
 * given.
 *
 * A moved declaration may use another top-level declaration of `<from>` only
 * when that one is exported: `<to>` then imports it. When `<from>` still uses a
 * moved name, `<from>` imports it from `<to>`. The imports only the moved code
 * used leave `<from>`.
 *
 * Across the repo, each `import { name }` and `export { name } from` that
 * resolves to `<from>`, by relative path or by the package's `@/` alias, splits
 * so the moved names come from `<to>`, keeping the specifier's ending. A barrel
 * with `export * from "<from>"` gains `export { name } from "<to>"`, and an
 * `import("<from>").name` type follows the name. A namespace import, an
 * `import()` call and a module mock of `<from>` might reach a moved name too;
 * the script lists each one for a person to check.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  biomeFormat,
  git,
  moduleSpecifiers,
  readPackage,
  TS_EXTENSION,
  toPosix,
  trackedFiles,
} from "./move-files.js";
import {
  applyChanges,
  type Change,
  identifiers,
  importRemovals,
  isolatedChecker,
  symbolOf,
} from "./remove-unused-imports.js";

export interface SymbolMove {
  /** Absolute path of the file the declarations leave. */
  from: string;
  /** Absolute path of the file they land in. It may not exist yet. */
  to: string;
  names: string[];
}

export interface SymbolPlan {
  /** New text for every file that changes, `to` included, keyed by absolute path. */
  edits: Map<string, string>;
  /** Whether `to` is a new file. */
  created: boolean;
  /** Number of import and export declarations rewritten outside `from` and `to`. */
  rewritten: number;
  /** `file:line: text` for each place that may reach a moved name and was left alone. */
  review: string[];
}

const SCRIPTS = ["*.ts", "*.tsx", "*.mts", "*.cts", "*.mjs", "*.cjs", "*.js"];

/** The names a top-level statement declares. */
export function declaredNames(stmt: ts.Statement): ts.Identifier[] {
  if (
    (ts.isFunctionDeclaration(stmt) ||
      ts.isClassDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt) ||
      ts.isModuleDeclaration(stmt)) &&
    stmt.name &&
    ts.isIdentifier(stmt.name)
  ) {
    return [stmt.name];
  }
  if (ts.isVariableStatement(stmt)) {
    const out: ts.Identifier[] = [];
    const collect = (name: ts.BindingName): void => {
      if (ts.isIdentifier(name)) out.push(name);
      else for (const e of name.elements) if (!ts.isOmittedExpression(e)) collect(e.name);
    };
    for (const d of stmt.declarationList.declarations) collect(d.name);
    return out;
  }
  return [];
}

const hasModifier = (stmt: ts.Statement, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(stmt) && (ts.getModifiers(stmt) ?? []).some((m) => m.kind === kind);

/** Whether a declaration of this kind names only a type. */
const isTypeOnly = (stmt: ts.Statement): boolean =>
  ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt);

/** Where `stmt` starts once the comments directly above it, with no blank line between, count. */
function startWithComments(sf: ts.SourceFile, stmt: ts.Statement): number {
  const text = sf.getFullText();
  let start = stmt.getStart(sf);
  const comments = ts.getLeadingCommentRanges(text, stmt.getFullStart()) ?? [];
  for (let i = comments.length - 1; i >= 0; i--) {
    if (/\n[ \t]*\r?\n/.test(text.slice(comments[i].end, start))) break;
    start = comments[i].pos;
  }
  return start;
}

/** The top-level statement of `sf` that holds `node`, or undefined when it sits deeper in a scope. */
function topLevelStatement(sf: ts.SourceFile, node: ts.Node): ts.Statement | undefined {
  let n = node;
  while (
    n.parent &&
    n.parent !== sf &&
    (ts.isVariableDeclaration(n) ||
      ts.isVariableDeclarationList(n) ||
      ts.isBindingElement(n) ||
      ts.isObjectBindingPattern(n) ||
      ts.isArrayBindingPattern(n))
  ) {
    n = n.parent;
  }
  return n.parent === sf ? (n as ts.Statement) : undefined;
}

/** A specifier from `importer` to `target`, in the style of `like` (alias or relative, and its ending). */
function specifierFor(importer: string, target: string, like: string, srcRoot: string): string {
  const ending =
    like.match(/\.[cm]?[jt]sx?$/)?.[0] ?? (/(^|\/)index$/.test(like) || like === "." ? ".js" : "");
  const stem = target.replace(TS_EXTENSION, "");
  if (like.startsWith("@/")) return `@/${toPosix(relative(srcRoot, stem))}${ending}`;
  const rel = toPosix(relative(dirname(importer), stem));
  return (rel.startsWith(".") ? rel : `./${rel}`) + ending;
}

/** The `.js`-style specifier a file in `fromDir` uses for `target`. */
function jsSpecifier(fromDir: string, target: string): string {
  const ext = target.match(TS_EXTENSION)?.[0] ?? ".ts";
  const js = ext
    .replace(/^\.(d\.)?/, ".")
    .replace("ts", "js")
    .replace(/x$/, "");
  const rel = toPosix(relative(fromDir, target.replace(TS_EXTENSION, "")));
  return (rel.startsWith(".") ? rel : `./${rel}`) + js;
}

/** `type { a, b }` when every name is a type, else `{ a, type b }`. */
function namedList(names: string[], isType: (name: string) => boolean): string {
  if (names.every(isType)) return `type { ${names.join(", ")} }`;
  return `{ ${names.map((n) => (isType(n) ? `type ${n}` : n)).join(", ")} }`;
}

export const lineOf = (sf: ts.SourceFile, pos: number): string => {
  const { line } = sf.getLineAndCharacterOfPosition(pos);
  return `${line + 1}: ${sf.text.split("\n")[line].trim()}`;
};

/**
 * Plans the move without touching the disk. Throws when a name is not a
 * top-level declaration of `from`, or the moved code needs something `to`
 * cannot import.
 */
export function planSymbolMove(repoRoot: string, move: SymbolMove): SymbolPlan {
  const { from, to } = move;
  const names = new Set(move.names);
  if (names.size === 0) throw new Error("no names given");
  if (from === to) throw new Error("<from> and <to> are the same file");
  const { pkgDir, parsed } = readPackage(from);
  const inPackage = (f: string): boolean => f.startsWith(pkgDir + sep);
  if (!inPackage(to)) throw new Error(`${to} is outside ${pkgDir}`);
  if (trackedFiles(repoRoot, [from]).length === 0) throw new Error(`${from} is not tracked`);
  const srcRoot = resolve(pkgDir, "src");
  const created = !existsSync(to);

  const program = isolatedChecker(created ? [from] : [from, to]);
  const checker = program.getTypeChecker();
  const src = program.getSourceFile(from);
  if (!src) throw new Error(`cannot read ${from}`);
  const srcText = src.getFullText();
  const cache = ts.createModuleResolutionCache(pkgDir, (s) => s, parsed.options);
  const resolveSpec = (spec: string, importer: string): string | undefined => {
    const alias = spec.startsWith("@/") && inPackage(importer);
    if (!spec.startsWith(".") && !alias) return undefined;
    const hit = ts.resolveModuleName(spec, importer, parsed.options, ts.sys, cache).resolvedModule;
    if (hit) return resolve(hit.resolvedFileName);
    // `to` may not exist yet, so match its path by stem.
    const plain = resolve(dirname(importer), spec.replace(/\.[cm]?[jt]sx?$/, ""));
    return plain === to.replace(TS_EXTENSION, "") ? to : undefined;
  };

  // The statements that move, in file order.
  const moved: ts.Statement[] = [];
  const found = new Set<string>();
  for (const stmt of src.statements) {
    const declared = declaredNames(stmt).map((n) => n.text);
    if (!declared.some((n) => names.has(n))) continue;
    const missing = declared.filter((n) => !names.has(n));
    if (missing.length > 0) {
      throw new Error(
        `${declared.join(", ")} are declared together; name ${missing.join(", ")} too`,
      );
    }
    if (hasModifier(stmt, ts.SyntaxKind.DefaultKeyword)) {
      throw new Error(`${declared[0]} is a default export, which this script does not move`);
    }
    moved.push(stmt);
    for (const n of declared) found.add(n);
  }
  const absent = [...names].filter((n) => !found.has(n));
  if (absent.length > 0) {
    throw new Error(`${absent.join(", ")} not declared at the top of ${relative(repoRoot, from)}`);
  }
  const movedSet = new Set<ts.Node>(moved);
  const isMovedSymbol = (s: ts.Symbol | undefined): boolean =>
    (s?.declarations ?? []).some((d) => {
      const top = topLevelStatement(src, d);
      return top !== undefined && movedSet.has(top);
    });
  const typeNames = new Set(moved.filter(isTypeOnly).flatMap((s) => declaredNames(s)));
  const isTypeName = (name: string): boolean => [...typeNames].some((n) => n.text === name);

  // `export { name }` lists in `from` that name a moved declaration lose that entry.
  const fromChanges: Change[] = [];
  const droppedExports = new Set<ts.Node>();
  const exportedNames = new Set(
    moved.filter((s) => hasModifier(s, ts.SyntaxKind.ExportKeyword)).flatMap(declaredNames),
  );
  const exportedMoved = new Set([...exportedNames].map((n) => n.text));
  for (const stmt of src.statements) {
    if (!ts.isExportDeclaration(stmt) || stmt.moduleSpecifier || !stmt.exportClause) continue;
    if (!ts.isNamedExports(stmt.exportClause)) continue;
    const elements = stmt.exportClause.elements;
    const keep = elements.filter((e) => {
      const local = e.propertyName ?? e.name;
      return !ts.isIdentifier(local) || !isMovedSymbol(symbolOf(checker, local));
    });
    if (keep.length === elements.length) continue;
    for (const e of elements) {
      if (keep.includes(e)) continue;
      if (e.propertyName) throw new Error(`${e.getText(src)} renames a moved name on export`);
      droppedExports.add(e);
      exportedMoved.add(e.name.text);
    }
    const typeOnly = stmt.isTypeOnly ? "type " : "";
    const next =
      keep.length === 0
        ? ""
        : `export ${typeOnly}{ ${keep.map((e) => e.getText(src)).join(", ")} };`;
    let end = stmt.getEnd();
    if (next === "" && srcText[end] === "\n") end++;
    fromChanges.push({ start: stmt.getStart(src), end, next });
  }
  for (const stmt of src.statements) {
    if (
      ts.isExportAssignment(stmt) &&
      isMovedSymbol(checker.getSymbolAtLocation(stmt.expression))
    ) {
      throw new Error(`${stmt.getText(src)} default-exports a moved name`);
    }
  }

  // What the moved code uses from the rest of `from`.
  const importDeps = new Set<ts.Symbol>();
  const localDeps = new Map<string, ts.Statement>();
  for (const id of identifiers(moved)) {
    const s = symbolOf(checker, id);
    const decl = s?.declarations?.[0];
    if (!s || !decl || decl.getSourceFile() !== src || isMovedSymbol(s)) continue;
    if (ts.isImportSpecifier(decl) || ts.isImportClause(decl) || ts.isNamespaceImport(decl)) {
      importDeps.add(s);
      continue;
    }
    const top = topLevelStatement(src, decl);
    if (top && !movedSet.has(top)) localDeps.set(id.text, top);
  }
  const fromExports = new Set<string>();
  for (const stmt of src.statements) {
    if (hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) {
      for (const n of declaredNames(stmt)) fromExports.add(n.text);
    } else if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && stmt.exportClause) {
      if (ts.isNamedExports(stmt.exportClause)) {
        for (const e of stmt.exportClause.elements) {
          if (!e.propertyName) fromExports.add(e.name.text);
        }
      }
    }
  }
  const unexported = [...localDeps.keys()].filter((n) => !fromExports.has(n));
  if (unexported.length > 0) {
    throw new Error(
      `the moved code uses ${unexported.join(", ")}, which stays in ${relative(repoRoot, from)} unexported; move it too or export it first`,
    );
  }

  // The imports `to` needs: the moved code's own imports, respelled, and its exported neighbours.
  const target = created ? undefined : program.getSourceFile(to);
  const targetText = target?.getFullText() ?? "";
  const targetBound = new Map<string, ts.Node>();
  for (const stmt of target?.statements ?? []) {
    for (const n of declaredNames(stmt)) targetBound.set(n.text, stmt);
    if (ts.isImportDeclaration(stmt) && stmt.importClause) {
      const c = stmt.importClause;
      if (c.name) targetBound.set(c.name.text, stmt);
      if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) {
        targetBound.set(c.namedBindings.name.text, stmt);
      } else if (c.namedBindings) {
        for (const e of c.namedBindings.elements) targetBound.set(e.name.text, stmt);
      }
    }
  }
  const importsFromSource = (stmt: ts.Node): boolean =>
    ts.isImportDeclaration(stmt) &&
    ts.isStringLiteral(stmt.moduleSpecifier) &&
    resolveSpec(stmt.moduleSpecifier.text, to) === from;
  for (const stmt of moved) {
    for (const n of declaredNames(stmt)) {
      const there = targetBound.get(n.text);
      if (there && !importsFromSource(there)) {
        throw new Error(`${relative(repoRoot, to)} already has a ${n.text}`);
      }
    }
  }
  const newImports: string[] = [];
  const respellFromSource = (spec: string): string => {
    if (!spec.startsWith(".")) return spec;
    const abs = resolve(dirname(from), spec);
    const rel = toPosix(relative(dirname(to), abs));
    return rel.startsWith(".") ? rel : `./${rel}`;
  };
  for (const decl of src.statements) {
    if (!ts.isImportDeclaration(decl) || !decl.importClause) continue;
    if (!ts.isStringLiteral(decl.moduleSpecifier)) continue;
    const spec = decl.moduleSpecifier.text;
    if (resolveSpec(spec, from) === to) continue;
    const clause = decl.importClause;
    const needs = (name: ts.Identifier): boolean => {
      const s = checker.getSymbolAtLocation(name);
      if (!s || !importDeps.has(s)) return false;
      const there = targetBound.get(name.text);
      if (!there) return true;
      if (
        ts.isImportDeclaration(there) &&
        ts.isStringLiteral(there.moduleSpecifier) &&
        respellFromSource(spec) === there.moduleSpecifier.text
      ) {
        return false;
      }
      throw new Error(`${relative(repoRoot, to)} already binds ${name.text} to something else`);
    };
    const parts: string[] = [];
    if (clause.name && needs(clause.name)) parts.push(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings) && needs(bindings.name)) {
      parts.push(bindings.getText(src));
    } else if (bindings && ts.isNamedImports(bindings)) {
      const named = bindings.elements.filter((e) => needs(e.name)).map((e) => e.getText(src));
      if (named.length > 0) parts.push(`{ ${named.join(", ")} }`);
    }
    if (parts.length === 0) continue;
    const tail = srcText.slice(decl.moduleSpecifier.getEnd(), decl.getEnd());
    newImports.push(
      `import ${clause.isTypeOnly ? "type " : ""}${parts.join(", ")} from "${respellFromSource(spec)}"${tail}`,
    );
  }
  const neighbours = [...localDeps.entries()].filter(([n]) => !targetBound.has(n));
  if (neighbours.length > 0) {
    const typeDeps = new Set(neighbours.filter(([, s]) => isTypeOnly(s)).map(([n]) => n));
    const list = namedList(
      neighbours.map(([n]) => n),
      (n) => typeDeps.has(n),
    );
    newImports.push(`import ${list} from "${jsSpecifier(dirname(to), from)}";`);
  }

  // The moved text, each declaration exported.
  const movedText = moved.map((stmt) => {
    const start = startWithComments(src, stmt);
    const body = srcText.slice(start, stmt.getEnd());
    if (hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) return body;
    const at = stmt.getStart(src) - start;
    return `${body.slice(0, at)}export ${body.slice(at)}`;
  });
  for (const stmt of moved) {
    const start = startWithComments(src, stmt);
    let end = stmt.getEnd();
    if (srcText[end] === "\n") end++;
    // Between two blank lines, one of them goes too.
    if (srcText[end] === "\n" && (start === 0 || srcText.slice(start - 2, start) === "\n\n")) end++;
    fromChanges.push({ start, end, next: "" });
  }

  // `from` imports the moved names it still uses, and drops the imports only the moved code used.
  const rest = src.statements.filter((s) => !movedSet.has(s));
  const stillUsed = new Set<string>();
  const restUsed = new Set<ts.Symbol>();
  for (const id of identifiers(rest)) {
    if (droppedExports.has(id.parent)) continue;
    const s = symbolOf(checker, id);
    if (!s) continue;
    restUsed.add(s);
    if (isMovedSymbol(s)) stillUsed.add(id.text);
  }
  const removal = importRemovals(checker, src, (s) => !importDeps.has(s) || restUsed.has(s));
  fromChanges.push(...removal.changes);
  if (stillUsed.size > 0) {
    const list = namedList([...stillUsed], isTypeName);
    // Ahead of the first import, which may itself be going: an insertion listed
    // after a removal at the same offset lands after the removal is applied.
    const at = src.statements.find(ts.isImportDeclaration)?.getStart(src) ?? 0;
    fromChanges.push({
      start: at,
      end: at,
      next: `import ${list} from "${jsSpecifier(dirname(from), to)}";\n`,
    });
  }

  const edits = new Map<string, string>();
  edits.set(from, applyChanges(srcText, fromChanges));

  // Every importer of `from` takes the moved names from `to` instead.
  const review: string[] = [];
  let rewritten = 0;
  const toChanges: Change[] = [];
  const fromStem = basename(from).replace(TS_EXTENSION, "");
  for (const file of trackedFiles(repoRoot, SCRIPTS)) {
    if (file === from) continue;
    const isTarget = file === to;
    const text = isTarget ? targetText : ts.sys.readFile(file);
    if (!text?.includes(fromStem)) continue;
    const sf =
      isTarget && target ? target : ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const changes: Change[] = isTarget ? toChanges : [];
    for (const lit of moduleSpecifiers(sf)) {
      if (resolveSpec(lit.text, file) !== from) continue;
      const nextSpec = specifierFor(file, to, lit.text, srcRoot);
      const decl = lit.parent;
      const where = `${relative(repoRoot, file)}:${lineOf(sf, lit.getStart(sf))}`;
      const named = (
        bindings: ts.NamedImportBindings | ts.NamedExportBindings | undefined,
      ): ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier> | undefined =>
        bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))
          ? bindings.elements
          : undefined;
      if (ts.isImportDeclaration(decl) || ts.isExportDeclaration(decl)) {
        const isImport = ts.isImportDeclaration(decl);
        const clause = isImport ? decl.importClause : undefined;
        const bindings = isImport ? clause?.namedBindings : decl.exportClause;
        if (bindings && ts.isNamespaceImport(bindings)) {
          review.push(`${where} (namespace import)`);
          continue;
        }
        if (bindings && ts.isNamespaceExport(bindings)) {
          review.push(`${where} (namespace export)`);
          continue;
        }
        const elements = named(bindings);
        if (!isImport && !elements) {
          // `export * from "<from>"` no longer carries the moved names.
          const already = moduleSpecifiers(sf).some(
            (l) =>
              ts.isExportDeclaration(l.parent) &&
              !l.parent.exportClause &&
              resolveSpec(l.text, file) === to,
          );
          if (already || isTarget || exportedMoved.size === 0) continue;
          const list = namedList([...exportedMoved], isTypeName);
          changes.push({
            start: decl.getEnd(),
            end: decl.getEnd(),
            next: `\nexport ${list} from "${nextSpec}";`,
          });
          rewritten++;
          continue;
        }
        if (!elements) continue;
        const take = elements.filter((e) => names.has((e.propertyName ?? e.name).text));
        if (take.length === 0) continue;
        const keep = elements.filter((e) => !take.includes(e));
        const keyword = isImport ? "import" : "export";
        const typeOnly = (isImport ? clause?.isTypeOnly : decl.isTypeOnly) ? "type " : "";
        const tail = text.slice(lit.getEnd(), decl.getEnd());
        const list = (es: readonly ts.Node[]): string =>
          `{ ${es.map((e) => e.getText(sf)).join(", ")} }`;
        const moving = isTarget
          ? ""
          : `${keyword} ${typeOnly}${list(take)} from "${nextSpec}"${tail}`;
        const defaultName = clause?.name ? `${clause.name.text}${keep.length > 0 ? ", " : ""}` : "";
        const staying =
          keep.length > 0 || defaultName
            ? `${keyword} ${typeOnly}${defaultName}${keep.length > 0 ? list(keep) : ""} from ${text.slice(lit.getStart(sf), decl.getEnd())}`
            : "";
        const next = [staying, moving].filter(Boolean).join("\n");
        let end = decl.getEnd();
        if (next === "" && text[end] === "\n") end++;
        changes.push({ start: decl.getStart(sf), end, next });
        if (!isTarget) rewritten++;
      } else if (ts.isLiteralTypeNode(decl) && ts.isImportTypeNode(decl.parent)) {
        let q = decl.parent.qualifier;
        while (q && ts.isQualifiedName(q)) q = q.left;
        if (q && names.has(q.text)) {
          changes.push({ start: lit.getStart(sf) + 1, end: lit.getEnd() - 1, next: nextSpec });
          rewritten++;
        }
      } else {
        review.push(where);
      }
    }
    if (!isTarget && changes.length > 0) edits.set(file, applyChanges(text, changes));
  }

  // `to` gains the imports after its own, and the declarations at its end.
  let toText = applyChanges(targetText, toChanges);
  if (newImports.length > 0) {
    const reparsed = ts.createSourceFile(to, toText, ts.ScriptTarget.Latest, true);
    const imports = reparsed.statements.filter(ts.isImportDeclaration);
    const at = imports.length > 0 ? imports[imports.length - 1].getEnd() : 0;
    const block = newImports.join("\n");
    toText =
      at === 0 ? `${block}\n\n${toText}` : `${toText.slice(0, at)}\n${block}${toText.slice(at)}`;
  }
  toText = `${toText.trimEnd()}${toText.trim() ? "\n\n" : ""}${movedText.join("\n\n")}\n`;
  edits.set(to, toText);
  return { edits, created, rewritten, review };
}

/** Writes the edits, and stages `to` when the move created it. */
export function applySymbolPlan(repoRoot: string, move: SymbolMove, plan: SymbolPlan): void {
  mkdirSync(dirname(move.to), { recursive: true });
  for (const [file, text] of plan.edits) writeFileSync(file, text);
  if (plan.created) git(repoRoot, ["add", "--", move.to]);
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
  const move = { from: resolve(cwd, from), to: resolve(cwd, to), names };
  const plan = planSymbolMove(repoRoot, move);
  if (!dry) {
    applySymbolPlan(repoRoot, move, plan);
    if (format && !biomeFormat(repoRoot, [...plan.edits.keys()])) {
      console.log(
        "Biome could not run, so the touched files are not formatted. Run `biome check --write` on them.",
      );
    }
  }
  console.log(
    `${dry ? "Would move" : "Moved"} ${names.join(", ")} to ${relative(repoRoot, move.to)}${plan.created ? " (new file)" : ""} and rewrite ${plan.rewritten} import and export declarations in ${plan.edits.size - 2} other files.`,
  );
  if (plan.review.length > 0) {
    console.log(
      `\nThese lines reach ${relative(repoRoot, move.from)} and may use a moved name. Check them by hand:`,
    );
    for (const r of plan.review) console.log(`  ${r}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
