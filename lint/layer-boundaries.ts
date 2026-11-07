// Engine for the layer import rules. The rules themselves are data, in
// layer-rules.ts. The engine parses every file under a src/ directory with
// the TypeScript compiler, resolves each relative or `@/` import through the
// TypeScript resolver and the package's tsconfig, places the importer and the
// resolved file in a context and layer, and asks the rules for a verdict. So
// `../`, `./x/..`, `//` and `@/` spellings of one file get one verdict. An
// import the engine cannot place, a path that does not resolve or a dynamic
// import inside a context with a computed path, is reported as `unchecked`.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { LAYER_RULES } from "./layer-rules.js";

/** Where a file sits in a context: a layer folder, the context's index.ts, or anything else in it. */
export type Layer = "domain" | "application" | "infrastructure" | "index" | "other";

/**
 * A set of import targets, relative to the importer. `same` and `other` name
 * layers in the importer's own context or in a different one, and an
 * importer outside every context sees each context as `other`. `none` is code
 * outside every context.
 */
export type Target = { context: "same" | "other"; layers: Layer[] } | { context: "none" };

/**
 * One import rule. It governs files in the `from` layers, or every file when
 * `from` is absent. A governed import breaks it when it reaches no `allow`
 * target, or any `deny` target.
 */
export interface LayerRule {
  name: string;
  /** Why the rule exists and what it permits, shown with every violation. */
  description: string;
  from?: Layer[];
  allow?: Target[];
  deny?: Target[];
}

/** The folders directly under src/ laid out as `<context>/<layer>`, and the rules for them. */
export interface LayerRules {
  contexts: string[];
  rules: LayerRule[];
}

/** One import that breaks a rule. `file` is relative to the scanned src directory. */
export interface LayerViolation {
  file: string;
  specifier: string;
  rule: string;
  reason: string;
}

type Place = { kind: "outside" } | { kind: Layer; context: string };

interface ImportSite {
  specifier: string | null;
  mode: ts.ResolutionMode;
  line: number;
}

/**
 * Checks every `.ts` and `.tsx` file under `srcDir` against `layerRules`.
 * `tsconfigPath` gives the resolver options, including path aliases.
 */
export function checkLayerBoundaries(
  srcDir: string,
  tsconfigPath: string,
  layerRules: LayerRules,
): LayerViolation[] {
  const { contexts, rules } = layerRules;
  const options = readCompilerOptions(tsconfigPath);
  const cache = ts.createModuleResolutionCache(srcDir, (name) => name, options);
  const violations: LayerViolation[] = [];

  for (const path of listSourceFiles(srcDir)) {
    const file = toPosix(relative(srcDir, path));
    const from = placeOf(file, contexts);
    for (const site of importSites(path)) {
      const at = `${file}:${site.line}`;
      if (site.specifier === null) {
        if (from.kind !== "outside") {
          violations.push({
            file: at,
            specifier: "<computed>",
            rule: "unchecked",
            reason: `a dynamic import inside ${from.context}/ must name its module with a string literal`,
          });
        }
        continue;
      }
      if (!isPathSpecifier(site.specifier)) continue;
      const resolved = ts.resolveModuleName(
        site.specifier,
        path,
        options,
        ts.sys,
        cache,
        undefined,
        site.mode,
      ).resolvedModule;
      if (!resolved) {
        violations.push({
          file: at,
          specifier: site.specifier,
          rule: "unchecked",
          reason: "the import does not resolve, so its layer is unknown",
        });
        continue;
      }
      const target = toPosix(relative(srcDir, resolved.resolvedFileName));
      const rule = brokenRule(rules, from, placeOf(target, contexts));
      if (rule)
        violations.push({
          file: at,
          specifier: `${site.specifier} (${target})`,
          rule: rule.name,
          reason: rule.description,
        });
    }
  }
  return violations;
}

/** Renders one violation as a single line: `file:line → specifier [rule]: reason`. */
export function formatLayerViolation(violation: LayerViolation): string {
  return `${violation.file} → ${violation.specifier} [${violation.rule}]: ${violation.reason}`;
}

function brokenRule(rules: readonly LayerRule[], from: Place, to: Place): LayerRule | undefined {
  return rules.find((rule) => {
    if (rule.from && (from.kind === "outside" || !rule.from.includes(from.kind))) return false;
    if (rule.allow && !rule.allow.some((target) => reaches(target, from, to))) return true;
    return rule.deny?.some((target) => reaches(target, from, to)) ?? false;
  });
}

function reaches(target: Target, from: Place, to: Place): boolean {
  if (to.kind === "outside") return target.context === "none";
  if (target.context === "none") return false;
  const sameContext = from.kind !== "outside" && from.context === to.context;
  return (target.context === "same") === sameContext && target.layers.includes(to.kind);
}

function placeOf(file: string, contexts: readonly string[]): Place {
  const [context, next] = file.split("/");
  if (!contexts.includes(context) || next === undefined) return { kind: "outside" };
  if (next === "domain" || next === "application" || next === "infrastructure")
    return { kind: next, context };
  if (/^index\.tsx?$/.test(next)) return { kind: "index", context };
  return { kind: "other", context };
}

function importSites(path: string): ImportSite[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    false,
  );
  const sites: ImportSite[] = [];
  const add = (node: ts.Node, specifier: string | null, mode: ts.ResolutionMode) =>
    sites.push({
      specifier,
      mode,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });
  const literal = (node: ts.Node | undefined) =>
    node && ts.isStringLiteralLike(node) ? node.text : null;

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = literal(node.moduleSpecifier);
      if (specifier !== null) add(node, specifier, ts.ModuleKind.ESNext);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node, literal(node.moduleReference.expression), ts.ModuleKind.CommonJS);
    } else if (ts.isImportTypeNode(node)) {
      const argument = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
      add(node, literal(argument), ts.ModuleKind.ESNext);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(node, literal(node.arguments[0]), ts.ModuleKind.ESNext);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

function readCompilerOptions(tsconfigPath: string): ts.CompilerOptions {
  const { config, error } = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
  return ts.parseJsonConfigFileContent(config, ts.sys, dirname(tsconfigPath)).options;
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => /\.tsx?$/.test(name) && !name.split(sep).includes("node_modules"))
    .map((name) => join(dir, name))
    .sort();
}

function isPathSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("@/");
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/** Checks packages/core/src and prints each violation. Returns the exit code. */
export function runCli(): number {
  const core = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "core");
  const violations = checkLayerBoundaries(
    join(core, "src"),
    join(core, "tsconfig.json"),
    LAYER_RULES,
  );
  if (violations.length > 0) {
    for (const violation of violations) console.error(`  - ${formatLayerViolation(violation)}`);
    console.error(`layer-boundaries: ${violations.length} import(s) break a layer rule`);
    return 1;
  }
  console.log(
    `layer-boundaries: ${LAYER_RULES.contexts.join(", ")} imports follow the layer rules`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runCli());
}
