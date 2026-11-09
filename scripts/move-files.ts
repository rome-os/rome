#!/usr/bin/env tsx
/**
 * Move files or folders inside one TypeScript package and rewrite every import
 * that names a moved file, or sits in one.
 *
 *   pnpm move-files [--dry] <from>:<to> [<from>:<to> ...]
 *
 * Paths are relative to the current directory, and every move must fall inside
 * the same package (the nearest tsconfig.json above the first source).
 *
 * Every relative specifier in every tracked script of the repo is resolved
 * against the layout before the move, mapped through the move table, and
 * spelled again relative to the importer's new place. The specifier keeps its
 * ending, so `./x.js` stays `.js` and `./dir/index.js` keeps `index.js`. The
 * package's own `@/` specifiers change only when their target moves. It covers
 * import and export declarations, `import()` calls and `import("…")` types,
 * `require()`, and the path argument of `rs.*` and `vi.*` module mocks.
 *
 * It cannot see a path a string builds by hand, such as a config entry, a
 * bundler input or a test that joins folder names. After the move it prints
 * every line that still names an old path, for a person to fix.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** One requested move, with absolute paths. `from` is a file or a folder. */
export interface Move {
  from: string;
  to: string;
}

export interface MovePlan {
  /** Every tracked file to rename, old absolute path to new. */
  renames: Map<string, string>;
  /** New text for every importer whose specifiers change, keyed by its path before the move. */
  edits: Map<string, string>;
  /** Number of specifiers rewritten across `edits`. */
  rewritten: number;
  /** Package specifiers that resolved to no file before the move. They are left alone. */
  unresolved: string[];
}

const TS_EXTENSION = /\.(d\.)?[cm]?tsx?$/;
const MOCK_CALLERS = new Set(["rs", "vi"]);
const MOCK_METHODS = new Set([
  "mock",
  "doMock",
  "unmock",
  "doUnmock",
  "importActual",
  "importMock",
]);

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function trackedFiles(repoRoot: string, pathspecs: string[]): string[] {
  return git(repoRoot, ["ls-files", "-z", "--", ...pathspecs])
    .split("\0")
    .filter(Boolean)
    .map((f) => join(repoRoot, f));
}

/** The nearest tsconfig.json at or above `path`. */
function findTsconfig(path: string): string {
  let dir = existsSync(path) && statSync(path).isDirectory() ? path : dirname(path);
  for (;;) {
    const candidate = join(dir, "tsconfig.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no tsconfig.json above ${path}`);
    dir = parent;
  }
}

function moduleSpecifiers(sf: ts.SourceFile): ts.StringLiteralLike[] {
  const out: ts.StringLiteralLike[] = [];
  const visit = (n: ts.Node): void => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      out.push(n.moduleSpecifier);
    } else if (ts.isExternalModuleReference(n) && ts.isStringLiteral(n.expression)) {
      out.push(n.expression);
    } else if (
      ts.isImportTypeNode(n) &&
      ts.isLiteralTypeNode(n.argument) &&
      ts.isStringLiteral(n.argument.literal)
    ) {
      out.push(n.argument.literal);
    } else if (ts.isCallExpression(n) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
      const callee = n.expression;
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      const isMock =
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        MOCK_CALLERS.has(callee.expression.text) &&
        MOCK_METHODS.has(callee.name.text);
      if (isImport || isRequire || isMock) out.push(n.arguments[0]);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

const isIndex = (file: string): boolean => /(^|[\\/])index$/.test(file.replace(TS_EXTENSION, ""));

/** `spec` spelled again for an importer at `importer` naming `target`, keeping the old ending. */
function respell(spec: string, importer: string, oldTarget: string, newTarget: string): string {
  let rel = toPosix(relative(dirname(importer), newTarget.replace(TS_EXTENSION, "")));
  if (!rel.startsWith(".")) rel = `./${rel}`;
  // A folder import (`./dir`) stays one while the target is still an index file.
  if (isIndex(oldTarget) && isIndex(newTarget) && !/\/index(\.[a-z]+)?$/.test(spec)) {
    return rel.replace(/\/index$/, "") || ".";
  }
  // A target with no TS extension (`.json`, `.mjs`) already carries its own.
  if (!TS_EXTENSION.test(newTarget)) return rel;
  return rel + (spec.match(/\.[cm]?[jt]sx?$/)?.[0] ?? "");
}

/**
 * Plans the moves without touching the disk. Throws when a source is not
 * tracked or a destination already exists.
 */
export function planMoves(repoRoot: string, moves: Move[]): MovePlan {
  if (moves.length === 0) throw new Error("no moves given");
  const tsconfig = findTsconfig(moves[0].from);
  const pkgDir = dirname(tsconfig);
  const inPackage = (f: string): boolean => f.startsWith(pkgDir + sep);
  const parsed = ts.getParsedCommandLineOfConfigFile(
    tsconfig,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      },
    },
  );
  if (!parsed) throw new Error(`cannot read ${tsconfig}`);

  const renames = new Map<string, string>();
  for (const { from, to } of moves) {
    if (!inPackage(from) || !inPackage(to)) throw new Error(`${from} -> ${to} leaves ${pkgDir}`);
    const files = trackedFiles(repoRoot, [from]);
    if (files.length === 0) throw new Error(`${from} holds no tracked file`);
    for (const f of files) renames.set(f, f === from ? to : to + f.slice(from.length));
  }
  const destinations = new Set<string>();
  for (const to of renames.values()) {
    if (destinations.has(to)) throw new Error(`two files move to ${to}`);
    if (existsSync(to)) throw new Error(`${to} already exists`);
    destinations.add(to);
  }
  const moved = (f: string): string => renames.get(f) ?? f;

  const cache = ts.createModuleResolutionCache(pkgDir, (s) => s, parsed.options);
  const srcRoot = join(pkgDir, "src");
  const edits = new Map<string, string>();
  const unresolved: string[] = [];
  let rewritten = 0;
  const importers = trackedFiles(repoRoot, [
    "*.ts",
    "*.tsx",
    "*.mts",
    "*.cts",
    "*.mjs",
    "*.cjs",
    "*.js",
  ]);
  for (const file of importers) {
    const text = readFileSync(file, "utf8");
    const changes: Array<{ start: number; end: number; next: string }> = [];
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const lit of moduleSpecifiers(sf)) {
      const spec = lit.text;
      // `@/` is this package's alias. Another package's `@/` names its own src.
      const alias = spec.startsWith("@/") && inPackage(file);
      if (!spec.startsWith(".") && !alias) continue;
      let target = ts.resolveModuleName(spec, file, parsed.options, ts.sys, cache).resolvedModule
        ?.resolvedFileName;
      if (!target && !alias) {
        // The TS resolver skips files it does not compile, such as `.json` or `.mjs`.
        const plain = resolve(dirname(file), spec);
        if (existsSync(plain) && statSync(plain).isFile()) target = plain;
      }
      if (!target) {
        if (inPackage(file)) unresolved.push(`${relative(repoRoot, file)}: ${spec}`);
        continue;
      }
      target = resolve(target);
      let next: string;
      if (alias) {
        if (!renames.has(target)) continue;
        const ending = TS_EXTENSION.test(target) ? (spec.match(/\.[cm]?[jt]sx?$/)?.[0] ?? "") : "";
        next = `@/${toPosix(relative(srcRoot, moved(target).replace(TS_EXTENSION, "")))}${ending}`;
      } else {
        if (!renames.has(file) && !renames.has(target)) continue;
        next = respell(spec, moved(file), target, moved(target));
      }
      if (next !== spec) changes.push({ start: lit.getStart(sf) + 1, end: lit.getEnd() - 1, next });
    }
    if (changes.length === 0) continue;
    let out = text;
    for (const c of changes.sort((a, b) => b.start - a.start)) {
      out = out.slice(0, c.start) + c.next + out.slice(c.end);
    }
    edits.set(file, out);
    rewritten += changes.length;
  }
  return { renames, edits, rewritten, unresolved };
}

/**
 * Writes the edits, renames the files and stages both sides of every rename,
 * so git records each one as a rename.
 */
export function applyPlan(repoRoot: string, plan: MovePlan): void {
  for (const [file, text] of plan.edits) writeFileSync(file, text);
  const paths: string[] = [];
  for (const [from, to] of plan.renames) {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    paths.push(from, to);
  }
  // One `git add` per batch: a `git mv` per file costs a process each.
  for (let i = 0; i < paths.length; i += 500)
    git(repoRoot, ["add", "-A", "--", ...paths.slice(i, i + 500)]);
}

/**
 * Lines in tracked files that still name an old path, as `file:line:text`.
 * It looks for each requested source by its repo path, and by its path inside
 * the package under `src/` or `dist/` where no other folder name precedes it,
 * since configs and bundler inputs spell a path that way.
 */
export function findMentions(repoRoot: string, moves: Move[], plan: MovePlan): string[] {
  const tsconfig = findTsconfig(moves[0].from);
  const pkgDir = dirname(tsconfig);
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns: string[] = [];
  for (const { from } of moves) {
    const isDir = !plan.renames.has(from);
    const stem = (p: string): string => toPosix(p).replace(TS_EXTENSION, "") + (isDir ? "/" : "");
    patterns.push(escape(stem(relative(repoRoot, from))));
    const inPkg = stem(relative(pkgDir, from));
    if (inPkg.startsWith("src/")) {
      patterns.push(`(^|[^A-Za-z0-9_./-])(src|dist)/${escape(inPkg.slice("src/".length))}`);
    }
  }
  let out: string;
  try {
    out = git(repoRoot, ["grep", "-n", "-I", "-E", ...patterns.flatMap((p) => ["-e", p])]);
  } catch {
    return []; // git grep exits 1 when nothing matches
  }
  return out.split("\n").filter(Boolean);
}

function main(argv: string[]): void {
  const dry = argv.includes("--dry");
  const pairs = argv.filter((a) => a !== "--dry");
  if (pairs.length === 0) {
    console.error("usage: pnpm move-files [--dry] <from>:<to> [<from>:<to> ...]");
    process.exit(2);
  }
  // pnpm runs a root script from the repo root; INIT_CWD is where it was typed.
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const moves = pairs.map((pair) => {
    const [from, to, extra] = pair.split(":");
    if (!from || !to || extra !== undefined) throw new Error(`expected <from>:<to>, got ${pair}`);
    return { from: resolve(cwd, from), to: resolve(cwd, to) };
  });
  const repoRoot = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  const plan = planMoves(repoRoot, moves);
  if (!dry) applyPlan(repoRoot, plan);
  console.log(
    `${dry ? "Would move" : "Moved"} ${plan.renames.size} files and rewrite ${plan.rewritten} specifiers in ${plan.edits.size} files.`,
  );
  if (plan.unresolved.length > 0) {
    console.log(`\nThese specifiers resolved to no file before the move and were left alone:`);
    for (const u of plan.unresolved) console.log(`  ${u}`);
  }
  if (!dry) {
    const mentions = findMentions(repoRoot, moves, plan);
    if (mentions.length > 0) {
      console.log(`\nThese lines still name an old path. Fix them by hand:`);
      for (const m of mentions) console.log(`  ${m}`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
