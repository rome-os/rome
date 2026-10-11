/**
 * How the host finds an action, hook or API module and the factory inside it.
 * Core's module loader and `rome validate` both run this code, so a check that
 * passes locally passes on install.
 */
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { resolvePathWithinBase } from "./path-utils.js";

// Apps written in TypeScript declare `entry: ./index.ts` against their `src/`
// layout; `rome build` emits `.js` into `dist/` and copies the YAML unchanged.
// `extensionAlias` lets the resolver try the compiled `.js` sibling first and
// fall back to `.ts` when running against source (e.g. `tsx` on the host).
// Node's own resolver doesn't know about TypeScript extensions.
export const MODULE_RESOLVER_OPTIONS = {
  extensions: [".js", ".ts", ".mjs", ".cjs", ".mts", ".cts", ".jsx", ".tsx", ".json"],
  extensionAlias: {
    ".js": [".js", ".ts"],
    ".jsx": [".jsx", ".tsx"],
    ".mjs": [".mjs", ".mts"],
    ".cjs": [".cjs", ".cts"],
    ".ts": [".js", ".ts"],
    ".tsx": [".jsx", ".tsx"],
    ".mts": [".mjs", ".mts"],
    ".cts": [".cjs", ".cts"],
  },
  mainFiles: ["index"],
};

/** The part of `@rspack/resolver`'s `ResolverFactory` entry resolution uses.
 *  The caller constructs it from {@link MODULE_RESOLVER_OPTIONS}, so this
 *  package does not carry the native resolver itself. */
export interface ModuleSpecifierResolver {
  async(directory: string, request: string): Promise<{ path?: string; error?: string }>;
}

/** Resolve a module directory's entry (`./index` unless `entry` names one) and
 *  refuse an entry whose real path leaves the directory. */
export async function resolveModuleEntryPath(
  resolver: ModuleSpecifierResolver,
  baseDir: string,
  entry?: string,
): Promise<string> {
  const absoluteBaseDir = resolve(baseDir);
  const specifier = entry ?? "./index";
  const result = await resolver.async(absoluteBaseDir, specifier);
  if (!result.path) {
    throw new Error(
      `No entry module found for "${baseDir}" (resolving "${specifier}"): ${result.error ?? "no path returned"}`,
    );
  }
  const [realBaseDir, realEntryPath] = await Promise.all([
    realpath(absoluteBaseDir),
    realpath(result.path),
  ]);
  const relativeEntryPath = relative(realBaseDir, realEntryPath);
  if (relativeEntryPath.startsWith("..") || isAbsolute(relativeEntryPath)) {
    throw new Error(`Invalid entry path "${specifier}" for ${baseDir}: escapes base dir`);
  }
  return result.path;
}

/** Resolve `app.yaml`'s `api.entry` the way the installer does: inside the app
 *  root, with a `.js`, `.mjs`, `.cjs` or `.ts` extension, or as named. */
export function resolveApiEntryPath(resolveRoot: string, entry: string, appId: string): string {
  const base = resolvePathWithinBase(resolveRoot, entry, `API entrypoint for app "${appId}"`);
  for (const ext of [".js", ".mjs", ".cjs", ".ts"]) {
    const candidate = `${base}${ext}`;
    if (existsSync(candidate)) return candidate;
  }
  if (existsSync(base)) return base;
  throw new Error(
    `App "${appId}" API entrypoint not found: tried ${base} with .js/.mjs/.cjs/.ts extensions`,
  );
}

/** Any function an action module exports as its factory. The caller names the
 *  exact `(config, deps) => Action` signature. */
// biome-ignore lint/suspicious/noExplicitAny: the caller supplies the signature.
type AnyFactory = (...args: any[]) => unknown;

function isActionFactory<TFactory extends AnyFactory>(value: unknown): value is TFactory {
  return typeof value === "function";
}

function toPascalCase(name: string): string {
  return name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
}

/** Pick an action module's factory: `createAction`, then `create<Name>Action`,
 *  then a default export, then the one `create*Action` export. */
export function resolveActionFactory<TFactory extends AnyFactory>(
  module: Record<string, unknown>,
  actionName: string,
): TFactory {
  const preferredNamed = `create${toPascalCase(actionName)}Action`;

  if (isActionFactory<TFactory>(module.createAction)) {
    return module.createAction;
  }
  if (isActionFactory<TFactory>(module[preferredNamed])) {
    return module[preferredNamed];
  }
  if (isActionFactory<TFactory>(module.default)) {
    return module.default;
  }

  const candidates = Object.entries(module)
    .filter(
      ([name, value]) =>
        /^create[A-Za-z0-9_]*Action$/.test(name) && isActionFactory<TFactory>(value),
    )
    .map(([, value]) => value as TFactory);

  if (candidates.length === 1) {
    return candidates[0]!;
  }

  throw new Error(
    `No action factory found for "${actionName}". Export createAction(config, deps) or a single create*Action function.`,
  );
}
