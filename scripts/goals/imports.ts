// forbidImports, a ready-made Check that counts imports crossing a boundary.
// Contract: the "Helper: forbidden imports" section of the goals contract.
// Globs follow scripts/merge-gate/glob.ts. Node built-ins only, so a check
// file that uses it runs without a dependency install.

import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { matchesGlob } from "../merge-gate/glob.js";
import type { Check } from "./types.js";

export interface ForbidImportsOptions {
  name: string;
  description: string;
  /** Globs of files that must not import. */
  from: string[];
  /** Globs of files that must not be imported. */
  to: string[];
  /** Globs of importing files that are exempt. */
  except?: string[];
  /** Import prefix to repo-root folder, such as { "@/": "packages/core/src/" }. */
  aliases?: Record<string, string>;
}

const SOURCE = /\.(ts|tsx|mts|js|mjs)$/;

/**
 * A Check with one violation per importing file and resolved target, as
 * "<importing file>: imports <target>" in repo-root paths, sorted. Targets need
 * not exist on disk. Package specifiers are ignored.
 */
export function forbidImports(opts: ForbidImportsOptions): Check {
  const except = opts.except ?? [];
  const aliases = Object.entries(opts.aliases ?? {}).sort((a, b) => b[0].length - a[0].length);
  return {
    name: opts.name,
    description: opts.description,
    violations({ root }) {
      const out = new Set<string>();
      for (const file of sourceFiles(root, opts.from)) {
        if (!opts.from.some((g) => matchesGlob(g, file))) continue;
        if (except.some((g) => matchesGlob(g, file))) continue;
        const text = readFileSync(join(root, file), "utf8");
        for (const spec of importSpecifiers(text)) {
          const target = resolveSpecifier(file, spec, aliases);
          if (target !== undefined && targetMatches(target, opts.to)) {
            out.add(`${file}: imports ${target}`);
          }
        }
      }
      return [...out].sort();
    },
  };
}

/** The repo-root path `spec` names when imported from `file`, or undefined for a package. */
export function resolveSpecifier(
  file: string,
  spec: string,
  aliases: [prefix: string, folder: string][],
): string | undefined {
  if (spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../")) {
    return posix.normalize(posix.join(posix.dirname(file), spec));
  }
  for (const [prefix, folder] of aliases) {
    if (spec.startsWith(prefix)) return posix.normalize(folder + spec.slice(prefix.length));
  }
  return undefined;
}

/** True when `target`, as written or under one of its source-file readings, matches a glob. */
export function targetMatches(target: string, globs: string[]): boolean {
  const candidates = [target];
  const base = target.slice(target.lastIndexOf("/") + 1);
  if (target.endsWith(".js")) {
    const stem = target.slice(0, -3);
    candidates.push(`${stem}.ts`, `${stem}.tsx`);
  } else if (target.endsWith(".mjs")) {
    candidates.push(`${target.slice(0, -4)}.mts`);
  } else if (!base.includes(".")) {
    candidates.push(`${target}.ts`, `${target}.tsx`, `${target}/index.ts`);
  }
  return candidates.some((c) => globs.some((g) => matchesGlob(g, c)));
}

// Walks only the folders a `from` glob can reach: the literal segments before
// its first wildcard. In a large repository this skips most of the tree.
function sourceFiles(root: string, from: string[]): string[] {
  const starts = new Set<string>();
  for (const glob of from) {
    const segments = glob.split("/").slice(0, -1);
    const literal: string[] = [];
    for (const s of segments) {
      if (/[*?]/.test(s)) break;
      literal.push(s);
    }
    starts.add(literal.join("/"));
  }
  const sorted = [...starts].sort();
  const kept = sorted.filter(
    (s) => !sorted.some((o) => o !== s && (o === "" || s.startsWith(`${o}/`))),
  );
  const files = new Set<string>();
  for (const start of kept) walk(root, start, files);
  return [...files];
}

function walk(root: string, rel: string, files: Set<string>): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const path = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) {
      // .git holds no source tree files, and walking its objects is slow.
      if (e.name !== "node_modules" && e.name !== ".git") walk(root, path, files);
    } else if (e.isFile() && SOURCE.test(e.name)) {
      files.add(path);
    }
  }
}

type Token = { kind: "word" | "punct" | "string" | "other"; value: string };

// Statement forms between `import`/`export` and `from`: names, braces, commas,
// `*`, and the words `type`, `as`, `default`.
const CLAUSE_PUNCT = new Set([",", "{", "}", "*"]);

/**
 * The specifiers of static imports and re-exports, side-effect imports, and
 * dynamic imports with a string literal, in source order. Comments are skipped.
 */
export function importSpecifiers(source: string): string[] {
  const tokens = tokenize(source);
  const specs: string[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.kind !== "word" || (t.value !== "import" && t.value !== "export")) continue;
    if (tokens[k - 1]?.kind === "punct" && tokens[k - 1]?.value === ".") continue;
    const next = tokens[k + 1];
    if (t.value === "import") {
      if (next?.kind === "string") {
        specs.push(next.value);
        continue;
      }
      if (next?.kind === "punct" && next.value === "(") {
        const arg = tokens[k + 2];
        if (arg?.kind === "string") specs.push(arg.value);
        continue;
      }
    }
    for (let j = k + 1; j < tokens.length; j++) {
      const u = tokens[j];
      if (u.kind === "word" && u.value === "from" && tokens[j + 1]?.kind === "string") {
        specs.push(tokens[j + 1].value);
        break;
      }
      if (u.kind === "word" || (u.kind === "punct" && CLAUSE_PUNCT.has(u.value))) continue;
      break;
    }
  }
  return specs;
}

// Words after which a `/` starts a regular expression rather than a division.
const BEFORE_EXPRESSION = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

// A tokenizer just precise enough to tell code from comments, strings,
// template literals and regular expressions. A template's `${` records the
// brace depth it opened at, so the `}` that returns to that depth resumes the
// template instead of closing a block.
function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const templateDepths: number[] = [];
  let depth = 0;
  let i = 0;

  const readTemplate = (from: number): number => {
    let p = from;
    while (p < src.length) {
      const c = src[p];
      if (c === "\\") p += 2;
      else if (c === "`") return p + 1;
      else if (c === "$" && src[p + 1] === "{") {
        templateDepths.push(depth);
        return p + 2;
      } else p += 1;
    }
    return p;
  };

  const regexAllowed = (): boolean => {
    const prev = tokens[tokens.length - 1];
    if (!prev) return true;
    if (prev.kind === "word") return BEFORE_EXPRESSION.has(prev.value);
    if (prev.kind === "punct")
      return prev.value !== ")" && prev.value !== "]" && prev.value !== "}";
    return false;
  };

  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      i = end === -1 ? src.length : end;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (c === "'" || c === '"') {
      let value = "";
      let p = i + 1;
      while (p < src.length && src[p] !== c && src[p] !== "\n") {
        if (src[p] === "\\") {
          value += src[p + 1] ?? "";
          p += 2;
        } else {
          value += src[p];
          p += 1;
        }
      }
      tokens.push({ kind: "string", value });
      i = p + 1;
    } else if (c === "`") {
      i = readTemplate(i + 1);
      tokens.push({ kind: "other", value: "`" });
    } else if (c === "}" && templateDepths.at(-1) === depth) {
      templateDepths.pop();
      i = readTemplate(i + 1);
      tokens.push({ kind: "other", value: "`" });
    } else if (c === "/" && regexAllowed()) {
      let p = i + 1;
      let inClass = false;
      while (p < src.length && src[p] !== "\n") {
        const r = src[p];
        if (r === "\\") p += 1;
        else if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
        p += 1;
      }
      p += 1;
      while (p < src.length && /[a-z]/i.test(src[p])) p += 1;
      tokens.push({ kind: "other", value: "/" });
      i = p;
    } else if (/[\w$]/.test(c) || c.charCodeAt(0) > 127) {
      let p = i + 1;
      while (p < src.length && (/[\w$]/.test(src[p]) || src.charCodeAt(p) > 127)) p += 1;
      tokens.push({ kind: "word", value: src.slice(i, p) });
      i = p;
    } else {
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      tokens.push({ kind: "punct", value: c });
      i += 1;
    }
  }
  return tokens;
}
