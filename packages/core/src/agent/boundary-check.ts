// Import boundaries of the agent bounded context. The layout and the
// direction of dependencies: DEVELOPMENT.md, "Established patterns".
//
// The scan reads source text with regular expressions instead of a parser, so
// the check stays dependency-free. It finds static `import` and `export … from`
// statements, side-effect imports and dynamic `import("…")` calls with a
// literal specifier, after blanking comments.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/** One import that crosses a boundary of the agent context. */
export interface BoundaryViolation {
  /** The importing file, relative to the scanned src directory, with `/` separators. */
  file: string;
  /** The specifier exactly as written in the importing file. */
  specifier: string;
  rule: 1 | 2 | 3 | 4 | 5;
  reason: string;
}

type Layer = "domain" | "application" | "infrastructure" | "index" | "agent-other" | "outside";

interface Binding {
  /** The name the target module exports, or "default". */
  imported: string;
  /** The name bound or re-exported in the importing module. */
  local: string;
}

interface ImportRecord {
  specifier: string;
  kind: "import" | "export" | "dynamic" | "side-effect";
  bindings: Binding[];
  /** True when the record takes the whole module: `* as`, `export *`, or a dynamic import. */
  wholeModule: boolean;
}

const STATIC_PATTERN =
  /\b(import|export)\s+(?:type\s+)?([\w$]+\s*,\s*)?(\{[^}]*\}|\*\s*as\s+[\w$]+|\*|[\w$]+)?\s*from\s*(["'])([^"'\n]+)\4/g;
const SIDE_EFFECT_PATTERN = /\bimport\s*(["'])([^"'\n]+)\1/g;
const DYNAMIC_PATTERN = /\bimport\s*\(\s*(["'`])([^"'`\n]+)\1\s*[,)]/g;
const LOCAL_EXPORT_PATTERN = /\bexport\s+(?:type\s+)?\{([^}]*)\}(?!\s*from\b)/g;
const DECLARATION_EXPORT_PATTERN =
  /\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum|namespace)\s+([\w$]+)/g;
const CODE_EXTENSION = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/;

/**
 * Scans every `.ts` and `.tsx` file under `srcDir` (the `packages/core/src`
 * directory) and returns the imports that break the agent context's rules,
 * sorted by file. An empty list means the tree is clean. Package imports never
 * produce a violation. Reads the file system and throws when `srcDir` is not
 * readable.
 */
export function checkAgentBoundaries(srcDir: string): BoundaryViolation[] {
  const root = resolve(srcDir);
  const infrastructureExports = collectInfrastructureExports(root);
  const violations: BoundaryViolation[] = [];

  for (const absFile of listSourceFiles(root)) {
    const file = toPosix(relative(root, absFile));
    const fromLayer = layerOf(moduleIdOf(absFile, root));
    const isTest = isTestFile(file);
    const mayImportAdapters = isTest || file === "index.ts";

    for (const record of parseImports(readFileSync(absFile, "utf8"))) {
      const target = resolveSpecifier(absFile, record.specifier, root);
      if (target === null) continue;
      const toLayer = layerOf(moduleIdOf(target, root));
      const violation = judge(
        file,
        fromLayer,
        toLayer,
        record,
        isTest,
        mayImportAdapters,
        infrastructureExports,
      );
      if (violation) violations.push(violation);
    }
  }

  return violations.sort(
    (a, b) => a.file.localeCompare(b.file) || a.specifier.localeCompare(b.specifier),
  );
}

/** Renders one violation as a single line: `file → specifier (rule N): reason`. */
export function formatViolation(violation: BoundaryViolation): string {
  return `${baselineEntryOf(violation)} (rule ${violation.rule}): ${violation.reason}`;
}

/** The line that lists this violation in a baseline: `file → specifier`. */
export function baselineEntryOf(violation: BoundaryViolation): string {
  return `${violation.file} → ${violation.specifier}`;
}

/**
 * Compares violations against a baseline of known crossings, one
 * `file → specifier` entry per line. Blank lines and lines starting with `#`
 * are ignored, and surrounding whitespace is trimmed. `unlisted` holds the
 * violations the baseline does not list. `stale` holds the baseline entries
 * that no violation matches, in baseline order.
 */
export function compareWithBaseline(
  violations: BoundaryViolation[],
  baseline: string,
): { unlisted: BoundaryViolation[]; stale: string[] } {
  const entries = baseline
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const listed = new Set(entries);
  const found = new Set(violations.map(baselineEntryOf));
  return {
    unlisted: violations.filter((violation) => !listed.has(baselineEntryOf(violation))),
    stale: entries.filter((entry) => !found.has(entry)),
  };
}

function judge(
  file: string,
  fromLayer: Layer,
  toLayer: Layer,
  record: ImportRecord,
  isTest: boolean,
  mayImportAdapters: boolean,
  infrastructureExports: Set<string>,
): BoundaryViolation | null {
  const violation = (rule: BoundaryViolation["rule"], reason: string): BoundaryViolation => ({
    file,
    specifier: record.specifier,
    rule,
    reason,
  });

  switch (fromLayer) {
    case "domain":
      return toLayer === "domain"
        ? null
        : violation(
            1,
            `agent/domain/ imports ${describeLayer(toLayer)}; domain code imports only agent/domain/`,
          );
    case "application":
      return toLayer === "domain" || toLayer === "application"
        ? null
        : violation(
            2,
            `agent/application/ imports ${describeLayer(toLayer)}; application code imports only agent/domain/ and agent/application/`,
          );
    case "infrastructure":
      if (toLayer === "application")
        return violation(3, "agent/infrastructure/ imports agent/application/");
      if (toLayer === "index")
        return violation(3, "agent/infrastructure/ imports agent/index.ts, which re-exports it");
      return null;
    case "index":
    case "agent-other":
      return null;
    case "outside":
      break;
  }

  if (toLayer === "outside") return null;
  if (toLayer !== "index") {
    return isTest
      ? null
      : violation(
          4,
          `code outside agent/ imports ${describeLayer(toLayer)}; import agent/index.ts instead`,
        );
  }
  if (mayImportAdapters || infrastructureExports.size === 0) return null;
  if (record.wholeModule) {
    return violation(
      5,
      "takes the whole of agent/index.ts, including infrastructure exports; import ports by name",
    );
  }
  const adapters = record.bindings
    .map((binding) => binding.imported)
    .filter((name) => infrastructureExports.has(name));
  if (adapters.length === 0) return null;
  return violation(
    5,
    `imports infrastructure export ${adapters.join(", ")}; only src/index.ts and tests may, other code uses the ports`,
  );
}

function describeLayer(layer: Layer): string {
  switch (layer) {
    case "domain":
      return "agent/domain/";
    case "application":
      return "agent/application/";
    case "infrastructure":
      return "agent/infrastructure/";
    case "index":
      return "agent/index.ts";
    case "agent-other":
      return "a module at the agent/ root";
    case "outside":
      return "code outside agent/";
  }
}

/**
 * Names that `agent/index.ts` re-exports from a module under
 * `agent/infrastructure/`, by the name `index.ts` exports them under. Covers
 * `export … from`, `export * from` (through the target's own exports), and a
 * name imported from infrastructure and then exported in a bare `export { … }`.
 */
function collectInfrastructureExports(root: string): Set<string> {
  const names = new Set<string>();
  const indexFile = sourceFileFor(join(root, "agent", "index"));
  if (indexFile === null) return names;

  const records = parseImports(readFileSync(indexFile, "utf8"));
  const importedFromInfrastructure = new Set<string>();

  for (const record of records) {
    const target = resolveSpecifier(indexFile, record.specifier, root);
    if (target === null || layerOf(moduleIdOf(target, root)) !== "infrastructure") continue;
    if (record.kind === "export") {
      if (record.wholeModule && record.bindings.length === 0) {
        for (const name of exportedNames(target, root, new Set())) names.add(name);
      }
      for (const binding of record.bindings) names.add(binding.local);
    } else if (record.kind === "import") {
      for (const binding of record.bindings) importedFromInfrastructure.add(binding.local);
    }
  }

  const source = stripComments(readFileSync(indexFile, "utf8"));
  for (const match of source.matchAll(LOCAL_EXPORT_PATTERN)) {
    for (const binding of parseBraceList(match[1])) {
      if (importedFromInfrastructure.has(binding.imported)) names.add(binding.local);
    }
  }
  return names;
}

function exportedNames(modulePath: string, root: string, visited: Set<string>): string[] {
  const file = sourceFileFor(modulePath);
  if (file === null || visited.has(file)) return [];
  visited.add(file);

  const source = stripComments(readFileSync(file, "utf8"));
  const names: string[] = [];
  for (const match of source.matchAll(DECLARATION_EXPORT_PATTERN)) names.push(match[1]);
  for (const match of source.matchAll(LOCAL_EXPORT_PATTERN)) {
    for (const binding of parseBraceList(match[1])) names.push(binding.local);
  }
  for (const record of parseImports(source)) {
    if (record.kind !== "export") continue;
    if (record.wholeModule && record.bindings.length === 0) {
      const target = resolveSpecifier(file, record.specifier, root);
      if (target !== null) names.push(...exportedNames(target, root, visited));
    }
    for (const binding of record.bindings) names.push(binding.local);
  }
  return names.filter((name) => name !== "default");
}

function parseImports(rawSource: string): ImportRecord[] {
  const source = stripComments(rawSource);
  const records: ImportRecord[] = [];

  for (const match of source.matchAll(STATIC_PATTERN)) {
    const kind = match[1] === "import" ? "import" : "export";
    const defaultPart = match[2]?.replace(/\s*,\s*$/, "");
    const clause = match[3]?.trim() ?? "";
    const bindings: Binding[] = [];
    let wholeModule = false;

    if (defaultPart) bindings.push({ imported: "default", local: defaultPart });
    if (clause.startsWith("{")) {
      bindings.push(...parseBraceList(clause.slice(1, -1)));
    } else if (clause.startsWith("*")) {
      wholeModule = true;
      const alias = /as\s+([\w$]+)/.exec(clause);
      if (alias) bindings.push({ imported: "*", local: alias[1] });
    } else if (clause) {
      bindings.push({ imported: "default", local: clause });
    }
    records.push({ specifier: match[5], kind, bindings, wholeModule });
  }
  for (const match of source.matchAll(SIDE_EFFECT_PATTERN)) {
    records.push({ specifier: match[2], kind: "side-effect", bindings: [], wholeModule: false });
  }
  for (const match of source.matchAll(DYNAMIC_PATTERN)) {
    if (match[2].includes("${")) continue;
    records.push({ specifier: match[2], kind: "dynamic", bindings: [], wholeModule: true });
  }
  return records;
}

function parseBraceList(body: string): Binding[] {
  return body
    .split(",")
    .map((entry) => entry.trim().replace(/^type\s+/, ""))
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [imported, local] = entry.split(/\s+as\s+/);
      return { imported, local: local ?? imported };
    });
}

/**
 * Blanks `//` and `/* *\/` comments and keeps string literals, so an import
 * written inside a comment is not scanned. A quoted string ends at a newline,
 * which bounds the damage when a regex literal holding a quote opens a false
 * string.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (char === '"' || char === "'" || char === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== char) {
        if (source[j] === "\n" && char !== "`") break;
        j += source[j] === "\\" ? 2 : 1;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
    } else {
      out += char;
      i += 1;
    }
  }
  return out;
}

/** Absolute path of the imported module, or null for a package import. */
function resolveSpecifier(fromFile: string, specifier: string, root: string): string | null {
  if (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier === "." ||
    specifier === ".."
  ) {
    return resolve(dirname(fromFile), specifier);
  }
  if (specifier.startsWith("@/")) return join(root, specifier.slice(2));
  return null;
}

/**
 * The module's path relative to `root`, with `/` separators, no code
 * extension, and `/index` appended for a directory. "agent/index.js",
 * "agent/index" and "agent" all map to "agent/index".
 */
function moduleIdOf(absPath: string, root: string): string {
  let base = absPath.replace(CODE_EXTENSION, "");
  if (isDirectory(base)) base = join(base, "index");
  return toPosix(relative(root, base));
}

function layerOf(moduleId: string): Layer {
  if (moduleId === "agent/index") return "index";
  if (moduleId.startsWith("agent/domain/")) return "domain";
  if (moduleId.startsWith("agent/application/")) return "application";
  if (moduleId.startsWith("agent/infrastructure/")) return "infrastructure";
  if (moduleId.startsWith("agent/")) return "agent-other";
  return "outside";
}

function sourceFileFor(modulePath: string): string | null {
  const base = modulePath.replace(CODE_EXTENSION, "");
  const candidates = isDirectory(base)
    ? [join(base, "index.ts"), join(base, "index.tsx")]
    : [`${base}.ts`, `${base}.tsx`];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function isTestFile(file: string): boolean {
  return /\.test\.tsx?$/.test(file) || file.startsWith("test/");
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(path));
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}
