/**
 * A TypeScript language service over one package, the engine behind
 * `move-symbol` and `rename-symbol`. Edits stay in memory until `write`, so
 * several refactors can run in a row against each other's output.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { moduleSpecifiers, readPackage, TS_EXTENSION, toPosix } from "./move-files.js";

/**
 * How the service writes imports, following how the package resolves them. A
 * package that Node runs, resolved as NodeNext, gets relative imports with a
 * `.js` ending. A bundled package gets the shortest specifier, `@/` included,
 * with no ending, as its own code writes them.
 */
function preferencesFor(options: ts.CompilerOptions): ts.UserPreferences {
  const bundled = options.moduleResolution === ts.ModuleResolutionKind.Bundler;
  return {
    importModuleSpecifierEnding: bundled ? "minimal" : "js",
    importModuleSpecifierPreference: bundled ? "shortest" : "relative",
    allowRenameOfImportPath: false,
  };
}

export interface PackageService {
  service: ts.LanguageService;
  pkgDir: string;
  /** True when the package resolves imports through a bundler, so `@/` survives the build. */
  bundled: boolean;
  preferences: ts.UserPreferences;
  /** The file an import of `specifier` written in `importer` reaches, with the edits so far. */
  resolveImport(specifier: string, importer: string): string | undefined;
  /** The current text of a file, with the edits so far. */
  text(file: string): string | undefined;
  /** Applies the service's edits in memory. */
  apply(edits: readonly ts.FileTextChanges[]): void;
  /** Replaces a file's text in memory. */
  set(file: string, text: string): void;
  /** The files the edits so far changed or created. */
  changed(): string[];
  /** Writes every changed file. */
  write(): void;
}

export function packageService(file: string): PackageService {
  const { pkgDir, parsed } = readPackage(file);
  const overlay = new Map<string, { text: string; version: number }>();
  const fileNames = new Set(parsed.fileNames.map((f) => resolve(f)));
  const text = (f: string): string | undefined => overlay.get(f)?.text ?? ts.sys.readFile(f);
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...fileNames],
    getScriptVersion: (f) => String(overlay.get(resolve(f))?.version ?? 0),
    getScriptSnapshot: (f) => {
      const t = text(resolve(f));
      return t === undefined ? undefined : ts.ScriptSnapshot.fromString(t);
    },
    getCurrentDirectory: () => pkgDir,
    getCompilationSettings: () => parsed.options,
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: (f) => overlay.has(resolve(f)) || ts.sys.fileExists(f),
    readFile: (f) => text(resolve(f)),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const set = (f: string, t: string): void => {
    overlay.set(f, { text: t, version: (overlay.get(f)?.version ?? 0) + 1 });
    fileNames.add(f);
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  const resolutionHost: ts.ModuleResolutionHost = {
    fileExists: (f) => overlay.has(resolve(f)) || ts.sys.fileExists(f),
    readFile: (f) => text(resolve(f)),
  };
  return {
    service,
    pkgDir,
    bundled: parsed.options.moduleResolution === ts.ModuleResolutionKind.Bundler,
    preferences: preferencesFor(parsed.options),
    resolveImport: (specifier, importer) => {
      const found = ts.resolveModuleName(specifier, importer, parsed.options, resolutionHost);
      const f = found.resolvedModule?.resolvedFileName;
      return f === undefined ? undefined : resolve(f);
    },
    text,
    apply(edits) {
      for (const edit of edits) {
        const f = resolve(edit.fileName);
        let out = edit.isNewFile ? "" : (text(f) ?? "");
        const changes = [...edit.textChanges].sort((a, b) => b.span.start - a.span.start);
        for (const c of changes) {
          out = out.slice(0, c.span.start) + c.newText + out.slice(c.span.start + c.span.length);
        }
        set(f, out);
      }
    },
    set,
    changed: () => [...overlay.keys()],
    write() {
      for (const [f, { text: t }] of overlay) {
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, t);
      }
    },
  };
}

/**
 * `text` with each `@/` import respelled relative to `file`, keeping its
 * ending, except the ones `before` already held. For a package Node runs: its
 * build keeps `@/` as written, and Node cannot resolve it.
 */
export function relativeAliases(
  file: string,
  text: string,
  before: string,
  pkgDir: string,
): string {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const srcRoot = resolve(pkgDir, "src");
  let out = text;
  const specs = moduleSpecifiers(sf).filter(
    (lit) => lit.text.startsWith("@/") && !before.includes(`"${lit.text}"`),
  );
  for (const lit of specs.sort((a, b) => b.getStart(sf) - a.getStart(sf))) {
    const ending = lit.text.match(/\.[cm]?[jt]sx?$/)?.[0] ?? "";
    const target = resolve(
      srcRoot,
      lit.text
        .slice(2)
        .replace(TS_EXTENSION, "")
        .replace(/\.[cm]?js$/, ""),
    );
    let rel = toPosix(relative(dirname(file), target));
    if (!rel.startsWith(".")) rel = `./${rel}`;
    out = out.slice(0, lit.getStart(sf) + 1) + rel + ending + out.slice(lit.getEnd() - 1);
  }
  return out;
}

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

/** The top-level statements of `file` that declare each of `names`, in file order. */
export function topLevelDeclarations(
  file: string,
  text: string,
  names: string[],
): { sf: ts.SourceFile; statements: ts.Statement[]; nameOf: Map<string, ts.Identifier> } {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const nameOf = new Map<string, ts.Identifier>();
  const statements: ts.Statement[] = [];
  for (const stmt of sf.statements) {
    const declared = declaredNames(stmt).filter((n) => names.includes(n.text));
    if (declared.length === 0) continue;
    if (!statements.includes(stmt)) statements.push(stmt);
    for (const n of declared) if (!nameOf.has(n.text)) nameOf.set(n.text, n);
  }
  const absent = names.filter((n) => !nameOf.has(n));
  if (absent.length > 0) throw new Error(`${absent.join(", ")} not declared at the top of ${file}`);
  return { sf, statements, nameOf };
}

/** The identifier that starts at `pos` in `sf`. */
export function identifierAt(sf: ts.SourceFile, pos: number): ts.Identifier | undefined {
  const find = (n: ts.Node): ts.Identifier | undefined => {
    if (pos < n.getStart(sf) || pos >= n.getEnd()) return undefined;
    if (ts.isIdentifier(n)) return n;
    return ts.forEachChild(n, find);
  };
  return find(sf);
}

/** Runs `run`, and on an error prints its message and exits 1, since a refusal needs no stack. */
export function refuseCleanly<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
