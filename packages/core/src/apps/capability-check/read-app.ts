// Reads an app directory into the facts the capability rules judge. It parses
// `app.yaml` and every `action.yaml` with the packaging schemas, and the app's
// TypeScript with the compiler. It runs nothing from the app.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import ts from "typescript";
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
/** A factory that opens a repository writes nothing by itself. */
const OPENS_STORE = /(Repository|Repo|Store|Client)$/;
/** How deep the reader follows calls from a route to find the actions it runs. */
const MAX_CALL_DEPTH = 8;

export async function readApp(dir: string): Promise<AppFacts> {
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
            noAuth: isAppApiPathNoAuth(noAuth as boolean | string[], `/${route.path}`),
          }));
  }

  return {
    id: manifest.id,
    dir,
    description: manifest.description,
    hasPage: manifest.web !== undefined,
    sourceRoot,
    actions,
    routes,
    ...(apiEntryAt ? { apiEntry: apiEntryAt } : {}),
    imports: reader.imports(),
    pageRequests: reader.pageRequests(),
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
  private readonly checker: ts.TypeChecker;

  constructor(
    private readonly program: ts.Program,
    private readonly appDir: string,
    private readonly sourceDir: string,
  ) {
    this.checker = program.getTypeChecker();
  }

  /** `file:line` relative to the app directory. */
  at(file: string, node?: ts.Node): string {
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
      const visit = (node: ts.Node) => {
        let specifier: ts.Expression | undefined;
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

  /** Requests the page makes past its app API, such as a bare `fetch`. */
  pageRequests(): PageRequestFacts[] {
    const found: PageRequestFacts[] = [];
    for (const source of this.program.getSourceFiles()) {
      if (!this.ownFile(source.fileName) || isTestFile(source.fileName)) continue;
      if (!this.fromSource(source.fileName).startsWith("web/")) continue;
      const visit = (node: ts.Node) => {
        const callee =
          ts.isCallExpression(node) || ts.isNewExpression(node) ? node.expression : undefined;
        const name = callee && compact(callee.getText());
        if (name && DIRECT_REQUESTS.has(name)) {
          const first =
            node.kind === ts.SyntaxKind.CallExpression || ts.isNewExpression(node)
              ? (node as ts.CallExpression).arguments?.[0]
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
  inputSchema(entryFile: string): ts.Expression | undefined {
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

  private importsOf(source: ts.SourceFile): string[] {
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

  argumentDescriptions(schema: ts.Expression): ArgumentDescriptions {
    const node = this.followIdentifier(schema);
    if (!node) return { kind: "unknown" };
    if (ts.isObjectLiteralExpression(node)) return this.jsonSchemaArguments(node);
    const zodShape = findZodObjectShape(node);
    if (zodShape) {
      const undescribed = zodShape.properties
        .filter(
          (p) => !(ts.isPropertyAssignment(p) && p.initializer.getText().includes(".describe(")),
        )
        .map((p) => propertyName(p));
      return undescribed.length === 0
        ? { kind: "described" }
        : { kind: "undescribed", names: undescribed };
    }
    return { kind: "unknown" };
  }

  private jsonSchemaArguments(schema: ts.ObjectLiteralExpression): ArgumentDescriptions {
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
  private followIdentifier(node: ts.Expression): ts.Expression | undefined {
    let current: ts.Expression = node;
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

  private declarationOf(node: ts.Node): ts.Declaration[] {
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
    const routeIfs: ts.IfStatement[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isIfStatement(node) && isRouteCondition(node.expression, literal)) routeIfs.push(node);
      ts.forEachChild(node, visit);
    };
    visit(entry);
    // A route is a route test with no narrower route test inside it.
    const leaves = routeIfs.filter(
      (candidate) =>
        !routeIfs.some((other) => other !== candidate && contains(candidate.thenStatement, other)),
    );
    return leaves.map((leaf) => {
      const conditions = [leaf.expression, ...enclosingRouteConditions(leaf, literal)];
      const methods = new Set<string>();
      const segments: string[] = [];
      let depth = 0;
      for (const condition of conditions.reverse()) {
        const { methods: m, segments: s, depth: d } = readCondition(condition, literal);
        for (const method of m) methods.add(method);
        segments.push(...s);
        depth = Math.max(depth, d ?? 0);
      }
      // `path[0] === "scouts" && path.length === 2` matches `scouts/:id`.
      while (segments.length < depth) segments.push(":id");
      return {
        method: methods.size === 0 ? "ANY" : [...methods].join("|"),
        path: segments
          .join("/")
          .replace(/\/+/g, "/")
          .replace(/^\/|\/$/g, ""),
        at: this.at(entryFile, leaf),
        ...this.effects(leaf.thenStatement),
      };
    });
  }

  /**
   * What `node` does through the app's own calls: the names it passes to
   * `runAction`, and the app data it writes itself, without an action.
   */
  private effects(node: ts.Node): { runs: string[]; writes: string[] } {
    const names = new Set<string>();
    const writes = new Set<string>();
    const seen = new Set<ts.Node>();
    const walk = (current: ts.Node, depth: number) => {
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
          /(^|\.)(db|tx)$/.test(callee.expression.getText())
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
  private stringLiteral(node: ts.Expression): string | undefined {
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

function findInputSchema(source: ts.SourceFile): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
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

/** The shape literal of `z.object({...})`, through any chained calls such as `.strict()`. */
function findZodObjectShape(node: ts.Expression): ts.ObjectLiteralExpression | undefined {
  let current: ts.Expression = node;
  while (ts.isCallExpression(current)) {
    const callee = current.expression;
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    const first = current.arguments[0];
    if (callee.name.text === "object" && first && ts.isObjectLiteralExpression(first)) {
      return first;
    }
    current = callee.expression;
  }
  return undefined;
}

function propertyName(property: ts.ObjectLiteralElementLike): string {
  const name = property.name;
  if (!name) return "?";
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return name.getText();
}

function propertyValue(
  literal: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
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

function functionBody(declaration: ts.Declaration): ts.Node | undefined {
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

/** Whether `condition` tests the request method or path against a literal. */
function isRouteCondition(condition: ts.Expression, literal: LiteralOf): boolean {
  const { methods, segments } = readCondition(condition, literal);
  return methods.length > 0 || segments.length > 0;
}

/** The methods and path segments a route condition compares against. */
/** The string a literal or a `const` bound to one stands for. */
type LiteralOf = (node: ts.Expression) => string | undefined;

function readCondition(
  condition: ts.Expression,
  literal: LiteralOf,
): {
  methods: string[];
  segments: string[];
  depth?: number;
} {
  const methods: string[] = [];
  const segments: string[] = [];
  let depth: number | undefined;
  const visit = (node: ts.Node) => {
    // A negated test (`!path.startsWith("x")`) excludes a path; it names none.
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken)
      return;
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken)
    ) {
      const right = literal(node.right);
      const left = literal(node.left);
      const [value, subject] =
        right !== undefined ? [right, node.left] : left !== undefined ? [left, node.right] : [];
      if (ts.isNumericLiteral(node.right) && /path\.length$/i.test(node.left.getText())) {
        depth = Number(node.right.text);
      }
      if (value !== undefined && subject) {
        const subjectText = subject.getText();
        if (/method$/i.test(subjectText) && HTTP_METHODS.has(value.toUpperCase())) {
          methods.push(value.toUpperCase());
        } else if (ROUTE_SUBJECT.test(subjectText) || /path\[\d+\]$/.test(subjectText)) {
          segments.push(value);
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "startsWith" &&
      ROUTE_SUBJECT.test(node.expression.expression.getText()) &&
      node.arguments[0] &&
      literal(node.arguments[0]) !== undefined
    ) {
      segments.push(`${(literal(node.arguments[0]) as string).replace(/\/$/, "")}/*`);
    }
    ts.forEachChild(node, visit);
  };
  visit(condition);
  // `path === "" || path === "status"` matches either; the first names the route.
  return {
    methods,
    segments: segments.length > 1 && isAlternation(condition) ? [segments[0] as string] : segments,
    ...(depth !== undefined ? { depth } : {}),
  };
}

function isAlternation(condition: ts.Expression): boolean {
  let node: ts.Expression = condition;
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return isAlternation(node.right) || isAlternation(node.left);
  }
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken;
}

function enclosingRouteConditions(node: ts.Node, literal: LiteralOf): ts.Expression[] {
  const found: ts.Expression[] = [];
  let child: ts.Node = node;
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

function contains(outer: ts.Node, inner: ts.Node): boolean {
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
