import { existsSync } from "node:fs";
import type { AppRemixSource, AppRemixStorePin } from "@rome/api-types/apps";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extract as tarExtract, list as tarList } from "tar";
import { parseDocument } from "yaml";
import { parseSkillFrontmatterResult } from "../core/skill-catalog.js";
import { getCustomAppAuthoringRoot, getProfileInstalledAppsDir } from "../paths.js";
import { getCustomAppAuthoringPath } from "./authoring.js";
import type { AppCatalog } from "./catalog.js";
import type { AppManager } from "./manager.js";
import {
  ActionConfigSchema,
  AgentConfigSchema,
  appIdToPathSegment,
  assertValidAppId,
  type AppManifestData,
  PACKED_ARTIFACT_SENTINEL,
  parseAppManifest,
  parseListingId,
  parseManifestObject,
  resolvePathWithinBase,
} from "@rome-os/app-runtime/packaging";
import { normalizeListingId } from "./rome-cloud-urls.js";
import { isBlockedSourceFile, isExcludedSourceEntry } from "@rome-os/app-runtime/packaging";
import type { AppEntry } from "./lockfile.js";
import { fetchVerifiedStoreBundle, type BundleFetcher } from "./store-bundle.js";
import { parseRemixSource } from "./remix-source.js";

const MAX_ARCHIVE_ENTRIES = 20_000;
const MAX_UNPACKED_BYTES = 250 * 1024 * 1024;
const SAFE_TAR_ENTRY_TYPES = new Set([
  "File",
  "OldFile",
  "ContiguousFile",
  "Directory",
  "GNUDumpDir",
]);

export interface RemixAppParams {
  appId: string;
  name: string;
  from: AppRemixSource;
}

export interface RemixAppResult {
  appId: string;
  created: true;
  rootPath: string;
}

export interface RemixAppDeps {
  appManager: Pick<AppManager, "readLockfileEntry">;
  appCatalog: AppCatalog;
  bundleFetcher: BundleFetcher;
  installedRoot?: string;
  authoringRoot?: string;
}

function isPathInside(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function readInstalledSource(
  appId: string,
  installedRoot: string,
  installedHash: string | null,
): Promise<{ rootPath: string; manifest: AppManifestData }> {
  const resolvedInstalledRoot = await realpath(installedRoot);
  const appRoot = await realpath(join(resolvedInstalledRoot, appIdToPathSegment(appId)));
  if (!isPathInside(resolvedInstalledRoot, appRoot)) {
    throw new Error(`Installed app "${appId}" is outside the installed-apps root.`);
  }
  const activeRoot = await realpath(join(appRoot, "active"));
  if (!isPathInside(appRoot, activeRoot)) {
    throw new Error(`Installed app "${appId}" has an active bundle outside its install root.`);
  }
  if (installedHash !== null && basename(activeRoot) !== installedHash) {
    throw new Error("Installed source changed before copying. Retry the remix.");
  }
  const manifestPath = join(activeRoot, "app.yaml");
  const manifest = parseAppManifest(await parseManifestObject(manifestPath), manifestPath);
  if (manifest.id !== appId) {
    throw new Error(`Installed manifest id "${manifest.id}" does not match source app "${appId}".`);
  }
  return { rootPath: activeRoot, manifest };
}

function validateArchivePath(entryPath: string): string[] {
  const normalized = entryPath.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) {
    throw new Error(`Remix bundle contains an absolute path: ${entryPath}`);
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Remix bundle contains an unsafe path: ${entryPath}`);
  }
  return segments;
}

async function validateBundleArchive(bytes: Buffer): Promise<void> {
  let rootName: string | null = null;
  let entryCount = 0;
  let unpackedBytes = 0;
  let validationError: Error | null = null;

  await pipeline(
    Readable.from(bytes),
    tarList({
      strict: true,
      onReadEntry: (entry) => {
        if (validationError) return;
        try {
          const segments = validateArchivePath(entry.path);
          rootName ??= segments[0];
          if (segments[0] !== rootName) {
            throw new Error("Remix bundle must contain exactly one top-level directory.");
          }
          if (!SAFE_TAR_ENTRY_TYPES.has(entry.type)) {
            throw new Error(`Remix bundle contains unsupported ${entry.type} entry: ${entry.path}`);
          }
          entryCount += 1;
          unpackedBytes += entry.size;
          if (entryCount > MAX_ARCHIVE_ENTRIES) {
            throw new Error(`Remix bundle exceeds the ${MAX_ARCHIVE_ENTRIES}-entry limit.`);
          }
          if (unpackedBytes > MAX_UNPACKED_BYTES) {
            throw new Error(`Remix bundle exceeds the ${MAX_UNPACKED_BYTES}-byte unpacked limit.`);
          }
        } catch (error) {
          validationError = error instanceof Error ? error : new Error(String(error));
        }
      },
    }),
  );
  if (validationError) throw validationError;
  if (rootName == null) throw new Error("Remix bundle is empty.");
}

async function assertSafeExtractedTree(rootPath: string): Promise<void> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(rootPath, entry.name);
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
      throw new Error(`Remix bundle contains an unsupported filesystem entry: ${path}`);
    }
    if (stats.isDirectory()) await assertSafeExtractedTree(path);
  }
}

async function extractBundle(bytes: Buffer, destination: string): Promise<void> {
  await validateBundleArchive(bytes);
  await pipeline(
    Readable.from(bytes),
    tarExtract({ cwd: destination, strip: 1, strict: true, preservePaths: false }),
  );
  await assertSafeExtractedTree(destination);
}

async function copyRoot(
  sourceRoot: string,
  destinationRoot: string,
  installed = false,
): Promise<void> {
  const entries = await readdir(sourceRoot);
  for (const entry of entries) {
    await cp(join(sourceRoot, entry), join(destinationRoot, entry), {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      filter: installed
        ? async (path) => {
            const name = basename(path);
            if (isExcludedSourceEntry(name) || isBlockedSourceFile(name)) return false;
            const stats = await lstat(path);
            if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
              throw new Error(`Remix source contains an unsupported filesystem entry: ${path}`);
            }
            return true;
          }
        : undefined,
    });
  }
}

type RemixArtifactKind = "action" | "agent" | "skill";
type RemixArtifactEntry = NonNullable<AppManifestData["actions"]>[number];

interface RemixArtifactRename {
  kind: RemixArtifactKind;
  path: string;
  configPath: string;
  sourceName: string;
  targetName: string;
  sourcePublicName: string;
}

function remixArtifactNamespace(appId: string): string {
  return appId.replaceAll("-", "_");
}

function remixArtifactName(namespace: string, sourceName: string): string {
  return `${namespace}__${sourceName}`;
}

function artifactEntryPath(entry: RemixArtifactEntry): string {
  return typeof entry === "string" ? entry : entry.path;
}

function artifactEntryPublicName(entry: RemixArtifactEntry, fallback: string): string {
  return typeof entry === "string" ? fallback : (entry.publicName ?? fallback);
}

async function readArtifactRename(
  kind: RemixArtifactKind,
  entry: RemixArtifactEntry,
  resolveRoot: string,
  namespace: string,
): Promise<RemixArtifactRename> {
  const path = artifactEntryPath(entry);
  const artifactPath = resolvePathWithinBase(resolveRoot, path, `${kind} path in remixed app`);
  const configPath =
    kind === "action"
      ? join(artifactPath, "action.yaml")
      : kind === "skill"
        ? join(artifactPath, "SKILL.md")
        : artifactPath;
  if (kind === "skill") {
    const parsed = parseSkillFrontmatterResult(await readFile(configPath, "utf-8"));
    if (!parsed.ok) {
      throw new Error(`Cannot isolate skill identity in ${configPath}: ${parsed.message}`);
    }
    return {
      kind,
      path,
      configPath,
      sourceName: parsed.value.name,
      targetName: remixArtifactName(namespace, parsed.value.name),
      sourcePublicName: artifactEntryPublicName(entry, parsed.value.name),
    };
  }
  const document = parseDocument(await readFile(configPath, "utf-8"));
  if (document.errors.length > 0) {
    throw new Error(`Cannot rewrite ${configPath}: ${document.errors[0]?.message}`);
  }
  const parsed =
    kind === "action"
      ? ActionConfigSchema.safeParse(document.toJS())
      : AgentConfigSchema.safeParse(document.toJS());
  if (!parsed.success) {
    throw new Error(
      `Cannot isolate ${kind} identity in ${configPath}: ${parsed.error.issues[0]?.message}`,
    );
  }
  const sourceName = parsed.data.name;
  return {
    kind,
    path,
    configPath,
    sourceName,
    targetName: remixArtifactName(namespace, sourceName),
    sourcePublicName: artifactEntryPublicName(entry, sourceName),
  };
}

function assertUniqueSourceArtifactNames(
  kind: RemixArtifactKind,
  renames: readonly RemixArtifactRename[],
): void {
  const seen = new Set<string>();
  for (const rename of renames) {
    if (seen.has(rename.sourceName)) {
      throw new Error(
        `Cannot remix an app with duplicate ${kind} name ${JSON.stringify(rename.sourceName)}.`,
      );
    }
    seen.add(rename.sourceName);
  }
}

async function rewriteArtifactConfig(
  rename: RemixArtifactRename,
  actionNames: ReadonlyMap<string, string>,
  agentNames: ReadonlyMap<string, string>,
): Promise<void> {
  if (rename.kind === "skill") {
    const content = await readFile(rename.configPath, "utf-8");
    const frontmatter = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/u);
    if (!frontmatter) {
      throw new Error(`Cannot rewrite ${rename.configPath}: missing frontmatter`);
    }
    const nextFrontmatter = frontmatter[2]?.replace(/^name:\s*.+$/mu, `name: ${rename.targetName}`);
    if (!nextFrontmatter || nextFrontmatter === frontmatter[2]) {
      throw new Error(`Cannot rewrite ${rename.configPath}: missing name field`);
    }
    const rewritten = `${frontmatter[1]}${nextFrontmatter}${frontmatter[3]}${content.slice(
      frontmatter[0].length,
    )}`;
    const parsed = parseSkillFrontmatterResult(rewritten);
    if (!parsed.ok || parsed.value.name !== rename.targetName) {
      throw new Error(`Cannot rewrite ${rename.configPath}: invalid remixed skill frontmatter`);
    }
    await writeFile(rename.configPath, rewritten, "utf-8");
    return;
  }
  const document = parseDocument(await readFile(rename.configPath, "utf-8"));
  if (document.errors.length > 0) {
    throw new Error(`Cannot rewrite ${rename.configPath}: ${document.errors[0]?.message}`);
  }
  const raw = document.toJS() as Record<string, unknown>;
  document.set("name", rename.targetName);
  if (rename.kind === "agent") {
    for (const key of ["tools", "actions"] as const) {
      const values = raw[key];
      if (Array.isArray(values)) {
        document.set(
          key,
          values.map((value) =>
            typeof value === "string" ? (actionNames.get(value) ?? value) : value,
          ),
        );
      }
    }
    if (Array.isArray(raw.allowedSubagents)) {
      document.set(
        "allowedSubagents",
        raw.allowedSubagents.map((value) =>
          typeof value === "string" ? (agentNames.get(value) ?? value) : value,
        ),
      );
    }
  }
  await writeFile(rename.configPath, document.toString(), "utf-8");
}

async function findMirroredArtifactConfigs(
  rootPath: string,
  actionsByName: ReadonlyMap<string, RemixArtifactRename>,
  agentsByName: ReadonlyMap<string, RemixArtifactRename>,
  skillsByName: ReadonlyMap<string, RemixArtifactRename>,
): Promise<RemixArtifactRename[]> {
  const matches: RemixArtifactRename[] = [];
  const primaryPaths = new Set(
    [...actionsByName.values(), ...agentsByName.values(), ...skillsByName.values()].map(
      (rename) => rename.configPath,
    ),
  );
  const pending = [rootPath];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (![".git", ".rome", "node_modules"].includes(entry.name)) pending.push(path);
        continue;
      }
      if (!entry.isFile() || primaryPaths.has(path)) continue;
      const isActionConfig = entry.name === "action.yaml";
      const isSkillConfig = entry.name === "SKILL.md";
      const isYaml = entry.name.endsWith(".yaml") || entry.name.endsWith(".yml");
      if (!isActionConfig && !isSkillConfig && !isYaml) continue;
      if (isSkillConfig) {
        const result = parseSkillFrontmatterResult(await readFile(path, "utf-8"));
        const source = result.ok ? skillsByName.get(result.value.name) : undefined;
        if (source) matches.push({ ...source, configPath: path });
        continue;
      }
      const document = parseDocument(await readFile(path, "utf-8"));
      if (document.errors.length > 0) continue;
      if (isActionConfig) {
        const result = ActionConfigSchema.safeParse(document.toJS());
        const source = result.success ? actionsByName.get(result.data.name) : undefined;
        if (source) matches.push({ ...source, configPath: path });
        continue;
      }
      const result = AgentConfigSchema.safeParse(document.toJS());
      const source = result.success ? agentsByName.get(result.data.name) : undefined;
      if (source) matches.push({ ...source, configPath: path });
    }
  }
  return matches;
}

function rewriteManifestArtifactEntries(
  entries: readonly RemixArtifactEntry[],
  renames: readonly RemixArtifactRename[],
  namespace: string,
): Array<Record<string, unknown>> {
  return entries.map((entry, index) => {
    const normalized = typeof entry === "string" ? { path: entry } : entry;
    const rename = renames[index];
    if (!rename) throw new Error(`Missing remix artifact rename for ${normalized.path}`);
    return {
      ...normalized,
      publicName: rename.targetName,
      ...(normalized.aliases
        ? { aliases: normalized.aliases.map((alias) => remixArtifactName(namespace, alias)) }
        : {}),
    };
  });
}

async function isolateRemixArtifactIdentities(
  rootPath: string,
  manifest: AppManifestData,
  appId: string,
): Promise<{
  actions: RemixArtifactRename[];
  agents: RemixArtifactRename[];
  skills: RemixArtifactRename[];
}> {
  const namespace = remixArtifactNamespace(appId);
  const resolveRoot = resolvePathWithinBase(
    rootPath,
    manifest.appRoot ?? "",
    `appRoot for remixed app ${appId}`,
  );
  const actions = await Promise.all(
    (manifest.actions ?? []).map((entry) =>
      readArtifactRename("action", entry, resolveRoot, namespace),
    ),
  );
  const agents = await Promise.all(
    (manifest.agents ?? []).map((entry) =>
      readArtifactRename("agent", entry, resolveRoot, namespace),
    ),
  );
  const skills = await Promise.all(
    (manifest.skills ?? []).map((entry) =>
      readArtifactRename("skill", entry, resolveRoot, namespace),
    ),
  );
  assertUniqueSourceArtifactNames("action", actions);
  assertUniqueSourceArtifactNames("agent", agents);
  assertUniqueSourceArtifactNames("skill", skills);
  const actionNames = new Map(actions.map((rename) => [rename.sourceName, rename.targetName]));
  const agentNames = new Map(agents.map((rename) => [rename.sourceName, rename.targetName]));
  const mirroredConfigs = await findMirroredArtifactConfigs(
    rootPath,
    new Map(actions.map((rename) => [rename.sourceName, rename])),
    new Map(agents.map((rename) => [rename.sourceName, rename])),
    new Map(skills.map((rename) => [rename.sourceName, rename])),
  );
  for (const rename of [...actions, ...agents, ...skills, ...mirroredConfigs]) {
    await rewriteArtifactConfig(rename, actionNames, agentNames);
  }
  return { actions, agents, skills };
}

async function rewriteRemixManifest(
  rootPath: string,
  params: { appId: string; name: string; listing: string; version: string },
): Promise<void> {
  const manifestPath = join(rootPath, "app.yaml");
  const document = parseDocument(await readFile(manifestPath, "utf-8"));
  if (document.errors.length > 0) {
    throw new Error(`Cannot rewrite ${manifestPath}: ${document.errors[0]?.message}`);
  }
  const sourceManifest = parseAppManifest(document.toJS(), manifestPath);
  const namespace = remixArtifactNamespace(params.appId);
  const artifactRenames = await isolateRemixArtifactIdentities(
    rootPath,
    sourceManifest,
    params.appId,
  );
  document.set("id", params.appId);
  document.set("name", params.name);
  document.set("remix", { listing: params.listing, version: params.version });
  if (sourceManifest.actions) {
    document.set(
      "actions",
      rewriteManifestArtifactEntries(sourceManifest.actions, artifactRenames.actions, namespace),
    );
  }
  if (sourceManifest.agents) {
    document.set(
      "agents",
      rewriteManifestArtifactEntries(sourceManifest.agents, artifactRenames.agents, namespace),
    );
  }
  if (sourceManifest.skills) {
    document.set(
      "skills",
      rewriteManifestArtifactEntries(sourceManifest.skills, artifactRenames.skills, namespace),
    );
  }
  if (sourceManifest.suggestedChannelBindings) {
    const agentNames = new Map<string, string>();
    for (const rename of artifactRenames.agents) {
      agentNames.set(rename.sourceName, rename.targetName);
      agentNames.set(rename.sourcePublicName, rename.targetName);
    }
    document.set(
      "suggestedChannelBindings",
      sourceManifest.suggestedChannelBindings.map((binding) => ({
        ...binding,
        agent: agentNames.get(binding.agent) ?? binding.agent,
      })),
    );
  }
  if (sourceManifest.db) {
    document.set("db", {
      ...sourceManifest.db,
      tablePrefix: namespace,
    });
  }
  parseAppManifest(document.toJS(), manifestPath);
  await writeFile(manifestPath, document.toString(), "utf-8");
  await rm(join(rootPath, PACKED_ARTIFACT_SENTINEL), { force: true });
}

function matchesStorePin(entry: AppEntry | null, pin: AppRemixStorePin): boolean {
  return (
    entry?.state === "installed" &&
    entry.source.mode === "appstore" &&
    normalizeListingId(entry.source.listingId)?.id === pin.listingId &&
    entry.installedVersion === pin.version &&
    entry.installedHash?.toLowerCase() === pin.contentHash &&
    (entry.source.contentHash ?? entry.installedHash)?.toLowerCase() === pin.contentHash
  );
}

export async function remixApp(
  params: RemixAppParams,
  deps: RemixAppDeps,
): Promise<RemixAppResult> {
  assertValidAppId(params.appId);
  const from = parseRemixSource(params.from);
  if (!from)
    throw new Error("Invalid Remix source: expected an installed app or a pinned Store version.");
  const sourceAppId = "appId" in from ? from.appId : from.listingId;
  assertValidAppId(sourceAppId);
  if (params.appId === sourceAppId) {
    throw new Error("A remix must use a new app id.");
  }
  const name = params.name.trim();
  const parsedName = parseListingId(name);
  if (!parsedName?.scoped) {
    throw new Error('Remix app name must be scoped, for example "@ray/calendar".');
  }
  const expectedAppId = `${parsedName.handle}-${parsedName.slug.replaceAll("_", "-")}`;
  assertValidAppId(expectedAppId);
  if (params.appId !== expectedAppId) {
    throw new Error(`Remix app id must be "${expectedAppId}" for name "${name}".`);
  }
  if (deps.appCatalog.get(params.appId) != null) {
    throw new Error(`App "${params.appId}" is already installed.`);
  }

  const authoringRoot = deps.authoringRoot ?? getCustomAppAuthoringRoot();
  const destinationRoot = getCustomAppAuthoringPath(params.appId, authoringRoot);
  if (existsSync(destinationRoot)) {
    throw new Error(`App directory ${destinationRoot} already exists.`);
  }

  await mkdir(authoringRoot, { recursive: true });
  const stagingRoot = await mkdtemp(join(authoringRoot, `.remix-${params.appId}-`));
  let extractedRoot: string | undefined;
  let committed = false;
  let destinationCreated = false;
  try {
    const entry = await deps.appManager.readLockfileEntry(sourceAppId);
    const useInstalled = "appId" in from || matchesStorePin(entry, from);
    let listing: string;
    let version: string;
    if (useInstalled) {
      if (entry?.state !== "installed") {
        throw new Error(`Source app "${sourceAppId}" is not installed.`);
      }
      if (entry.source.mode !== "appstore") {
        throw new Error(`Source app "${sourceAppId}" was not installed from the App Store.`);
      }
      listing = normalizeListingId(entry.source.listingId)?.id ?? "";
      version = entry.installedVersion ?? entry.source.version;
      if (!listing || !version) throw new Error("Source app has no valid listing or version.");
      if ("appId" in from && from.expectedSource && !matchesStorePin(entry, from.expectedSource)) {
        throw new Error(
          "Remix source changed since confirmation. Confirm the intended Store version again.",
        );
      }
      const installed = await readInstalledSource(
        sourceAppId,
        deps.installedRoot ?? getProfileInstalledAppsDir(),
        entry.installedHash,
      );
      if (installed.manifest.includeSource !== true) {
        throw new Error(`Source app "${sourceAppId}" does not enable includeSource in app.yaml.`);
      }
      if (installed.manifest.version !== version) {
        throw new Error("Installed source version changed before copying. Retry the remix.");
      }
      // Resolve active once; a concurrent upgrade must not mix files from two bundles.
      await copyRoot(installed.rootPath, stagingRoot, true);
    } else {
      if ("appId" in from) throw new Error("Expected a pinned Store source.");
      listing = from.listingId;
      version = from.version;
      const bytes = await fetchVerifiedStoreBundle(
        sourceAppId,
        { mode: "appstore", ...from },
        from.contentHash,
        deps.bundleFetcher,
      );
      extractedRoot = await mkdtemp(join(tmpdir(), "rome-remix-extract-"));
      await extractBundle(bytes, extractedRoot);
      const manifestPath = join(extractedRoot, "app.yaml");
      const manifest = parseAppManifest(await parseManifestObject(manifestPath), manifestPath);
      if (
        manifest.id !== sourceAppId ||
        manifest.version !== version ||
        manifest.includeSource !== true
      ) {
        throw new Error(
          `Downloaded bundle identity does not match remix source ${sourceAppId}@${version}, or includeSource is not enabled.`,
        );
      }
      await copyRoot(extractedRoot, stagingRoot);
    }
    await rewriteRemixManifest(stagingRoot, {
      appId: params.appId,
      name,
      listing,
      version,
    });
    if (existsSync(destinationRoot)) {
      throw new Error(`App directory ${destinationRoot} already exists.`);
    }
    await mkdir(destinationRoot);
    destinationCreated = true;
    await copyRoot(stagingRoot, destinationRoot);
    committed = true;
    return { appId: params.appId, created: true, rootPath: destinationRoot };
  } finally {
    if (extractedRoot) await rm(extractedRoot, { recursive: true, force: true }).catch(() => {});
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    if (!committed && destinationCreated) {
      await rm(destinationRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}
