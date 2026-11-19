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
        : found.map((route) => ({
            ...route,
            noAuth:
              route.unreadable === undefined &&
              isAppApiPathNoAuth(noAuth as boolean | string[], `/${route.path}`),
          }));
  }

  const imports = reader.imports();
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
    pageRequests: reader.pageRequests(imports),
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
        if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith(".")) {
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
  pageRequests(imports: readonly ImportFacts[]): PageRequestFacts[] {
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
        if (imp.from === file && !/^(api|actions|db)\//.test(imp.to) && !imp.to.startsWith("..")) {
          queue.push(imp.to);
        }
      }
    }
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
  routes(entryFile: string): Omit<RouteFacts, "noAuth">[] {
    const entry = this.program.getSourceFile(entryFile);
    if (!entry) return [];
    const literal: LiteralOf = (node) => this.stringLiteral(node);
    const routeIfs: TS.IfStatement[] = [];
    const visit = (node: TS.Node) => {
      if (ts.isIfStatement(node) && isRouteCondition(node.expression, literal)) routeIfs.push(node);
      ts.forEachChild(node, visit);
    };
    visit(entry);
    const nested = (outer: TS.IfStatement) =>
      routeIfs.filter((other) => other !== outer && contains(outer.thenStatement, other));
    const routes: Omit<RouteFacts, "noAuth">[] = [];
    for (const routeIf of routeIfs) {
      const inner = nested(routeIf);
      // A route test with narrower tests inside it is a route only for the
      // code that runs outside them, such as a write after a method check.
      const effects = this.effects(routeIf.thenStatement, new Set(inner));
      if (inner.length > 0 && effects.runs.length === 0 && effects.writes.length === 0) continue;
      const conditions = [routeIf.expression, ...enclosingRouteConditions(routeIf, literal)];
      routes.push({
        ...describeRoute(conditions.reverse(), literal),
        at: this.at(entryFile, routeIf),
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
    return routes;
  }

  /**
   * What `node` does through the app's own calls: the names it passes to
   * `runAction`, and the app data it writes itself, without an action.
   */
  private effects(
    node: TS.Node,
    skip: ReadonlySet<TS.Node> = new Set(),
  ): { runs: string[]; writes: string[] } {
    const names = new Set<string>();
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
        if (calleeName === "runAction") {
          const first = current.arguments[0];
          names.add(first && ts.isStringLiteralLike(first) ? first.text : "<dynamic>");
        } else if (
          calleeName &&
          ts.isPropertyAccessExpression(callee) &&
          DRIZZLE_WRITES.has(calleeName) &&
          /(^|\.)(db|tx|connection)$/.test(compact(callee.expression.getText()))
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
              walk(body, depth + 1);
            }
          }
        }
      }
      ts.forEachChild(current, (child) => walk(child, depth));
    };
    walk(node, 0);
    return { runs: [...names], writes: [...writes] };
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
): Pick<RouteFacts, "method" | "path" | "unreadable"> {
  const methods = new Set<string>();
  const slots: string[] = [];
  let next = 0;
  let depth = 0;
  let root = false;
  let opaque = false;
  for (const condition of conditions) {
    const read = readCondition(condition, literal);
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
  if (root) return { method, path: "" };
  if (path === "") {
    return {
      method,
      path: "?",
      unreadable: opaque ? "a path test the reader cannot follow" : "no path test",
    };
  }
  return { method, path };
}

/** What one route condition tests. */
function readCondition(
  condition: TS.Expression,
  literal: LiteralOf,
): {
  methods: string[];
  segments: Segment[];
  depth?: number;
  /** The condition matches the root path. */
  root: boolean;
  /** The condition tests something against a literal, or a pattern, the reader cannot place. */
  opaque: boolean;
  /** The condition matches the path against a pattern, so it is a route the reader cannot place. */
  patternOnPath: boolean;
} {
  const methods: string[] = [];
  const segments: Segment[] = [];
  let depth: number | undefined;
  let root = false;
  let opaque = false;
  let patternOnPath = false;
  const visit = (node: TS.Node) => {
    // A negated test (`!path.startsWith("x")`) excludes a path; it names none.
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken)
      return;
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
  // `path === "" || path === "status"` matches either; the first names the route.
  return {
    methods,
    segments: segments.length > 1 && isAlternation(condition) ? segments.slice(0, 1) : segments,
    root,
    opaque,
    patternOnPath,
    ...(depth !== undefined ? { depth } : {}),
  };
}

function isAlternation(condition: TS.Expression): boolean {
  let node: TS.Expression = condition;
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return isAlternation(node.right) || isAlternation(node.left);
  }
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken;
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

function resolveSourceFile(base: string): string | undefined {
  for (const extension of SOURCE_EXTENSIONS) {
    if (existsSync(base + extension)) return base + extension;
  }
  return undefined;
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
