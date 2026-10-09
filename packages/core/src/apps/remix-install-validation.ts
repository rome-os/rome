import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { parseDocument } from "yaml";
import { parseSkillFrontmatterResult } from "../core/skill-catalog.js";
import type { AppCatalog } from "./catalog.js";
import type { AppInstaller } from "./installer.js";
import type { SpecSource } from "./lockfile.js";
import {
  ActionConfigSchema,
  AgentConfigSchema,
  appMigrationsTableName,
  type AppManifestData,
  parseAppManifest,
  parseManifestObject,
  resolvePathWithinBase,
} from "./packaging/index.js";
import { isResolvedApp, type ArtifactRef, type ResolvedApp } from "./state.js";

type RuntimeArtifactKind = "action" | "agent" | "skill";
type RuntimeArtifactEntry = NonNullable<AppManifestData["actions"]>[number];

interface RuntimeArtifactName {
  kind: RuntimeArtifactKind;
  name: string;
  ownerId: string;
  configPath: string;
}

function entryPath(entry: RuntimeArtifactEntry): string {
  return typeof entry === "string" ? entry : entry.path;
}

async function readRuntimeArtifactName(
  kind: RuntimeArtifactKind,
  configPath: string,
  ownerId: string,
): Promise<RuntimeArtifactName> {
  if (kind === "skill") {
    const parsed = parseSkillFrontmatterResult(await readFile(configPath, "utf-8"));
    if (!parsed.ok) {
      throw new Error(`Cannot validate remixed skill at ${configPath}: ${parsed.message}`);
    }
    return { kind, name: parsed.value.name, ownerId, configPath };
  }
  const document = parseDocument(await readFile(configPath, "utf-8"));
  if (document.errors.length > 0) {
    throw new Error(
      `Cannot validate remixed ${kind} at ${configPath}: ${document.errors[0]?.message}`,
    );
  }
  const result =
    kind === "action"
      ? ActionConfigSchema.safeParse(document.toJS())
      : AgentConfigSchema.safeParse(document.toJS());
  if (!result.success) {
    throw new Error(
      `Cannot validate remixed ${kind} at ${configPath}: ${result.error.issues[0]?.message}`,
    );
  }
  return { kind, name: result.data.name, ownerId, configPath };
}

async function readSourceArtifactNames(
  sourceRoot: string,
  manifest: AppManifestData,
): Promise<RuntimeArtifactName[]> {
  const resolveRoot = resolvePathWithinBase(
    sourceRoot,
    manifest.appRoot ?? "",
    `appRoot for remixed app ${manifest.id}`,
  );
  const actions = await Promise.all(
    (manifest.actions ?? []).map((entry) => {
      const root = resolvePathWithinBase(
        resolveRoot,
        entryPath(entry),
        `action path for remixed app ${manifest.id}`,
      );
      return readRuntimeArtifactName("action", join(root, "action.yaml"), manifest.id);
    }),
  );
  const agents = await Promise.all(
    (manifest.agents ?? []).map((entry) => {
      const path = resolvePathWithinBase(
        resolveRoot,
        entryPath(entry),
        `agent path for remixed app ${manifest.id}`,
      );
      return readRuntimeArtifactName("agent", path, manifest.id);
    }),
  );
  const skills = await Promise.all(
    (manifest.skills ?? []).map((entry) => {
      const root = resolvePathWithinBase(
        resolveRoot,
        entryPath(entry),
        `skill path for remixed app ${manifest.id}`,
      );
      return readRuntimeArtifactName("skill", join(root, "SKILL.md"), manifest.id);
    }),
  );
  return [...actions, ...agents, ...skills];
}

async function readInstalledArtifactName(
  kind: RuntimeArtifactKind,
  artifact: ArtifactRef,
): Promise<RuntimeArtifactName> {
  const configPath =
    kind === "action"
      ? join(artifact.absolutePath, "action.yaml")
      : kind === "skill"
        ? join(artifact.absolutePath, "SKILL.md")
        : artifact.absolutePath;
  return await readRuntimeArtifactName(kind, configPath, artifact.ownerId);
}

async function readInstalledArtifactNames(
  apps: readonly ResolvedApp[],
): Promise<RuntimeArtifactName[]> {
  const names: RuntimeArtifactName[] = [];
  for (const app of apps) {
    for (const kind of ["action", "agent", "skill"] as const) {
      for (const artifact of app.artifacts[kind]) {
        names.push(await readInstalledArtifactName(kind, artifact));
      }
    }
  }
  return names;
}

function assertNoArtifactConflicts(
  target: readonly RuntimeArtifactName[],
  installed: readonly RuntimeArtifactName[],
): void {
  const seenTarget = new Map<string, RuntimeArtifactName>();
  for (const artifact of target) {
    const key = `${artifact.kind}:${artifact.name}`;
    const duplicate = seenTarget.get(key);
    if (duplicate) {
      throw new Error(
        `REMIX_ARTIFACT_CONFLICT: remixed app declares duplicate ${artifact.kind} ${JSON.stringify(
          artifact.name,
        )} in ${duplicate.configPath} and ${artifact.configPath}.`,
      );
    }
    seenTarget.set(key, artifact);
  }

  const installedByName = new Map(
    installed.map((artifact) => [`${artifact.kind}:${artifact.name}`, artifact]),
  );
  for (const artifact of target) {
    const conflict = installedByName.get(`${artifact.kind}:${artifact.name}`);
    if (!conflict) continue;
    throw new Error(
      `REMIX_ARTIFACT_CONFLICT: ${artifact.kind} ${JSON.stringify(
        artifact.name,
      )} conflicts with installed app ${JSON.stringify(conflict.ownerId)}. ` +
        "Rename the remixed artifact and all of its internal references before installing.",
    );
  }
}

interface ForeignDatabaseReference {
  path: string;
  namespaces: string[];
}

async function findForeignDatabaseReferences(
  rootPath: string,
  targetPrefix: string,
): Promise<ForeignDatabaseReference[]> {
  const matches: ForeignDatabaseReference[] = [];
  const pending = [rootPath];
  const physicalTablePattern = /(^|[^a-z0-9_])([a-z][a-z0-9_]{0,63})__/gu;
  const migrationsTablePattern = new RegExp(
    `${appMigrationsTableName("")}([a-z][a-z0-9_]{0,63})`,
    "gu",
  );
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile() || ![".sql", ".json"].includes(extname(entry.name))) continue;
      const text = await readFile(path, "utf-8");
      const namespaces = new Set<string>();
      for (const match of text.matchAll(physicalTablePattern)) {
        const namespace = match[2];
        if (namespace && namespace !== targetPrefix) namespaces.add(namespace);
      }
      for (const match of text.matchAll(migrationsTablePattern)) {
        const namespace = match[1];
        if (namespace && namespace !== targetPrefix) namespaces.add(namespace);
      }
      if (namespaces.size > 0) matches.push({ path, namespaces: [...namespaces].sort() });
    }
  }
  return matches;
}

async function assertDatabaseIsolation(
  sourceRoot: string,
  manifest: AppManifestData,
  installedApps: readonly ResolvedApp[],
): Promise<void> {
  if (!manifest.db) return;
  const targetPrefix = manifest.db.tablePrefix ?? manifest.id;
  for (const app of installedApps) {
    if (app.db?.tablePrefix !== targetPrefix) continue;
    throw new Error(
      `REMIX_DB_NAMESPACE_CONFLICT: tablePrefix ${JSON.stringify(
        targetPrefix,
      )} is already owned by installed app ${JSON.stringify(app.appId)}.`,
    );
  }

  const resolveRoot = resolvePathWithinBase(
    sourceRoot,
    manifest.appRoot ?? "",
    `appRoot for remixed app ${manifest.id}`,
  );
  const migrationsPath = resolvePathWithinBase(
    resolveRoot,
    manifest.db.migrations,
    `DB migrations for remixed app ${manifest.id}`,
  );
  const foreignReferences = await findForeignDatabaseReferences(migrationsPath, targetPrefix);
  if (foreignReferences.length > 0) {
    const detail = foreignReferences
      .map(
        (reference) =>
          `${reference.namespaces
            .map((namespace) => JSON.stringify(namespace))
            .join(", ")} in ${reference.path}`,
      )
      .join("; ");
    throw new Error(
      `REMIX_DB_MIGRATIONS_NOT_ISOLATED: migration files reference non-target database ` +
        `namespaces ${detail}. Generate a fresh migration baseline for ${JSON.stringify(
          targetPrefix,
        )} before installing.`,
    );
  }
}

async function resolveAllInstalledApps(
  catalog: AppCatalog,
  installer: AppInstaller,
  targetAppId: string,
): Promise<ResolvedApp[]> {
  const installedApps: ResolvedApp[] = [];
  for (const view of catalog.list()) {
    if (view.appId === targetAppId || view.state !== "installed") continue;
    if (isResolvedApp(view)) {
      installedApps.push(view);
      continue;
    }
    const result = await installer.resolve(view.appId);
    if (!result.ok) {
      throw new Error(
        `REMIX_ISOLATION_STATE_UNAVAILABLE: cannot inspect installed app ${JSON.stringify(
          view.appId,
        )}: ${result.reason}`,
      );
    }
    const { ok: _ok, ...resolved } = result;
    installedApps.push({ ...view, state: "installed", ...resolved });
  }
  return installedApps;
}

/**
 * Fail closed before a remixed artifact is materialized or allowed to load.
 * The source app remains installed, so runtime artifact names and database
 * namespaces must be independent before the derived app is installed.
 */
export async function validateRemixInstallIsolation(
  source: SpecSource,
  catalog: AppCatalog,
  installer: AppInstaller,
): Promise<void> {
  if (source.mode === "appstore") return;
  const manifestPath = join(source.path, "app.yaml");
  const manifest = parseAppManifest(await parseManifestObject(manifestPath), manifestPath);
  if (!manifest.remix) return;

  const installedApps = await resolveAllInstalledApps(catalog, installer, manifest.id);
  const [targetArtifacts, installedArtifacts] = await Promise.all([
    readSourceArtifactNames(source.path, manifest),
    readInstalledArtifactNames(installedApps),
  ]);
  assertNoArtifactConflicts(targetArtifacts, installedArtifacts);
  await assertDatabaseIsolation(source.path, manifest, installedApps);
}
