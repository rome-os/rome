import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { ActionConfigSchema, AgentConfigSchema } from "./artifact-config.js";
import { formatZodIssues, readManifestSummary } from "./manifest.js";
import { resolvePathWithinBase, safeIsDir, safeIsFile } from "./path-utils.js";
import { ArtifactLocalNameV2Schema, isValidArtifactReference } from "./artifact-name.js";
import { parseSkillFrontmatterResult } from "./skill-frontmatter.js";

export class BuildValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildValidationError";
  }
}

/**
 * Verify that an installed artifact has every file the manifest references.
 * Run before a staged artifact is committed (to `installed/<hash>/` or a pack
 * outDir) — fails loudly if anything is missing rather than handing a
 * half-baked artifact to the registry.
 */
export async function validateInstalledArtifact(
  installedRoot: string,
  expectedAppId: string,
): Promise<void> {
  const manifestPath = join(installedRoot, "app.yaml");
  if (!existsSync(manifestPath)) {
    throw new BuildValidationError(`Installed artifact ${installedRoot} is missing app.yaml`);
  }

  const manifest = await readManifestSummary(manifestPath);
  if (manifest.id !== expectedAppId) {
    throw new BuildValidationError(
      `Installed artifact at ${installedRoot} has manifest id "${manifest.id}", expected "${expectedAppId}"`,
    );
  }

  const resolveBase = manifest.appRoot
    ? resolvePathWithinBase(installedRoot, manifest.appRoot, "appRoot")
    : installedRoot;

  for (const artifact of manifest.artifacts) {
    const path = resolvePathWithinBase(resolveBase, artifact.path, `${artifact.kind} entry`);
    if (!existsSync(path)) {
      throw new BuildValidationError(
        `Installed artifact for app "${manifest.id}" is missing ${artifact.kind} at "${artifact.path}". ` +
          `Looked under ${resolveBase}; run the app's build step and try again.`,
      );
    }
    if (artifact.kind === "action") {
      const config = await validateArtifactYaml(
        join(path, "action.yaml"),
        ActionConfigSchema,
        manifest.id,
        `action "${artifact.path}"`,
      );
      if (manifest.formatVersion === 2) {
        const name = (config as { name: string }).name;
        validateV2LocalName(name, manifest.id, "action");
        validateV2PublicName(artifact.publicName, name, manifest.id, "action");
      }
    } else if (artifact.kind === "agent") {
      const config = (await validateArtifactYaml(
        path,
        AgentConfigSchema,
        manifest.id,
        `agent "${artifact.path}"`,
      )) as { name: string; actions?: string[]; allowedSubagents?: string[] };
      if (config.name === "main") {
        throw new BuildValidationError(
          `Installed artifact for app "${manifest.id}" agent "${artifact.path}" uses reserved name "main"; only Rome Core may define the main agent.`,
        );
      }
      if (manifest.formatVersion === 2) {
        validateV2LocalName(config.name, manifest.id, "agent");
        validateV2PublicName(artifact.publicName, config.name, manifest.id, "agent");
        for (const [field, refs] of [
          ["actions", config.actions],
          ["allowedSubagents", config.allowedSubagents],
        ] as const) {
          for (const ref of refs ?? []) {
            if (ref !== "*" && !isValidArtifactReference(ref)) {
              throw new BuildValidationError(
                `Installed artifact for app "${manifest.id}" agent "${artifact.path}" has invalid ${field} reference ${JSON.stringify(ref)}; format version 2 requires <appId>:<name>.`,
              );
            }
          }
        }
      }
    } else if (artifact.kind === "skill") {
      const skillPath = join(path, "SKILL.md");
      if (!existsSync(skillPath)) {
        throw new BuildValidationError(
          `Installed artifact for app "${manifest.id}" skill "${artifact.path}" is missing ${skillPath}.`,
        );
      }
      const parsed = parseSkillFrontmatterResult(await readFile(skillPath, "utf-8"));
      if (!parsed.ok) {
        throw new BuildValidationError(
          `Installed artifact for app "${manifest.id}" skill "${artifact.path}" has invalid frontmatter: ${parsed.message}`,
        );
      }
      if (manifest.formatVersion === 2) {
        validateV2LocalName(parsed.value.name, manifest.id, "skill");
        validateV2PublicName(artifact.publicName, parsed.value.name, manifest.id, "skill");
      }
    }
  }

  if (manifest.webManifest) {
    const webManifestPath = resolvePathWithinBase(
      resolveBase,
      manifest.webManifest,
      "web manifest",
    );
    if (!existsSync(webManifestPath)) {
      throw new BuildValidationError(
        `Installed artifact for app "${manifest.id}" is missing web manifest at "${manifest.webManifest}". ` +
          `The build script must produce ${webManifestPath}.`,
      );
    }
    await validateWebManifest(webManifestPath, manifest.id);
  }

  if (manifest.apiEntry) {
    const entryAbs = resolveModuleEntry(resolveBase, manifest.apiEntry, "api entry");
    if (!entryAbs) {
      throw new BuildValidationError(
        `Installed artifact for app "${manifest.id}" is missing api entry "${manifest.apiEntry}". ` +
          `Looked under ${resolveBase} for a .js (or .ts) module.`,
      );
    }
  }

  if (manifest.dbMigrations) {
    const migrationsAbs = resolvePathWithinBase(
      resolveBase,
      manifest.dbMigrations,
      "db migrations",
    );
    if (!existsSync(migrationsAbs)) {
      throw new BuildValidationError(
        `Installed artifact for app "${manifest.id}" is missing db migrations at "${manifest.dbMigrations}".`,
      );
    }
    const journalPath = join(migrationsAbs, "meta", "_journal.json");
    if (!existsSync(journalPath)) {
      throw new BuildValidationError(
        `Installed artifact for app "${manifest.id}" db migrations dir ${migrationsAbs} is missing meta/_journal.json. ` +
          `Run drizzle-kit generate before installing.`,
      );
    }
  }

  if (manifest.iconPath) {
    const iconAbs = resolvePathWithinBase(resolveBase, manifest.iconPath, "icon");
    const fallbackAbs = resolvePathWithinBase(installedRoot, manifest.iconPath, "icon");
    if (!existsSync(iconAbs) && !existsSync(fallbackAbs)) {
      throw new BuildValidationError(
        `Installed artifact for app "${manifest.id}" is missing icon at "${manifest.iconPath}".`,
      );
    }
  }
}

/**
 * Runs inside the pack/install pipeline so a malformed or unknown-field
 * action.yaml / agent yaml is rejected before the bundle is committed —
 * once a bundle is published its contents are immutable.
 */
async function validateArtifactYaml(
  yamlPath: string,
  schema: z.ZodType,
  appId: string,
  label: string,
): Promise<unknown> {
  if (!existsSync(yamlPath)) {
    throw new BuildValidationError(
      `Installed artifact for app "${appId}" ${label} is missing its config at ${yamlPath}.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(await readFile(yamlPath, "utf-8"));
  } catch (err) {
    throw new BuildValidationError(
      `Installed artifact for app "${appId}" ${label} has unparseable YAML at ${yamlPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new BuildValidationError(
      `Installed artifact for app "${appId}" ${label} has an invalid config at ${yamlPath}:\n${formatZodIssues(result.error)}`,
    );
  }
  return result.data;
}

function validateV2LocalName(name: string, appId: string, kind: string): void {
  const result = ArtifactLocalNameV2Schema.safeParse(name);
  if (!result.success) {
    throw new BuildValidationError(
      `Installed artifact for app "${appId}" has invalid format version 2 ${kind} name ${JSON.stringify(name)}: ${result.error.issues[0]?.message ?? "invalid local name"}`,
    );
  }
}

function validateV2PublicName(
  publicName: string | undefined,
  localName: string,
  appId: string,
  kind: string,
): void {
  if (publicName !== undefined && publicName !== localName) {
    throw new BuildValidationError(
      `Installed artifact for app "${appId}" has format version 2 ${kind} publicName ${JSON.stringify(publicName)}, but its definition name is ${JSON.stringify(localName)}; they must match.`,
    );
  }
}

async function validateWebManifest(manifestPath: string, appId: string): Promise<void> {
  const distRoot = dirname(manifestPath);
  let parsed: unknown;
  try {
    const raw = await readFile(manifestPath, "utf-8");
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BuildValidationError(
      `Installed artifact for app "${appId}" has unreadable web manifest at ${manifestPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new BuildValidationError(
      `Installed artifact for app "${appId}" has invalid web manifest at ${manifestPath}`,
    );
  }
  const obj = parsed as Record<string, unknown>;
  const entry = obj.entry;
  if (typeof entry !== "string" || entry.length === 0) {
    throw new BuildValidationError(
      `Installed artifact for app "${appId}" web manifest at ${manifestPath} is missing "entry"`,
    );
  }
  const entryPath = resolvePathWithinBase(distRoot, entry, `web entry for app "${appId}"`);
  if (!existsSync(entryPath)) {
    throw new BuildValidationError(
      `Installed artifact for app "${appId}" web entry "${entry}" missing at ${entryPath}`,
    );
  }
  const styles = obj.styles;
  if (Array.isArray(styles)) {
    for (const stylePath of styles) {
      if (typeof stylePath !== "string") continue;
      const styleAbs = resolvePathWithinBase(
        distRoot,
        stylePath,
        `web stylesheet for app "${appId}"`,
      );
      if (!existsSync(styleAbs)) {
        throw new BuildValidationError(
          `Installed artifact for app "${appId}" web stylesheet "${stylePath}" missing at ${styleAbs}`,
        );
      }
    }
  }
}

function resolveModuleEntry(baseDir: string, entry: string, description: string): string | null {
  const direct = resolvePathWithinBase(baseDir, entry, description);
  if (existsSync(direct) && safeIsFile(direct)) return direct;

  const withJs = `${direct}.js`;
  if (existsSync(withJs) && safeIsFile(withJs)) return withJs;

  const withTs = `${direct}.ts`;
  if (existsSync(withTs) && safeIsFile(withTs)) return withTs;

  if (existsSync(direct) && safeIsDir(direct)) {
    const indexJs = join(direct, "index.js");
    if (existsSync(indexJs)) return indexJs;
    const indexTs = join(direct, "index.ts");
    if (existsSync(indexTs)) return indexTs;
  }

  return null;
}
