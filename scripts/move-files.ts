#!/usr/bin/env tsx
/**
 * Move files or folders inside one TypeScript package and rewrite every import
 * that names a moved file, or sits in one.
 *
 *   pnpm move-files [--dry] [--no-tests] [--no-format] <from>:<to> [...]
 *
 * Paths are relative to the current directory, and every move must fall inside
 * the same package (the nearest tsconfig.json above the first source). A moved
 * file takes its sibling tests along (`x.ts` brings `x.test.ts` and
 * `x.integration.test.ts`) unless `--no-tests` is given or the test has a move
 * of its own. Afterwards Biome formats and sorts the imports of every touched
 * file, unless `--no-format` is given.
 *
 * Every relative specifier in every tracked script of the repo is resolved
 * against the layout before the move, mapped through the move table, and
 * spelled again relative to the importer's new place. The specifier keeps its
 * ending, so `./x.js` stays `.js` and `./dir/index.js` keeps `index.js`. The
 * package's own `@/` specifiers change only when their target moves. It covers
 * import and export declarations, `import()` calls and `import("…")` types,
 * `require()`, and the path argument of `rs.*` and `vi.*` module mocks.
 *
 * In Markdown it rewrites the same way every link whose target is a moved file
 * or folder, and every path in a code span that names one, spelled from the
 * repo root, from the document, or from the package root for a document inside
 * the package.
 *
 * It cannot see a path a string builds by hand, such as a config entry, a
 * bundler input or a test that joins folder names. After the move it prints
 * every line that still names an old path, for a person to fix.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
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
  /** Number of paths rewritten in Markdown and in code comments across `edits`. */
  pathReferences: number;
  /** Package specifiers that resolved to no file before the move. They are left alone. */
  unresolved: string[];
}

export const TS_EXTENSION = /\.(d\.)?[cm]?tsx?$/;
const TEST_FILE = /\.test\.[cm]?tsx?$/;
/** What follows a file's stem in the name of one of its tests: `.test.ts`, `.e2e.test.ts`. */
const TEST_SUFFIX = /^(\.[A-Za-z0-9-]+)*\.test\.[cm]?tsx?$/;
const MOCK_CALLERS = new Set(["rs", "vi"]);
const MOCK_METHODS = new Set([
  "mock",
  "doMock",
  "unmock",
  "doUnmock",
  "importActual",
  "importMock",
]);

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

export function trackedFiles(repoRoot: string, pathspecs: string[]): string[] {
  return git(repoRoot, ["ls-files", "-z", "--", ...pathspecs])
    .split("\0")
    .filter(Boolean)
    .map((f) => join(repoRoot, f));
}

/** The nearest tsconfig.json at or above `path`. */
export function findTsconfig(path: string): string {
  let dir = existsSync(path) && statSync(path).isDirectory() ? path : dirname(path);
  for (;;) {
    const candidate = join(dir, "tsconfig.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no tsconfig.json above ${path}`);
    dir = parent;
  }
}

/** The package holding `path`: the folder of its nearest tsconfig.json, and that config read. */
export function readPackage(path: string): { pkgDir: string; parsed: ts.ParsedCommandLine } {
  const tsconfig = findTsconfig(path);
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
  return { pkgDir: dirname(tsconfig), parsed };
}

export function moduleSpecifiers(sf: ts.SourceFile): ts.StringLiteralLike[] {
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

export function toPosix(path: string): string {
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
export function planMoves(
  repoRoot: string,
  moves: Move[],
  options: { tests?: boolean } = {},
): MovePlan {
  if (moves.length === 0) throw new Error("no moves given");
  const { pkgDir, parsed } = readPackage(moves[0].from);
  const inPackage = (f: string): boolean => f.startsWith(pkgDir + sep);

  const renames = new Map<string, string>();
  for (const { from, to } of moves) {
    if (!inPackage(from) || !inPackage(to)) throw new Error(`${from} -> ${to} leaves ${pkgDir}`);
    const files = trackedFiles(repoRoot, [from]);
    if (files.length === 0) throw new Error(`${from} holds no tracked file`);
    for (const f of files) renames.set(f, f === from ? to : to + f.slice(from.length));
  }
  if (options.tests ?? true) {
    for (const [from, to] of [...renames]) {
      if (!TS_EXTENSION.test(from) || TEST_FILE.test(from)) continue;
      const stem = basename(from).replace(TS_EXTENSION, "");
      const newStem = basename(to).replace(TS_EXTENSION, "");
      for (const sibling of trackedFiles(repoRoot, [join(dirname(from), `${stem}.*`)])) {
        const suffix = basename(sibling).slice(stem.length);
        if (dirname(sibling) !== dirname(from) || !TEST_SUFFIX.test(suffix) || renames.has(sibling))
          continue;
        renames.set(sibling, join(dirname(to), newStem + suffix));
      }
    }
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
  let pathReferences = 0;
  const movedNames = [...new Set([...renames.keys()].map((f) => basename(f)))];
  const mentionsMovedName = (text: string): boolean => movedNames.some((n) => text.includes(n));
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
    if (mentionsMovedName(text)) {
      const bases = inPackage(file) ? [repoRoot, pkgDir, srcRoot] : [repoRoot];
      for (const [start, end] of commentRanges(sf)) {
        for (const t of pathTokens(text.slice(start, end), bases, renames)) {
          changes.push({ start: start + t.start, end: start + t.end, next: t.next });
          pathReferences++;
        }
      }
    }
    if (changes.length === 0) continue;
    let out = text;
    for (const c of changes.sort((a, b) => b.start - a.start)) {
      out = out.slice(0, c.start) + c.next + out.slice(c.end);
    }
    edits.set(file, out);
    rewritten += changes.length;
  }
  rewritten -= pathReferences;
  pathReferences += rewriteDocs(repoRoot, pkgDir, moves, renames, edits);
  return { renames, edits, rewritten, unresolved, pathReferences };
}

/** Every comment in the file, as [start, end) offsets. */
function commentRanges(sf: ts.SourceFile): Array<[number, number]> {
  const text = sf.getFullText();
  const seen = new Map<number, number>();
  const add = (ranges: ts.CommentRange[] | undefined): void => {
    for (const r of ranges ?? []) seen.set(r.pos, r.end);
  };
  const visit = (n: ts.Node): void => {
    add(ts.getLeadingCommentRanges(text, n.pos));
    add(ts.getTrailingCommentRanges(text, n.end));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return [...seen];
}

/** A path written as prose: folders, then a file name with an extension. */
const PATH_TOKEN = /(?<![\w@./-])((?:[\w@-][\w@.-]*\/)+[\w@-][\w@.-]*\.[A-Za-z0-9]+)(?![\w/-])/g;

/**
 * The prose paths in `text` that name a moved file exactly, spelled from one
 * of `bases`, each with the same path spelled from that base after the move.
 */
function pathTokens(
  text: string,
  bases: string[],
  renames: Map<string, string>,
): Array<{ start: number; end: number; next: string }> {
  const out: Array<{ start: number; end: number; next: string }> = [];
  for (const m of text.matchAll(PATH_TOKEN)) {
    for (const base of bases) {
      const next = renames.get(join(base, m[1]));
      if (!next) continue;
      out.push({ start: m.index, end: m.index + m[1].length, next: toPosix(relative(base, next)) });
      break;
    }
  }
  return out;
}

/** Where `path` lands after the moves: its rename, or its place in a moved folder. */
function mapPath(path: string, moves: Move[], renames: Map<string, string>): string {
  const renamed = renames.get(path);
  if (renamed) return renamed;
  for (const { from, to } of moves) {
    if (path === from || path.startsWith(from + sep)) return to + path.slice(from.length);
  }
  return path;
}

const MARKDOWN_LINK = /(\]\(\s*<?)([^)\s>]+)|^(\s*\[[^\]]+\]:\s*<?)([^\s>]+)/gm;
const CODE_SPAN = /(`)([A-Za-z0-9_@.~/-]+\/[A-Za-z0-9_@.~/-]*)((?:#|:\d)[^`]*)?`/g;

/**
 * Adds to `edits` the Markdown files whose links or path code spans change,
 * starting from any text an earlier step already planned. Returns how many
 * references it rewrote.
 */
function rewriteDocs(
  repoRoot: string,
  pkgDir: string,
  moves: Move[],
  renames: Map<string, string>,
  edits: Map<string, string>,
): number {
  const posix = (p: string): string => toPosix(p) || ".";
  let count = 0;
  for (const doc of trackedFiles(repoRoot, ["*.md", "*.mdx"])) {
    const text = edits.get(doc) ?? readFileSync(doc, "utf8");
    const oldDir = dirname(doc);
    const newDir = dirname(mapPath(doc, moves, renames));
    const docMoved = oldDir !== newDir;
    let changed = false;

    // A link resolves from the document, or from the repo root when it starts with `/`.
    const link = (target: string): string => {
      if (/^[a-z][a-z0-9+.-]*:|^#|^\/\//i.test(target)) return target;
      const hash = target.indexOf("#");
      const path = hash === -1 ? target : target.slice(0, hash);
      const anchor = hash === -1 ? "" : target.slice(hash);
      if (!path) return target;
      const fromRoot = path.startsWith("/");
      let decoded: string;
      try {
        decoded = decodeURIComponent(path);
      } catch {
        return target;
      }
      const abs = fromRoot ? join(repoRoot, decoded) : resolve(oldDir, decoded);
      if (!existsSync(abs)) return target;
      const next = mapPath(abs, moves, renames);
      if (next === abs && !(docMoved && !fromRoot)) return target;
      const trailing = path.endsWith("/") ? "/" : "";
      let spelled = fromRoot
        ? `/${posix(relative(repoRoot, next))}`
        : posix(relative(newDir, next));
      if (!fromRoot && path.startsWith("./") && !spelled.startsWith(".")) spelled = `./${spelled}`;
      return spelled.replace(/\/$/, "") + trailing + anchor;
    };

    // A code span names a path from the document when it starts with `.`, and
    // otherwise from the repo root, or from the package root inside the package.
    const span = (path: string): string => {
      const bases = path.startsWith(".")
        ? [oldDir]
        : [repoRoot, ...(doc.startsWith(pkgDir + sep) ? [pkgDir, join(pkgDir, "src")] : [])];
      for (const base of bases) {
        const abs = resolve(base, path);
        if (!existsSync(abs)) continue;
        const next = mapPath(abs, moves, renames);
        if (next === abs && !(base === oldDir && docMoved)) return path;
        const newBase = base === oldDir ? newDir : base;
        let spelled = posix(relative(newBase, next));
        if (path.startsWith("./") && !spelled.startsWith(".")) spelled = `./${spelled}`;
        return spelled.replace(/\/$/, "") + (path.endsWith("/") ? "/" : "");
      }
      return path;
    };

    let out = text.replace(MARKDOWN_LINK, (whole, open, target, refOpen, refTarget) => {
      const before = target ?? refTarget;
      const after = link(before);
      if (after === before) return whole;
      changed = true;
      count++;
      return (open ?? refOpen) + after;
    });
    out = out.replace(CODE_SPAN, (whole, tick, path, suffix = "") => {
      const after = span(path);
      if (after === path) return whole;
      changed = true;
      count++;
      return `${tick}${after}${suffix}\``;
    });
    const tokens = pathTokens(
      out,
      [repoRoot, ...(doc.startsWith(pkgDir + sep) ? [pkgDir, join(pkgDir, "src")] : [])],
      renames,
    );
    for (const t of tokens.sort((a, b) => b.start - a.start)) {
      out = out.slice(0, t.start) + t.next + out.slice(t.end);
      changed = true;
      count++;
    }
    if (changed) edits.set(doc, out);
  }
  return count;
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
  // Remove the folders the moves emptied, deepest first.
  const emptied = new Set<string>();
  for (const from of plan.renames.keys()) {
    for (let dir = dirname(from); dir.startsWith(repoRoot + sep); dir = dirname(dir))
      emptied.add(dir);
  }
  for (const dir of [...emptied].sort((a, b) => b.length - a.length)) {
    if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
  }
}

/**
 * Lines in tracked files that still name an old path, as `file:line:text`.
 * It looks for each requested source by its repo path everywhere, by its
 * package path under `src/` or `dist/` everywhere (configs and bundler inputs
 * spell a path that way), and inside the package by its path below `src/`
 * (comments spell it that way). The last two match only where no other folder
 * name precedes the path, so a path that now sits deeper is not reported.
 */
export function findMentions(repoRoot: string, moves: Move[], plan: MovePlan): string[] {
  const pkgDir = dirname(findTsconfig(moves[0].from));
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const anywhere: string[] = [];
  const inPackage: string[] = [];
  for (const { from } of moves) {
    const isDir = !plan.renames.has(from);
    // A folder ends at its `/`. A file ends where its name does, so `a/b` does not match `a/b-c`.
    const pattern = (p: string): string =>
      escape(toPosix(p).replace(TS_EXTENSION, "")) + (isDir ? "/" : "([^A-Za-z0-9_-]|$)");
    const unprefixed = "(^|[^A-Za-z0-9_./-])";
    anywhere.push(pattern(relative(repoRoot, from)));
    const inPkg = toPosix(relative(pkgDir, from));
    if (inPkg.startsWith("src/")) {
      const belowSrc = inPkg.slice("src/".length);
      anywhere.push(`${unprefixed}(src|dist)/${pattern(belowSrc)}`);
      inPackage.push(`${unprefixed}${pattern(belowSrc)}`);
      // A moved folder is often named by its last segment alone, as in `chat-settings/`.
      if (isDir && belowSrc.includes("/"))
        inPackage.push(`${unprefixed}${pattern(basename(belowSrc))}`);
    }
  }
  const grep = (patterns: string[], pathspecs: string[]): string[] => {
    if (patterns.length === 0) return [];
    const args = [
      "grep",
      "-n",
      "-I",
      "-E",
      ...patterns.flatMap((p) => ["-e", p]),
      "--",
      ...pathspecs,
    ];
    const run = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
    // git grep exits 1 when nothing matches.
    if (run.status !== 0 && run.status !== 1) throw new Error(run.stderr);
    return run.stdout.split("\n").filter(Boolean);
  };
  return [
    ...new Set([...grep(anywhere, ["."]), ...grep(inPackage, [relative(repoRoot, pkgDir) || "."])]),
  ].sort();
}

/**
 * Formats the moved and edited files with Biome and sorts their imports, then
 * stages the moved ones again. Returns false when Biome could not run.
 */
export function formatTouched(repoRoot: string, plan: MovePlan): boolean {
  const moved = (f: string): string => plan.renames.get(f) ?? f;
  const files = [...new Set([...plan.edits.keys()].map(moved).concat([...plan.renames.values()]))];
  if (!biomeFormat(repoRoot, files)) return false;
  const staged = [...plan.renames.values()];
  for (let i = 0; i < staged.length; i += 500)
    git(repoRoot, ["add", "--", ...staged.slice(i, i + 500)]);
  return true;
}

/**
 * Formats the scripts among `files` with Biome and sorts their imports.
 * Returns false when Biome could not run.
 */
export function biomeFormat(repoRoot: string, files: string[]): boolean {
  const scripts = files.filter((f) => /\.[cm]?[jt]sx?$/.test(f));
  if (scripts.length === 0) return true;
  const run = spawnSync(
    "biome",
    [
      "check",
      "--write",
      "--linter-enabled=false",
      "--no-errors-on-unmatched",
      "--files-ignore-unknown=true",
      ...scripts,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return !run.error && run.status === 0;
}

function main(argv: string[]): void {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const dry = flags.delete("--dry");
  const tests = !flags.delete("--no-tests");
  const format = !flags.delete("--no-format");
  const pairs = argv.filter((a) => !a.startsWith("--"));
  if (pairs.length === 0 || flags.size > 0) {
    console.error(
      "usage: pnpm move-files [--dry] [--no-tests] [--no-format] <from>:<to> [<from>:<to> ...]",
    );
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
  const plan = planMoves(repoRoot, moves, { tests });
  if (!dry) applyPlan(repoRoot, plan);
  if (!dry && format && !formatTouched(repoRoot, plan)) {
    console.log(
      "Biome could not run, so the touched files are not formatted. Run `biome check --write` on them.",
    );
  }
  console.log(
    `${dry ? "Would move" : "Moved"} ${plan.renames.size} files and rewrite ${plan.rewritten} import specifiers and ${plan.pathReferences} paths in docs and comments in ${plan.edits.size} files.`,
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
