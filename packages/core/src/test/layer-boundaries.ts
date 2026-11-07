// Import rules for a bounded context laid out as `<context>/<layer>`. The
// layout and the direction of dependencies: DEVELOPMENT.md, "Established
// patterns". The rules, numbered as the violations report them:
//
// 1. <context>/domain/ imports only its own domain/.
// 2. <context>/application/ imports only its own domain/ and application/.
// 3. <context>/infrastructure/ never imports its own application/ or index.ts.
// 4. Code outside the context imports only its index.ts.
//
// Each import is checked by the file it resolves to, through the TypeScript
// resolver and packages/core's tsconfig, so `../`, `./x/..`, `//` and `@/`
// spellings of one file get one verdict. Package imports never break a rule.
// A path that leaves src/ counts as outside every context. An import the
// check cannot place, a path that does not resolve or a dynamic import inside
// a context with a computed path, is reported as `unchecked`.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import ts from "typescript";

/** One import that breaks a rule. `file` is relative to the scanned src directory. */
export interface LayerViolation {
  file: string;
  specifier: string;
  rule: 1 | 2 | 3 | 4 | "unchecked";
  reason: string;
}

type Place =
  | { kind: "outside" }
  | { kind: "domain" | "application" | "infrastructure" | "index" | "other"; context: string };

interface ImportSite {
  specifier: string | null;
  mode: ts.ResolutionMode;
  line: number;
}

/**
 * Checks every `.ts` and `.tsx` file under `srcDir` against the rules for
 * each named context, a folder directly under `srcDir`. `tsconfigPath` gives
 * the resolver options, including path aliases.
 */
export function checkLayerBoundaries(
  srcDir: string,
  tsconfigPath: string,
  contexts: readonly string[],
): LayerViolation[] {
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
      const rule = brokenRule(from, placeOf(target, contexts));
      if (rule)
        violations.push({
          file: at,
          specifier: `${site.specifier} (${target})`,
          rule,
          reason: RULES[rule],
        });
    }
  }
  return violations;
}

/** Renders one violation as a single line: `file:line → specifier (rule N): reason`. */
export function formatLayerViolation(violation: LayerViolation): string {
  return `${violation.file} → ${violation.specifier} (rule ${violation.rule}): ${violation.reason}`;
}

const RULES = {
  1: "domain/ imports only its own domain/",
  2: "application/ imports only its own domain/ and application/",
  3: "infrastructure/ never imports its own application/ or index.ts",
  4: "code outside a context imports only its index.ts",
} as const;

function brokenRule(from: Place, to: Place): 1 | 2 | 3 | 4 | null {
  const sameContext =
    from.kind !== "outside" && to.kind !== "outside" && from.context === to.context;
  switch (from.kind) {
    case "domain":
      return sameContext && to.kind === "domain" ? null : 1;
    case "application":
      return sameContext && (to.kind === "domain" || to.kind === "application") ? null : 2;
    case "infrastructure":
      if (sameContext) return to.kind === "application" || to.kind === "index" ? 3 : null;
      break;
    case "index":
    case "other":
      if (sameContext) return null;
      break;
  }
  return to.kind === "outside" || to.kind === "index" ? null : 4;
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
