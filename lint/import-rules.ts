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
import { layerRules, listedCrossings } from "./rules/layers.js";

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

/**
 * One import that breaks a rule, allowed for now and tracked by a ticket. A
 * listed crossing names the rule, the importing file and the file it
 * resolves to, all relative to the scanned src directory. A listed crossing
 * that no longer occurs is itself reported, so the list only shrinks.
 */
export interface ListedCrossing {
  rule: string;
  from: string;
  to: string;
  ticket: string;
  why: string;
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
 * import that breaks several rules is reported once per rule, unless
 * `listed` names that rule, file and target. `tsconfigPath` gives the
 * resolver options, including path aliases.
 */
export function checkImports(
  srcDir: string,
  tsconfigPath: string,
  rules: readonly ImportRule[],
  listed: readonly ListedCrossing[] = [],
): ImportViolation[] {
  const options = readCompilerOptions(tsconfigPath);
  const cache = ts.createModuleResolutionCache(srcDir, (name) => name, options);
  const violations: ImportViolation[] = [];
  const unseen = new Set(listed);

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
        const crossing =
          imp.kind === "file" &&
          listed.find((c) => c.rule === rule.name && c.from === imp.from && c.to === imp.to);
        if (crossing) {
          unseen.delete(crossing);
          continue;
        }
        const specifier = imp.kind === "file" ? `${imp.specifier} (${imp.to})` : imp.specifier;
        violations.push({ at, specifier, rule: rule.name, reason: rule.description });
      }
    }
  }
  for (const crossing of unseen) {
    violations.push({
      at: crossing.from,
      specifier: crossing.to,
      rule: "stale-listing",
      reason: `The crossing listed under ${crossing.ticket} for ${crossing.rule} no longer occurs. Remove it from the list.`,
    });
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
  const violations = checkImports(
    join(core, "src"),
    join(core, "tsconfig.json"),
    rules,
    listedCrossings,
  );
  if (violations.length > 0) {
    for (const violation of violations) console.error(`  - ${formatImportViolation(violation)}`);
    console.error(`import-rules: ${violations.length} import(s) break a rule`);
    return 1;
  }
  console.log(
    `import-rules: packages/core/src follows all ${rules.length} import rules, with ${listedCrossings.length} listed crossing(s)`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runCli());
}
