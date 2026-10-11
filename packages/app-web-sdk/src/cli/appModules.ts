import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Action, ActionConfig } from "@rome-os/app-runtime";
import {
  ActionConfigSchema,
  type AppManifestData,
  formatZodIssues,
  MODULE_RESOLVER_OPTIONS,
  parseAppManifest,
  parseManifestObject,
  resolveActionFactory,
  resolveApiEntryPath,
  resolveModuleEntryPath,
} from "@rome-os/app-runtime/packaging";
import { ResolverFactory } from "@rspack/resolver";
import { parse as parseYaml } from "yaml";
import { findAppDir } from "./loadAppYaml.js";

/** An app's `app.yaml` plus where its built output lives. */
export interface AppOnDisk {
  appDir: string;
  /** `appRoot` resolved against `appDir`: the tree the host loads modules from. */
  builtRoot: string;
  manifest: AppManifestData;
  tablePrefix: string;
}

export async function readAppOnDisk(startDir: string): Promise<AppOnDisk> {
  const appDir = findAppDir(startDir);
  if (!appDir) {
    throw new Error(`rome: could not locate app.yaml searching upward from ${startDir}`);
  }
  const manifestPath = join(appDir, "app.yaml");
  const manifest = parseAppManifest(await parseManifestObject(manifestPath), manifestPath);
  return {
    appDir,
    builtRoot: resolve(appDir, manifest.appRoot ?? "."),
    manifest,
    // The host's fallback when app.yaml declares no db.tablePrefix.
    tablePrefix: manifest.db?.tablePrefix ?? manifest.id,
  };
}

/** The relative paths `app.yaml` lists under `key`, whether written as a
 *  string or as `{ path }`. */
export function artifactPaths(manifest: AppManifestData, key: "actions" | "hooks"): string[] {
  return (manifest[key] ?? []).map((entry) => (typeof entry === "string" ? entry : entry.path));
}

// The host's resolver settings, so an entry resolves here exactly as on install.
// Built on first use, so commands that load no modules skip the native resolver.
let resolverInstance: ResolverFactory | undefined;
function resolver(): ResolverFactory {
  resolverInstance ??= new ResolverFactory(MODULE_RESOLVER_OPTIONS);
  return resolverInstance;
}

type ActionFactory = (config: ActionConfig, deps: unknown) => Action;

interface ActionModule {
  path: string;
  config: ActionConfig;
  factory: ActionFactory;
}

/**
 * Import every action the manifest lists from the built tree with the host's
 * own entry and factory resolution.
 */
export async function loadActionModules(app: AppOnDisk): Promise<ActionModule[]> {
  const loaded: ActionModule[] = [];
  for (const path of artifactPaths(app.manifest, "actions")) {
    const dir = join(app.builtRoot, path);
    const yamlPath = join(dir, "action.yaml");
    const parsed = ActionConfigSchema.safeParse(parseYaml(readFileSync(yamlPath, "utf8")));
    if (!parsed.success) {
      throw new Error(`Invalid ${yamlPath}:\n${formatZodIssues(parsed.error)}`);
    }
    const config = parsed.data as ActionConfig;
    const module = await importResolved(
      await resolveModuleEntryPath(resolver(), dir, config.entry),
    );
    let factory: ActionFactory;
    try {
      factory = resolveActionFactory<ActionFactory>(module, config.name);
    } catch (err) {
      throw new Error(`${err instanceof Error ? err.message : String(err)} (in ${dir})`);
    }
    loaded.push({ path, config, factory });
  }
  return loaded;
}

/** Import a hook directory's module and return its `createHook`. */
export async function loadHookFactory(app: AppOnDisk, path: string): Promise<unknown> {
  const dir = join(app.builtRoot, path);
  const module = await importResolved(await resolveModuleEntryPath(resolver(), dir));
  if (typeof module.createHook !== "function") {
    throw new Error(`Hook "${path}" must export createHook(deps) from ${dir}`);
  }
  return module.createHook;
}

/** Import the API entry and return its `createApiHandler`, or null when the app has no API. */
export async function loadApiFactory(app: AppOnDisk): Promise<unknown> {
  if (!app.manifest.api) return null;
  const entry = app.manifest.api.entry ?? "api/index";
  const module = await importResolved(resolveApiEntryPath(app.builtRoot, entry, app.manifest.id));
  if (typeof module.createApiHandler !== "function") {
    throw new Error(`The API module ${entry} must export createApiHandler(ctx)`);
  }
  return module.createApiHandler;
}

async function importResolved(path: string): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(path).href)) as Record<string, unknown>;
}
