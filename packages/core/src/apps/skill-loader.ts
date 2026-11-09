import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { AppCatalog } from "./catalog.js";
import { toArtifactMetadata } from "./artifact-ref-adapter.js";
import { resolveArtifactId, type ArtifactIdentityContext } from "./artifact-id.js";
import { loadArtifactRecords } from "./artifact-records.js";
import { parseSkillFrontmatterResult } from "./packaging/skill-frontmatter.js";
import type { AppOwnedArtifactLoadFailure } from "./types.js";
import type { Skill, SkillCatalog } from "../agent/index.js";

function stripSkillStructuredSection(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)*/, "").trim();
}

/**
 * The agent's skill catalog, loaded from the skills installed apps offer. The
 * composition root reloads it on every app catalog event, as it does the agent
 * and action loaders.
 */
export class SkillLoader implements SkillCatalog {
  private skills: Skill[] = [];
  private failures: AppOwnedArtifactLoadFailure[] = [];

  constructor(private readonly identity: ArtifactIdentityContext) {}

  async loadFromCatalog(catalog: AppCatalog): Promise<void> {
    const { records, failures } = await loadArtifactRecords({
      kind: "skill",
      sources: catalog.listArtifacts("skill").map(toArtifactMetadata),
      identity: this.identity,
      read: async (metadata) => {
        const skillFile = join(metadata.sourcePath, "SKILL.md");
        const content = (await readFile(skillFile, "utf-8")).trim();
        const parsed = parseSkillFrontmatterResult(content);
        if (!parsed.ok) {
          throw new Error(`Skill ${skillFile} has invalid frontmatter: ${parsed.message}`);
        }
        const files = await listCompanionFiles(metadata.sourcePath);
        return {
          ...parsed.value,
          content,
          ...(files.length > 0 ? { directory: metadata.sourcePath, files } : {}),
        };
      },
    });

    this.skills = Array.from(records, ([artifactId, { config, metadata }]) => ({
      name: artifactId,
      localName: config.name,
      description: config.description,
      tools: config.tools,
      content: stripSkillStructuredSection(config.content),
      ...(config.directory ? { directory: config.directory, files: config.files } : {}),
      ownerType: metadata.ownerType,
      ownerId: metadata.ownerId,
    })).sort((left, right) => left.name.localeCompare(right.name));
    this.failures = failures;
  }

  list(): readonly Skill[] {
    return [...this.skills];
  }

  find(name: string): Skill | undefined {
    const resolved = this.resolveName(name);
    return this.skills.find((skill) => skill.name === resolved);
  }

  /** For the apps side, which shows an author why a skill is missing. */
  getRegistryLoadFailures(): AppOwnedArtifactLoadFailure[] {
    return [...this.failures];
  }

  private resolveName(name: string): string {
    try {
      return resolveArtifactId({
        kind: "skill",
        value: name,
        legacyBindings: this.identity.legacyBindings,
      });
    } catch {
      return name;
    }
  }
}

const MAX_COMPANION_FILES = 200;
const SKIPPED_COMPANION_DIRS = new Set(["node_modules"]);

/**
 * Lists the files a skill ships beside its SKILL.md (reference docs, assets),
 * relative to the skill directory. `read_skill` returns only SKILL.md, so
 * without this list an agent cannot open the companion docs SKILL.md links
 * to — progressive disclosure stops at the first level.
 */
export async function listCompanionFiles(skillDir: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Code-point order: locale-independent, and upper-case docs lead.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (files.length >= MAX_COMPANION_FILES) return;
      // Hidden entries (.DS_Store, a stray .env) are never skill docs.
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_COMPANION_DIRS.has(entry.name)) await walk(path);
      } else if (entry.isFile()) {
        const rel = relative(skillDir, path).split(sep).join("/");
        if (rel !== "SKILL.md") files.push(rel);
      }
    }
  };
  await walk(skillDir);
  return files;
}
