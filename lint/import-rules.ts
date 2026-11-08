// Engine for import rules. It parses every file under a src/ directory with
// the TypeScript compiler, resolves each relative or `@/` import through the
// TypeScript resolver and the package's tsconfig, and hands every import to
// each rule. The rules themselves live in rules/. Because imports are judged by
// the file they resolve to, `../`, `./x/..`, `//` and `@/` spellings of one
// file get one verdict. A relative or `@/` path that does not resolve is
// always reported, since no rule can judge it.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { layerRules } from "./rules/layers.js";

/**
 * One import as the rules see it. Paths are relative to the scanned src/
 * directory, with `/` separators. A `file` import names the file it resolves
 * to, which may lie outside src/ (`../…`). A `package` import names no file.
 * A `computed` import is a dynamic `import()` whose path is not a string
 * literal.
 */
export type Import = { from: string; specifier: string } & (
  | { kind: "file"; to: string }
  | { kind: "package" }
  | { kind: "computed" }
);

/** A rule over single imports. */
export interface ImportRule {
  name: string;
  /** Why the rule exists and what it permits, shown with every violation. */
  description: string;
  /** True when `imp` breaks the rule. */
  rejects(imp: Import): boolean;
}

/** One import that breaks a rule. `at` is `file:line`, relative to the scanned src directory. */
export interface ImportViolation {
  at: string;
  specifier: string;
  rule: string;
  reason: string;
}

interface ImportSite {
  specifier: string | null;
  mode: ts.ResolutionMode;
  line: number;
}

/**
 * Checks every `.ts` and `.tsx` file under `srcDir` against `rules`. An
 * import that breaks several rules is reported once per rule. `tsconfigPath`
 * gives the resolver options, including path aliases.
 */
export function checkImports(
  srcDir: string,
  tsconfigPath: string,
  rules: readonly ImportRule[],
): ImportViolation[] {
  const options = readCompilerOptions(tsconfigPath);
  const cache = ts.createModuleResolutionCache(srcDir, (name) => name, options);
  const violations: ImportViolation[] = [];

  for (const path of listSourceFiles(srcDir)) {
    const from = toPosix(relative(srcDir, path));
    for (const site of importSites(path)) {
      const at = `${from}:${site.line}`;
      let imp: Import;
      if (site.specifier === null) {
        imp = { from, specifier: "<computed>", kind: "computed" };
      } else if (!isPathSpecifier(site.specifier)) {
        imp = { from, specifier: site.specifier, kind: "package" };
      } else {
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
            at,
            specifier: site.specifier,
            rule: "unresolved",
            reason: "The import does not resolve, so no rule can judge it.",
          });
          continue;
        }
        const to = toPosix(relative(srcDir, resolved.resolvedFileName));
        imp = { from, specifier: site.specifier, kind: "file", to };
      }
      for (const rule of rules) {
        if (!rule.rejects(imp)) continue;
        const specifier = imp.kind === "file" ? `${imp.specifier} (${imp.to})` : imp.specifier;
        violations.push({ at, specifier, rule: rule.name, reason: rule.description });
      }
    }
  }
  return violations;
}

/** Renders one violation as a single line: `file:line → specifier [rule]: reason`. */
export function formatImportViolation(violation: ImportViolation): string {
  return `${violation.at} → ${violation.specifier} [${violation.rule}]: ${violation.reason}`;
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

/** Checks packages/core/src against every rule set and prints each violation. Returns the exit code. */
export function runCli(): number {
  const core = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "core");
  const rules = [...layerRules];
  const violations = checkImports(join(core, "src"), join(core, "tsconfig.json"), rules);
  if (violations.length > 0) {
    for (const violation of violations) console.error(`  - ${formatImportViolation(violation)}`);
    console.error(`import-rules: ${violations.length} import(s) break a rule`);
    return 1;
  }
  console.log(`import-rules: packages/core/src follows all ${rules.length} import rules`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runCli());
}
