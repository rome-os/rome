// Reads an app directory into the facts the capability rules judge. It parses
// `app.yaml` and every `action.yaml` with the packaging schemas, and the app's
// TypeScript with the compiler. It runs nothing from the app.

import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type TS from "typescript";
import { parse as parseYaml } from "yaml";
import { isAppApiPathNoAuth } from "../no-auth.js";
import { parseAppManifest, parseManifestObject } from "../packaging/manifest.js";
import type {
  PageApiCallFacts,
  ActionFacts,
  AppFacts,
  ArgumentDescriptions,
  ImportFacts,
  PageRequestFacts,
  RouteFacts,
} from "./facts.js";

// The compiler is a development tool, absent from the runtime image that also
// ships this CLI, so it loads when a check runs, not when the module does.
let ts: typeof TS;

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts"];
const ROUTE_SUBJECT = /(^|\.)(route|path|subPath|pathname|head|id|segment|resource)(\[\d+\])?$/;
const DRIZZLE_WRITES = new Set(["insert", "update", "delete"]);
/** Drizzle calls that run raw SQL, which writes unless it reads as a query. */
const RAW_SQL = new Set(["run", "execute", "exec"]);
const DB_RECEIVER = /(^|\.)(db|tx|connection)$/;
/** Data-layer functions named like this change app data. */
const WRITE_NAME =
  /^(insert|update|delete|upsert|remove|set|save|create|clear|put|add|mark|record|replace|patch|append|bump|increment|reset|toggle|move|rename|archive|restore)/i;
/** Calls through which a page reaches past its app API. */
const DIRECT_REQUESTS = new Set([
  "fetch",
  "window.fetch",
  "globalThis.fetch",
  "XMLHttpRequest",
  "EventSource",
  "WebSocket",
  "axios",
  "axios.get",
  "axios.post",
]);
/** SDK calls through which a page reaches its own app API. */
const APP_API_CALLS = new Set(["fetchAppApi", "appApiUrl"]);
const ZOD_ADDS_FIELDS = new Set(["extend", "merge", "and", "safeExtend"]);
/** A factory that opens a repository writes nothing by itself. */
const OPENS_STORE = /(Repository|Repo|Store|Client)$/;
/** How deep the reader follows calls from a route to find the actions it runs. */
const MAX_CALL_DEPTH = 8;

export async function readApp(dir: string): Promise<AppFacts> {
  ts ??= createRequire(import.meta.url)("typescript") as typeof TS;
  const manifestPath = join(dir, "app.yaml");
  const manifest = parseAppManifest(await parseManifestObject(manifestPath), manifestPath);
  const sourceRoot = manifest.appRoot && existsSync(join(dir, "src")) ? "src" : ".";
  const sourceDir = join(dir, sourceRoot);

  const files = listSourceFiles(sourceDir);
  const program = ts.createProgram(files, {
    allowJs: true,
    noEmit: true,
    skipLibCheck: true,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    ...appPathAliases(dir),
  });
  const reader = new SourceReader(program, dir, sourceDir);

  const actions = (manifest.actions ?? []).map((entry) =>
    readAction(reader, dir, join(sourceDir, typeof entry === "string" ? entry : entry.path)),
  );

  const apiEntry = manifest.api ? (manifest.api.entry ?? "api/index") : undefined;
  const noAuth = manifest.api?.noAuth ?? false;
  let routes: RouteFacts[] | null = [];
  let apiEntryAt: string | undefined;
  if (apiEntry) {
    const entryFile = resolveSourceFile(join(sourceDir, apiEntry));
    apiEntryAt = entryFile ? reader.at(entryFile) : `${sourceRoot}/${apiEntry}`;
    const found = entryFile ? reader.routes(entryFile) : [];
    routes =
      found.length === 0
        ? null
        : found.map((route) => {
            const machine = (path: string) =>
              isAppApiPathNoAuth(noAuth as boolean | string[], `/${path}`);
            const paths = route.alternatives ?? [route.path];
            const machinePaths = paths.filter(machine).length;
            // `route === "webhook" || route === "erase"` is a machine route for one path only.
            const mixed = machinePaths > 0 && machinePaths < paths.length;
            const unreadable =
              route.unreadable ??
              (mixed
                ? `paths ${paths.map((p) => `\`/${p}\``).join(" and ")} that are not all machine routes`
                : undefined);
            return {
              ...route,
              ...(unreadable ? { unreadable } : {}),
              noAuth: unreadable === undefined && machinePaths === paths.length,
              mayBeNoAuth:
                unreadable !== undefined &&
                (mixed || noAuth === true || (Array.isArray(noAuth) && noAuth.length > 0)),
            };
          });
  }

  const imports = reader.imports();
  const pageFiles = reader.pageFiles(imports);
  return {
    id: manifest.id,
    dir,
    description: manifest.description,
    hasPage: manifest.web !== undefined,
    sourceRoot,
    actions,
    routes,
    ...(apiEntryAt ? { apiEntry: apiEntryAt } : {}),
    imports,
    pageRequests: reader.pageRequests(pageFiles),
    pageApiCalls: reader.pageApiCalls(pageFiles),
    pageCrossings: imports.filter(
      (imp) =>
        // A type-only import is erased from the page bundle.
        pageFiles.has(imp.from) &&
        !/^(web|api|actions|db)\//.test(imp.from) &&
        !imp.typeOnly &&
        /^(api|actions|db)\//.test(imp.to),
    ),
  };
}

function readAction(reader: SourceReader, appDir: string, actionDir: string): ActionFacts {
  const yamlPath = join(actionDir, "action.yaml");
  const config = parseYaml(readFileSync(yamlPath, "utf8")) as Record<string, unknown>;
  const entry = typeof config.entry === "string" ? config.entry : "index";
  const entryFile = resolveSourceFile(join(actionDir, entry.replace(/\.(m?js|ts)$/, "")));
  const schema = entryFile ? reader.inputSchema(entryFile) : undefined;
  return {
    name: String(config.name),
    at: relative(appDir, actionDir).split(sep).join("/"),
    description: String(config.description ?? ""),
    visibility: config.visibility === "explicit" ? "explicit" : "public",
    sideEffects: config.sideEffects === "write" ? "write" : "read-only",
    webhook: config.webhook === true,
    hasInputSchema: schema !== undefined,
    arguments: schema ? reader.argumentDescriptions(schema) : { kind: "described" },
  };
}

class SourceReader {
  private readonly checker: TS.TypeChecker;

  constructor(
    private readonly program: TS.Program,
    private readonly appDir: string,
    private readonly sourceDir: string,
  ) {
    this.checker = program.getTypeChecker();
  }

  /** `file:line` relative to the app directory. */
  at(file: string, node?: TS.Node): string {
    const path = relative(this.appDir, file).split(sep).join("/");
    if (!node) return path;
    const source = node.getSourceFile();
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    return `${path}:${line + 1}`;
  }

  private ownFile(file: string): boolean {
    return !relative(this.sourceDir, file).startsWith("..") && !file.includes("node_modules");
  }

  /** Every import between two of the app's own source files. */
  imports(): ImportFacts[] {
    const found: ImportFacts[] = [];
    for (const source of this.program.getSourceFiles()) {
      if (!this.ownFile(source.fileName) || isTestFile(source.fileName)) continue;
      const visit = (node: TS.Node) => {
        let specifier: TS.Expression | undefined;
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          specifier = node.moduleSpecifier;
        } else if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword
        ) {
          specifier = node.arguments[0];
        }
        if (specifier && ts.isStringLiteral(specifier)) {
          const resolved = ts.resolveModuleName(
            specifier.text,
            source.fileName,
            this.program.getCompilerOptions(),
            ts.sys,
          ).resolvedModule?.resolvedFileName;
          const target = resolved ?? join(dirname(source.fileName), specifier.text);
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          found.push({
            from: this.fromSource(source.fileName),
            to: this.fromSource(target),
            line: line + 1,
            ...(isTypeOnly(node) ? { typeOnly: true } : {}),
          });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    return found;
  }

  /**
   * Requests the page makes past its app API, such as a bare `fetch`, in its
   * own files and in the shared files it imports. Imports of the API, the
   * actions or the data are I4 gaps of their own, so their files are not read.
   */
  /** The files the page is built from: web/, and the app's own files it imports. */
  pageFiles(imports: readonly ImportFacts[]): Set<string> {
    const pageFiles = new Set<string>();
    const queue = this.program
      .getSourceFiles()
      .map((source) => this.fromSource(source.fileName))
      .filter((file) => file.startsWith("web/"));
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (pageFiles.has(file)) continue;
      pageFiles.add(file);
      for (const imp of imports) {
        // Everything the page bundles is the page; only erased types are not.
        if (imp.from === file && !imp.typeOnly && !imp.to.startsWith("..")) {
          queue.push(imp.to);
        }
      }
    }
    return pageFiles;
  }

  pageRequests(pageFiles: ReadonlySet<string>): PageRequestFacts[] {
    const found: PageRequestFacts[] = [];
    for (const source of this.program.getSourceFiles()) {
      if (!this.ownFile(source.fileName) || isTestFile(source.fileName)) continue;
      if (!pageFiles.has(this.fromSource(source.fileName))) continue;
      const visit = (node: TS.Node) => {
        const callee =
          ts.isCallExpression(node) || ts.isNewExpression(node) ? node.expression : undefined;
        const name = callee && compact(callee.getText());
        if (name && DIRECT_REQUESTS.has(name)) {
          const first =
            node.kind === ts.SyntaxKind.CallExpression || ts.isNewExpression(node)
              ? (node as TS.CallExpression).arguments?.[0]
              : undefined;
          found.push({
            at: this.at(source.fileName, node),
            call: name,
            target: first ? compact(first.getText()).slice(0, 60) : "",
          });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    return found;
  }

  /**
   * The page's calls to its app API, by the path each calls. A path passed
   * in by a caller is read at each call site in the page.
   */
  pageApiCalls(pageFiles: ReadonlySet<string>): PageApiCallFacts[] {
    const found: PageApiCallFacts[] = [];
    const pageSources = this.program
      .getSourceFiles()
      .filter(
        (source) =>
          this.ownFile(source.fileName) &&
          !isTestFile(source.fileName) &&
          pageFiles.has(this.fromSource(source.fileName)),
      );
    for (const source of pageSources) {
      const visit = (node: TS.Node) => {
        const call = ts.isCallExpression(node) ? this.appApiCall(node) : undefined;
        if (call && ts.isCallExpression(node)) {
          const method = call === "appApiUrl" ? "GET" : this.callMethod(node.arguments[1]);
          for (const path of this.calledPaths(node.arguments[0], pageSources)) {
            found.push({ at: this.at(source.fileName, node), path, method });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    return found;
  }

  /**
   * Which SDK call reaches the app API here, if any: by the name it is
   * imported under (`fetchAppApi as api`), or through the SDK's namespace.
   */
  private appApiCall(node: TS.CallExpression): string | undefined {
    const callee = node.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      return APP_API_CALLS.has(callee.name.text) ? callee.name.text : undefined;
    }
    if (!ts.isIdentifier(callee)) return undefined;
    const declaration = this.checker.getSymbolAtLocation(callee)?.declarations?.[0];
    if (declaration && ts.isImportSpecifier(declaration)) {
      const imported = (declaration.propertyName ?? declaration.name).text;
      return APP_API_CALLS.has(imported) ? imported : undefined;
    }
    return APP_API_CALLS.has(callee.text) ? callee.text : undefined;
  }

  /** The method a `RequestInit` names: `GET` without one, null when the reader cannot tell. */
  private callMethod(init: TS.Expression | undefined): string | null {
    if (!init) return "GET";
    const literal = this.followIdentifier(init);
    if (!literal || !ts.isObjectLiteralExpression(literal)) return null;
    if (literal.properties.some((p) => ts.isSpreadAssignment(p))) return null;
    const method = propertyValue(literal, "method");
    if (!method) return "GET";
    return this.stringLiteral(method)?.toUpperCase() ?? null;
  }

  /** The app API paths an argument can stand for; `[null]` when the reader cannot tell. */
  private calledPaths(
    argument: TS.Expression | undefined,
    pageSources: readonly TS.SourceFile[],
    hops = 0,
  ): (string | null)[] {
    if (!argument) return [""];
    const text = this.stringLiteral(argument);
    if (text !== undefined) return [normalizeCallPath(text)];
    if (ts.isTemplateExpression(argument)) {
      let path = argument.head.text;
      for (const span of argument.templateSpans) path += `\u0000${span.literal.text}`;
      const normalized = normalizeCallPath(path);
      // A path whose first segment is computed could be any route.
      return [normalized === ":id" || normalized.startsWith(":id/") ? null : normalized];
    }
    // A path the enclosing function takes as a parameter: read each call site.
    const declaration = ts.isIdentifier(argument) ? this.declarationOf(argument)[0] : undefined;
    if (hops < 2 && declaration && ts.isParameter(declaration)) {
      const owner = declaration.parent;
      const index = owner.parameters.indexOf(declaration);
      const name = owner.name && ts.isIdentifier(owner.name) ? owner.name : undefined;
      const ownerName =
        name ??
        (ts.isVariableDeclaration(owner.parent) && ts.isIdentifier(owner.parent.name)
          ? owner.parent.name
          : undefined);
      if (!ownerName) return [null];
      const ownerSymbol = this.checker.getSymbolAtLocation(ownerName);
      const paths: (string | null)[] = [];
      for (const source of pageSources) {
        const visit = (node: TS.Node) => {
          if (ts.isCallExpression(node) && ownerSymbol) {
            let symbol = this.checker.getSymbolAtLocation(node.expression);
            if (symbol && symbol.flags & ts.SymbolFlags.Alias)
              symbol = this.checker.getAliasedSymbol(symbol);
            if (symbol === ownerSymbol) {
              paths.push(...this.calledPaths(node.arguments[index], pageSources, hops + 1));
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
      return paths.length > 0 ? paths : [null];
    }
    return [null];
  }

  private fromSource(file: string): string {
    return relative(this.sourceDir, file).split(sep).join("/");
  }

  /**
   * The expression an action module hands Rome as its input schema: the
   * `inputSchema` it returns, or the `schema` it passes `defineAction`.
   * Undefined when it hands none. Looks in the entry file, then in the files
   * it imports, since an entry may re-export an action built elsewhere.
   */
  inputSchema(entryFile: string): TS.Expression | undefined {
    const entry = this.program.getSourceFile(entryFile);
    if (!entry) return undefined;
    const inEntry = findInputSchema(entry);
    if (inEntry) return inEntry;
    for (const imp of this.importsOf(entry)) {
      const source = this.program.getSourceFile(imp);
      const found = source && findInputSchema(source);
      if (found) return found;
    }
    return undefined;
  }

  private importsOf(source: TS.SourceFile): string[] {
    const files: string[] = [];
    for (const statement of source.statements) {
      if (
        (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text.startsWith(".")
      ) {
        const resolved = ts.resolveModuleName(
          statement.moduleSpecifier.text,
          source.fileName,
          this.program.getCompilerOptions(),
          ts.sys,
        ).resolvedModule?.resolvedFileName;
        if (resolved && this.ownFile(resolved)) files.push(resolved);
      }
    }
    return files;
  }

  argumentDescriptions(schema: TS.Expression): ArgumentDescriptions {
    const node = this.followIdentifier(schema);
    if (!node) return { kind: "unknown" };
    if (ts.isObjectLiteralExpression(node)) return this.jsonSchemaArguments(node);
    const zodShape = findZodObjectShape(node);
    if (zodShape) {
      const undescribed: string[] = [];
      for (const property of zodShape.properties) {
        const value = ts.isPropertyAssignment(property)
          ? this.followIdentifier(property.initializer)
          : ts.isShorthandPropertyAssignment(property)
            ? this.followIdentifier(property.name)
            : undefined;
        if (!value) return { kind: "unknown" };
        const described = this.zodFieldDescribed(value);
        if (described === undefined) return { kind: "unknown" };
        if (!described) undescribed.push(propertyName(property));
      }
      return undescribed.length === 0
        ? { kind: "described" }
        : { kind: "undescribed", names: undescribed };
    }
    return { kind: "unknown" };
  }

  /**
   * Whether a zod field's own outermost chain gives it a description: a
   * `.describe(...)`, or a `.meta(...)` whose object carries `description`.
   * Undefined when it passes `.meta` something the reader cannot see into.
   */
  private zodFieldDescribed(node: TS.Expression): boolean | undefined {
    let current: TS.Expression = node;
    while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
      const name = current.expression.name.text;
      if (name === "describe") return true;
      if (name === "meta") {
        const first = current.arguments[0] && this.followIdentifier(current.arguments[0]);
        if (!first || !ts.isObjectLiteralExpression(first)) return undefined;
        if (first.properties.some((p) => ts.isSpreadAssignment(p))) return undefined;
        if (propertyValue(first, "description")) return true;
      }
      current = current.expression.expression;
    }
    return false;
  }

  private jsonSchemaArguments(schema: TS.ObjectLiteralExpression): ArgumentDescriptions {
    if (schema.properties.some((p) => ts.isSpreadAssignment(p))) return { kind: "unknown" };
    if (this.composesArguments(schema)) return { kind: "unknown" };
    const properties = propertyValue(schema, "properties");
    if (!properties) return { kind: "described" };
    const literal = this.followIdentifier(properties);
    if (!literal || !ts.isObjectLiteralExpression(literal)) return { kind: "unknown" };
    const undescribed: string[] = [];
    for (const property of literal.properties) {
      if (ts.isSpreadAssignment(property)) return { kind: "unknown" };
      const value = ts.isPropertyAssignment(property)
        ? this.followIdentifier(property.initializer)
        : undefined;
      if (!value || !ts.isObjectLiteralExpression(value)) return { kind: "unknown" };
      if (!propertyValue(value, "description")) undescribed.push(propertyName(property));
    }
    return undescribed.length === 0
      ? { kind: "described" }
      : { kind: "undescribed", names: undescribed };
  }

  /**
   * Whether arguments may also come from a referenced or composed schema. A
   * composed branch that only adds rules, such as `if`/`then` required lists,
   * adds no arguments.
   */
  private composesArguments(schema: TS.ObjectLiteralExpression): boolean {
    if (propertyValue(schema, "$ref") || propertyValue(schema, "patternProperties")) return true;
    const branches: TS.Expression[] = [];
    for (const key of ["allOf", "anyOf", "oneOf"]) {
      const value = propertyValue(schema, key);
      if (!value) continue;
      const list = this.followIdentifier(value);
      if (!list || !ts.isArrayLiteralExpression(list)) return true;
      branches.push(...list.elements);
    }
    for (const key of ["then", "else"]) {
      const value = propertyValue(schema, key);
      if (value) branches.push(value);
    }
    return branches.some((branch) => {
      const literal = this.followIdentifier(branch);
      if (!literal || !ts.isObjectLiteralExpression(literal)) return true;
      if (literal.properties.some((p) => ts.isSpreadAssignment(p))) return true;
      return propertyValue(literal, "properties") !== undefined || this.composesArguments(literal);
    });
  }

  /** The initializer an identifier names, or the expression itself. */
  private followIdentifier(node: TS.Expression): TS.Expression | undefined {
    let current: TS.Expression = node;
    for (let hops = 0; hops < 5; hops++) {
      while (
        ts.isAsExpression(current) ||
        ts.isSatisfiesExpression(current) ||
        ts.isParenthesizedExpression(current)
      ) {
        current = current.expression;
      }
      if (!ts.isIdentifier(current)) return current;
      const declaration = this.declarationOf(current)[0];
      if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) {
        return undefined;
      }
      current = declaration.initializer;
    }
    return undefined;
  }

  private declarationOf(node: TS.Node): TS.Declaration[] {
    // `{ schema }` names the variable `schema`, not the property it makes.
    let symbol =
      node.parent && ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
        ? this.checker.getShorthandAssignmentValueSymbol(node.parent)
        : this.checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias)
      symbol = this.checker.getAliasedSymbol(symbol);
    return (symbol?.declarations ?? []).filter((d) => this.ownFile(d.getSourceFile().fileName));
  }

  /** The routes an app API entry file dispatches, with the actions each runs. */
  routes(entryFile: string): Omit<RouteFacts, "noAuth" | "mayBeNoAuth">[] {
    const entry = this.program.getSourceFile(entryFile);
    if (!entry) return [];
    const literal: LiteralOf = (node) => this.stringLiteral(node);
    const branches = routeBranches(entry, literal);
    const thens = new Set(branches.map((branch) => branch.then));
    const routes: Omit<RouteFacts, "noAuth" | "mayBeNoAuth">[] = [];
    for (const branch of branches) {
      const inner = branches.filter(
        (other) => other !== branch && contains(branch.then, other.node),
      );
      const innerThens = new Set(inner.map((other) => other.then));
      // A route test with narrower tests inside it is a route only for the
      // code that runs outside them, such as a write after a method check.
      const { handsOff, ...effects } = this.effects(branch.then, innerThens);
      let unreadable = handsOff && `it hands off to ${handsOff}, which the reader cannot split`;
      if (inner.length > 0 && !unreadable && effects.runs.length + effects.writes.length === 0) {
        // Code that answers after the narrower tests may be a route that runs
        // nothing, or only a "not allowed" reply; the reader cannot tell which.
        if (!hasExit(branch.then, innerThens)) continue;
        unreadable = "code that answers after its narrower route tests";
      }
      const conditions = [branch.condition, ...enclosingRouteConditions(branch.node, literal)];
      const described = describeRoute(conditions.reverse(), literal);
      routes.push({
        ...described,
        ...(unreadable ? { unreadable } : {}),
        at: this.at(entryFile, branch.node),
        ...effects,
      });
    }
    // A switch on the method or path dispatches routes the reader cannot follow.
    const findSwitches = (node: TS.Node) => {
      if (ts.isSwitchStatement(node) && isDispatchSubject(node.expression.getText())) {
        routes.push({
          method: "ANY",
          path: "?",
          at: this.at(entryFile, node),
          runs: [],
          writes: [],
          unreadable: `a \`switch (${node.expression.getText()})\` dispatch`,
        });
      }
      ts.forEachChild(node, findSwitches);
    };
    findSwitches(entry);
    // Code in a dispatching function outside every route test it recognizes,
    // such as a helper predicate or a write after the last route, still runs
    // for some request.
    const holders = new Set(branches.map((branch) => enclosingFunction(branch.node)));
    for (const holder of holders) {
      if (!holder?.body) continue;
      const tests = unreadRequestTests(holder.body, thens);
      for (const test of tests) {
        const then = ts.isIfStatement(test) ? test.thenStatement : test.whenTrue;
        const { handsOff: _, ...effects } = this.effects(then, thens);
        routes.push({
          method: "ANY",
          path: "?",
          at: this.at(entryFile, test),
          ...effects,
          unreadable: "a test on the request the reader cannot read as a route",
        });
      }
      const placed = new Set<TS.Node>([
        ...thens,
        ...tests.map((test) => (ts.isIfStatement(test) ? test.thenStatement : test.whenTrue)),
      ]);
      const { handsOff, ...rest } = this.effects(holder.body, placed);
      if (rest.runs.length + rest.writes.length === 0 && !handsOff) continue;
      routes.push({
        method: "ANY",
        path: "?",
        at: this.at(entryFile, holder),
        ...rest,
        unreadable: handsOff
          ? `code outside its route tests hands off to ${handsOff}`
          : "code outside any route test the reader recognizes",
      });
    }
    return routes;
  }

  /**
   * What `node` does through the app's own calls: the names it passes to
   * `runAction`, and the app data it writes itself, without an action.
   */
  private effects(
    node: TS.Node,
    skip: ReadonlySet<TS.Node> = new Set(),
  ): { runs: string[]; writes: string[]; handsOff?: string } {
    const names = new Set<string>();
    let handsOff: string | undefined;
    const literal: LiteralOf = (expression) => this.stringLiteral(expression);
    const writes = new Set<string>();
    const seen = new Set<TS.Node>();
    const walk = (current: TS.Node, depth: number) => {
      if (skip.has(current)) return;
      if (ts.isCallExpression(current)) {
        const callee = current.expression;
        const calleeName = ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : ts.isIdentifier(callee)
            ? callee.text
            : undefined;
        if (ts.isElementAccessExpression(callee)) {
          handsOff ??= `a call through \`${compact(callee.getText())}\``;
        }
        if (calleeName === "runAction" || calleeName === "invokeAction") {
          const first = current.arguments[0];
          names.add(first && ts.isStringLiteralLike(first) ? first.text : "<dynamic>");
        } else if (
          calleeName &&
          ts.isPropertyAccessExpression(callee) &&
          DB_RECEIVER.test(compact(callee.expression.getText())) &&
          (DRIZZLE_WRITES.has(calleeName) ||
            (RAW_SQL.has(calleeName) && this.writesSql(current.arguments[0])))
        ) {
          writes.add(compact(callee.getText()));
        } else if (depth < MAX_CALL_DEPTH) {
          const target = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
          const declarations = this.declarationOf(target);
          if (
            calleeName &&
            WRITE_NAME.test(calleeName) &&
            !OPENS_STORE.test(calleeName) &&
            declarations.some((d) => this.inDataLayer(d.getSourceFile().fileName))
          ) {
            writes.add(compact(callee.getText()));
            return;
          }
          for (const declaration of declarations) {
            const body = functionBody(declaration);
            if (body && !seen.has(body)) {
              seen.add(body);
              const passesRequest = current.arguments.some((argument) =>
                REQUEST_ARGUMENT.test(compact(argument.getText())),
              );
              if (
                (this.inApi(body.getSourceFile().fileName) || passesRequest) &&
                testsRoutes(body, literal)
              ) {
                handsOff ??= `\`${compact(callee.getText())}\``;
              }
              walk(body, depth + 1);
            }
          }
        }
      }
      ts.forEachChild(current, (child) => walk(child, depth));
    };
    walk(node, 0);
    return { runs: [...names], writes: [...writes], ...(handsOff ? { handsOff } : {}) };
  }

  /** Whether a raw SQL statement writes, or may: true unless its text reads as a query. */
  private writesSql(argument: TS.Expression | undefined): boolean {
    const statement = argument && this.followIdentifier(argument);
    if (!statement) return true;
    const text = statement.getText();
    if (/^\s*(sql)?\s*[`'"(]*\s*(select|pragma)\b/i.test(text)) return false;
    // `WITH … DELETE` writes; a CTE reads only when no write follows it.
    if (/^\s*(sql)?\s*[`'"(]*\s*with\b/i.test(text)) {
      return /\b(insert|update|delete|replace)\b/i.test(text);
    }
    return true;
  }

  /** The string `node` stands for: a literal, or a `const` initialized with one. */
  private stringLiteral(node: TS.Expression): string | undefined {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (!ts.isIdentifier(node)) return undefined;
    const declaration = this.declarationOf(node)[0];
    if (
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      ts.isStringLiteralLike(declaration.initializer) &&
      ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const
    ) {
      return declaration.initializer.text;
    }
    return undefined;
  }

  private inApi(file: string): boolean {
    return this.fromSource(file).startsWith("api/");
  }

  private inDataLayer(file: string): boolean {
    return this.fromSource(file).startsWith("db/");
  }
}

function findInputSchema(source: TS.SourceFile): TS.Expression | undefined {
  let found: TS.Expression | undefined;
  const visit = (node: TS.Node) => {
    if (found) return;
    if (ts.isPropertyAssignment(node) && propertyName(node) === "inputSchema") {
      found = node.initializer;
    } else if (ts.isShorthandPropertyAssignment(node) && node.name.text === "inputSchema") {
      found = node.name;
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "defineAction" &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      found = propertyValue(node.arguments[0], "schema");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * The shape literal of `z.object({...})`, through chained calls such as
 * `.strict()`. Undefined when a call in the chain adds fields the reader
 * cannot see (`.extend`, `.merge`) or the shape spreads another.
 */
function findZodObjectShape(node: TS.Expression): TS.ObjectLiteralExpression | undefined {
  let current: TS.Expression = node;
  while (ts.isCallExpression(current)) {
    const callee = current.expression;
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    const first = current.arguments[0];
    if (callee.name.text === "object" && first && ts.isObjectLiteralExpression(first)) {
      return first.properties.some((p) => ts.isSpreadAssignment(p)) ? undefined : first;
    }
    if (ZOD_ADDS_FIELDS.has(callee.name.text)) return undefined;
    current = callee.expression;
  }
  return undefined;
}

function propertyName(property: TS.ObjectLiteralElementLike): string {
  const name = property.name;
  if (!name) return "?";
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return name.getText();
}

function propertyValue(
  literal: TS.ObjectLiteralExpression,
  name: string,
): TS.Expression | undefined {
  for (const property of literal.properties) {
    if (ts.isPropertyAssignment(property) && propertyName(property) === name) {
      return property.initializer;
    }
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) {
      return property.name;
    }
  }
  return undefined;
}

function functionBody(declaration: TS.Declaration): TS.Node | undefined {
  if (
    (ts.isFunctionDeclaration(declaration) ||
      ts.isMethodDeclaration(declaration) ||
      ts.isFunctionExpression(declaration) ||
      ts.isArrowFunction(declaration)) &&
    declaration.body
  ) {
    return declaration.body;
  }
  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    const init = declaration.initializer;
    if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && init.body) return init.body;
  }
  if (ts.isPropertyDeclaration(declaration) && declaration.initializer) {
    const init = declaration.initializer;
    if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && init.body) return init.body;
  }
  return undefined;
}

/** An argument that hands a dispatcher the request, or its path. */
const REQUEST_ARGUMENT = /^(request|req|path|route|parts|segments)$|\.(path|route|pathname)$/;

/**
 * Tests on the request, outside the recognized route tests, that answer a
 * request: an `if` or ternary that returns or throws. Guards that turn a
 * request away (`!ok`, `!==`) are not routes.
 */
function unreadRequestTests(
  body: TS.Node,
  skip: ReadonlySet<TS.Node>,
): (TS.IfStatement | TS.ConditionalExpression)[] {
  const found: (TS.IfStatement | TS.ConditionalExpression)[] = [];
  const isNegated = (node: TS.Expression) =>
    (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) ||
    (ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken));
  const mentionsRequest = (node: TS.Node): boolean =>
    (ts.isIdentifier(node) && /^(request|req|route|path|pathname|url)$/.test(node.text)) ||
    (ts.isPropertyAccessExpression(node) && isDispatchSubject(node.getText())) ||
    (ts.forEachChild(node, (child) => mentionsRequest(child) || undefined) ?? false);
  // A test reads like a route when some part of it, not negated, reads the
  // request. A guard (`!ok`, `method !== "GET"`) only rules requests out.
  const readsRequest = (condition: TS.Expression): boolean => {
    let node = condition;
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      return readsRequest(node.left) || readsRequest(node.right);
    }
    return !isNegated(node) && mentionsRequest(node);
  };
  const visit = (node: TS.Node) => {
    // Error handling answers no route of its own.
    if (skip.has(node) || ts.isFunctionLike(node) || ts.isCatchClause(node)) return;
    if (ts.isIfStatement(node) && !skip.has(node.thenStatement) && readsRequest(node.expression)) {
      if (hasExit(node.thenStatement, skip) || ts.isReturnStatement(node.thenStatement)) {
        found.push(node);
      }
    } else if (
      ts.isConditionalExpression(node) &&
      !skip.has(node.whenTrue) &&
      ts.isReturnStatement(node.parent) &&
      readsRequest(node.condition)
    ) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return found;
}

/** The app's own import aliases (`@/*`), from its tsconfig, relative to the app. */
function appPathAliases(dir: string): Pick<TS.CompilerOptions, "paths" | "baseUrl"> {
  const path = join(dir, "tsconfig.json");
  if (!existsSync(path)) return {};
  const { config } = ts.readConfigFile(path, ts.sys.readFile);
  const options = (
    config as { compilerOptions?: { paths?: TS.MapLike<string[]>; baseUrl?: string } }
  )?.compilerOptions;
  if (!options?.paths) return {};
  return { paths: options.paths, baseUrl: join(dir, options.baseUrl ?? ".") };
}

/** One branch on a route test: an `if`, or a ternary. */
interface RouteBranch {
  node: TS.IfStatement | TS.ConditionalExpression;
  condition: TS.Expression;
  then: TS.Node;
}

function routeBranches(root: TS.Node, literal: LiteralOf): RouteBranch[] {
  const branches: RouteBranch[] = [];
  const visit = (node: TS.Node) => {
    if (ts.isIfStatement(node) && isRouteCondition(node.expression, literal)) {
      branches.push({ node, condition: node.expression, then: node.thenStatement });
    } else if (
      ts.isConditionalExpression(node) &&
      // A ternary on a path alone is more often a value than a route.
      readCondition(node.condition, literal).methods.length > 0
    ) {
      branches.push({ node, condition: node.condition, then: node.whenTrue });
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return branches;
}

/** Whether a function body dispatches routes of its own. */
function testsRoutes(body: TS.Node, literal: LiteralOf): boolean {
  if (routeBranches(body, literal).length > 0) return true;
  let found = false;
  const visit = (node: TS.Node) => {
    if (found) return;
    if (ts.isSwitchStatement(node) && isDispatchSubject(node.expression.getText())) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

/** Whether `node` returns or throws outside `skip`, in its own function. */
function hasExit(node: TS.Node, skip: ReadonlySet<TS.Node>): boolean {
  let found = false;
  const visit = (current: TS.Node) => {
    if (found || skip.has(current) || ts.isFunctionLike(current)) return;
    if (ts.isReturnStatement(current) || ts.isThrowStatement(current)) found = true;
    else ts.forEachChild(current, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

function enclosingFunction(node: TS.Node): TS.FunctionLikeDeclaration | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current)
    ) {
      return current;
    }
  }
  return undefined;
}

/** Whether `condition` tests the request method or path. */
function isRouteCondition(condition: TS.Expression, literal: LiteralOf): boolean {
  const { methods, segments, root, patternOnPath } = readCondition(condition, literal);
  return methods.length > 0 || segments.length > 0 || root || patternOnPath;
}

/** The string a literal or a `const` bound to one stands for. */
type LiteralOf = (node: TS.Expression) => string | undefined;

/** One path segment a condition names, at its index when the test gives one. */
interface Segment {
  index?: number;
  value: string;
}

function isDispatchSubject(text: string): boolean {
  return /method$/i.test(text) || ROUTE_SUBJECT.test(text) || /path\[\d+\]$/.test(text);
}

/** The method and path a stack of route conditions, outermost first, matches. */
function describeRoute(
  conditions: TS.Expression[],
  literal: LiteralOf,
): Pick<RouteFacts, "method" | "path" | "unreadable" | "alternatives"> {
  const methods = new Set<string>();
  const slots: string[] = [];
  let next = 0;
  let depth = 0;
  let root = false;
  let opaque = false;
  let alternatives: string[] | undefined;
  for (const condition of conditions) {
    const read = readCondition(condition, literal);
    alternatives = read.alternatives ?? alternatives;
    for (const method of read.methods) methods.add(method);
    for (const segment of read.segments) {
      const index = segment.index ?? next;
      slots[index] = segment.value;
      next = Math.max(next, index + 1);
    }
    depth = Math.max(depth, read.depth ?? 0);
    root ||= read.root;
    opaque ||= read.opaque;
  }
  // `path[0] === "scouts" && path.length === 2` matches `scouts/:id`.
  const length = Math.max(depth, slots.length);
  const path = Array.from({ length }, (_, i) => slots[i] ?? ":id")
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/^\/|\/$/g, "");
  const method = methods.size === 0 ? "ANY" : [...methods].join("|");
  // `path === "" || path === "status"` serves the root among its paths.
  if (root) return { method, path: "", ...(alternatives ? { alternatives } : {}) };
  if (path === "") {
    return {
      method,
      path: "?",
      unreadable: opaque ? "a path test the reader cannot follow" : "no path test",
    };
  }
  return { method, path, ...(alternatives ? { alternatives } : {}) };
}

/** What one route condition tests. */
function readCondition(
  condition: TS.Expression,
  literal: LiteralOf,
): {
  methods: string[];
  segments: Segment[];
  depth?: number;
  /** Each path an alternation (`a || b`) accepts, when the condition is one. */
  alternatives?: string[];
  /** The condition matches the root path. */
  root: boolean;
  /** The condition tests something against a literal, or a pattern, the reader cannot place. */
  opaque: boolean;
  /**
   * The condition matches the path against a pattern, or tests an indexed
   * segment of a name it does not know, so it is a route the reader cannot place.
   */
  patternOnPath: boolean;
} {
  const methods: string[] = [];
  const segments: Segment[] = [];
  let depth: number | undefined;
  let root = false;
  let opaque = false;
  let patternOnPath = false;
  let alternatives: string[] | undefined;
  const visit = (node: TS.Node) => {
    // A negated test (`!path.startsWith("x")`) excludes a path; it names none.
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken)
      return;
    // `route === "a" || route === "b"` accepts either path: the first names
    // the route, and every one is kept for exemptions. An `||` over methods
    // (`POST || PUT`) is no alternation of paths.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      const operands = [node.left, node.right].map((operand) => readCondition(operand, literal));
      const pathOperands = operands.filter((o) => o.segments.length > 0 || o.root);
      if (pathOperands.length === operands.length) {
        const [first] = operands as [ReturnType<typeof readCondition>];
        segments.push(...first.segments);
        root ||= first.root;
        if (first.depth !== undefined) depth = first.depth;
        alternatives = operands.flatMap(
          (o) => o.alternatives ?? [o.root ? "" : o.segments.map((sg) => sg.value).join("/")],
        );
        for (const o of operands) {
          methods.push(...o.methods);
          opaque ||= o.opaque;
          patternOnPath ||= o.patternOnPath;
        }
        return;
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken)
    ) {
      if (ts.isNumericLiteral(node.right) && /path\.length$/i.test(node.left.getText())) {
        depth = Number(node.right.text);
        if (depth === 0) root = true;
      }
      const right = literal(node.right);
      const left = literal(node.left);
      const [value, subject] =
        right !== undefined ? [right, node.left] : left !== undefined ? [left, node.right] : [];
      if (value !== undefined && subject) {
        const subjectText = subject.getText();
        const indexed = /path\[(\d+)\]$/.exec(subjectText);
        if (/method$/i.test(subjectText) && HTTP_METHODS.has(value.toUpperCase())) {
          methods.push(value.toUpperCase());
        } else if (indexed) {
          segments.push({ index: Number(indexed[1]), value });
        } else if (ROUTE_SUBJECT.test(subjectText)) {
          if (value === "" || value === "/") root = true;
          else segments.push({ value });
        } else {
          opaque = true;
          // `parts[0] === "items"` reads like a path segment on a name the reader does not know.
          if (/\[\d+\]$/.test(subjectText)) patternOnPath = true;
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      const first = node.arguments[0];
      if (
        name === "startsWith" &&
        ROUTE_SUBJECT.test(node.expression.expression.getText()) &&
        first &&
        literal(first) !== undefined
      ) {
        segments.push({ value: `${(literal(first) as string).replace(/\/$/, "")}/*` });
      } else if (name === "match" || name === "test" || name === "exec") {
        opaque = true;
        const operands = [node.expression.expression, ...node.arguments].map((n) => n.getText());
        if (operands.some((text) => isDispatchSubject(text) || /path$/i.test(text))) {
          patternOnPath = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(condition);
  return {
    methods,
    segments,
    ...(alternatives ? { alternatives } : {}),
    root,
    opaque,
    patternOnPath,
    ...(depth !== undefined ? { depth } : {}),
  };
}

function enclosingRouteConditions(node: TS.Node, literal: LiteralOf): TS.Expression[] {
  const found: TS.Expression[] = [];
  let child: TS.Node = node;
  let parent = node.parent;
  while (parent) {
    if (
      ts.isIfStatement(parent) &&
      parent.thenStatement === child &&
      isRouteCondition(parent.expression, literal)
    ) {
      found.push(parent.expression);
    } else if (
      ts.isConditionalExpression(parent) &&
      parent.whenTrue === child &&
      isRouteCondition(parent.condition, literal)
    ) {
      found.push(parent.condition);
    }
    child = parent;
    parent = parent.parent;
  }
  return found;
}

function compact(text: string): string {
  return text.replace(/\s+/g, "");
}

function contains(outer: TS.Node, inner: TS.Node): boolean {
  return (
    inner.pos >= outer.pos &&
    inner.end <= outer.end &&
    inner.getSourceFile() === outer.getSourceFile()
  );
}

/** The source file a module path names: as given, or with a source extension for a built one. */
function resolveSourceFile(path: string): string | undefined {
  if (SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension)) && existsSync(path)) {
    return path;
  }
  const base = path.replace(/\.(m?js|jsx|tsx?|mts)$/, "");
  for (const extension of SOURCE_EXTENSIONS) {
    if (existsSync(base + extension)) return base + extension;
  }
  return undefined;
}

/** Whether an import or export brings in types only, so it is erased from the build. */
function isTypeOnly(node: TS.Node): boolean {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return false;
    if (clause.isTypeOnly) return true;
    const bindings = clause.namedBindings;
    return (
      !clause.name &&
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.length > 0 &&
      bindings.elements.every((element) => element.isTypeOnly)
    );
  }
  return ts.isExportDeclaration(node) && node.isTypeOnly;
}

/** An app API path as a page calls it: no leading or trailing slash, no query. */
function normalizeCallPath(path: string): string {
  return path
    .replace(/[?#].*$/, "")
    .split("/")
    .map((segment) => (segment.includes("\u0000") ? ":id" : segment))
    .join("/")
    .replace(/^\/+|\/+$/g, "");
}

function isTestFile(file: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || file.includes(`${sep}__fixtures__${sep}`);
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext)) && !name.endsWith(".d.ts")) {
        files.push(path);
      }
    }
  };
  walk(dir);
  return files;
}
