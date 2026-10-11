import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MODULE_RESOLVER_OPTIONS,
  resolveActionFactory as resolveSharedActionFactory,
  resolveModuleEntryPath as resolveSharedModuleEntryPath,
} from "@rome-os/app-runtime/packaging";
import { ResolverFactory } from "@rspack/resolver";
import type { Action, ActionConfig } from "./types.js";

// Node's ESM resolver drops the query string when a module resolves its own
// static imports, so the ?v= cache-buster on an entry URL re-evaluates only
// the entry file: a helper it imports keeps its unsalted URL and stays cached
// with whatever it captured at module scope. These hooks give the entry's
// whole own-file graph one identity per (file stats, env epoch):
//
// - resolve: short-circuits already-salted file URLs before any other loader
//   sees them (tsx — the `source` container mode — otherwise normalizes the
//   query away, collapsing every epoch onto one cached instance), and
//   propagates the parent's salt onto relative imports.
// - load: serves salted URLs from disk itself, because downstream loaders
//   fail on file URLs that carry a query.
//
// Only compiled `.js`/`.mjs` files are salted: TypeScript app sources need
// tsx's transform pipeline, which the bypass would skip — source-mode
// workspace apps keep their existing repack-or-restart reload story. Bare
// specifiers stay untouched on purpose: node_modules must resolve to the one
// shared instance per process.
const SALT_QUERY = /\?v=[^&]*$/;

function isSaltableUrl(url: string): boolean {
  const path = url.split("?")[0];
  return path.endsWith(".js") || path.endsWith(".mjs");
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("file:") && SALT_QUERY.test(specifier) && isSaltableUrl(specifier)) {
      return { url: specifier, format: "module", shortCircuit: true };
    }
    const result = nextResolve(specifier, context);
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL !== undefined &&
      SALT_QUERY.test(context.parentURL) &&
      result.url.startsWith("file:") &&
      !result.url.includes("?") &&
      isSaltableUrl(result.url)
    ) {
      const salt = new URL(context.parentURL).searchParams.get("v");
      if (salt) return { url: `${result.url}?v=${salt}`, format: "module", shortCircuit: true };
    }
    return result;
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && SALT_QUERY.test(url) && isSaltableUrl(url)) {
      const cleanUrl = new URL(url);
      cleanUrl.search = "";
      return {
        format: "module",
        source: readFileSync(fileURLToPath(cleanUrl)),
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const sharedResolver = new ResolverFactory(MODULE_RESOLVER_OPTIONS);

export type GenericActionFactory<TDeps = unknown> = (config: ActionConfig, deps: TDeps) => Action;

export function resolveActionFactory<TDeps>(
  module: Record<string, unknown>,
  actionName: string,
): GenericActionFactory<TDeps> {
  return resolveSharedActionFactory<GenericActionFactory<TDeps>>(module, actionName);
}

export async function resolveModuleEntryPath(baseDir: string, entry?: string): Promise<string> {
  return resolveSharedModuleEntryPath(sharedResolver, baseDir, entry);
}

// App modules can read process.env at module scope, and the file-identity
// buster below cannot see an environment change. Bumping this epoch salts the
// cache key so every subsequent import re-evaluates module scope against the
// current environment (app keys do this on save/delete). Each bump strands the
// previously imported instances in the ESM cache — the same cost as an app
// upgrade changing mtime — bounded by how often a guardian edits keys.
let envEpoch = 0;

export function bumpModuleEnvEpoch(): void {
  envEpoch++;
}

export async function importModuleWithCacheBuster(path: string): Promise<Record<string, unknown>> {
  const fileStat = await stat(path);
  const cacheBuster = `${Math.trunc(fileStat.mtimeMs)}-${fileStat.size}-e${envEpoch}`;
  const url = `${pathToFileURL(path).href}?v=${cacheBuster}`;
  return await import(url);
}

export async function instantiateActionFromDirectory<TDeps>(
  config: ActionConfig,
  actionDir: string,
  deps: TDeps,
): Promise<Action> {
  const entryPath = await resolveModuleEntryPath(actionDir, config.entry);
  const module = await importModuleWithCacheBuster(entryPath);
  const factory = resolveActionFactory<TDeps>(module, config.name);
  return factory(config, deps);
}
