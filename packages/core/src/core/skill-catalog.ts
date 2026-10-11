import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { AppOwnedArtifactLoadFailure, ArtifactMetadata } from "../apps/types.js";
import type { AppCatalog } from "../apps/catalog.js";
import { toArtifactMetadata } from "../apps/artifact-ref-adapter.js";
import { resolveArtifactId, type ArtifactIdentityContext } from "../apps/artifact-id.js";
import { loadArtifactRecords } from "../apps/artifact-records.js";
import { parseSkillFrontmatterResult } from "../apps/packaging/skill-frontmatter.js";
export {
  parseSkillFrontmatter,
  parseSkillFrontmatterResult,
  type SkillFrontmatter,
  type SkillFrontmatterErrorReason,
  type SkillFrontmatterResult,
} from "../apps/packaging/skill-frontmatter.js";

export interface LoadedSkill {
  metadata: ArtifactMetadata;
  name: string;
  localName: string;
  description: string;
  tools?: string[];
  content: string;
  /** Absolute skill directory; set only when the skill ships companion files. */
  directory?: string;
  /** Companion files relative to `directory` (everything except SKILL.md). */
  files?: string[];
}

export interface SkillMcpDefinition {
  name: string;
  description: string;
  tools?: string[];
  content: string;
  directory?: string;
  files?: string[];
  ownerType: ArtifactMetadata["ownerType"];
  ownerId: string;
}

export function stripSkillStructuredSection(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)*/, "").trim();
}

export class SkillCatalog {
  private skills: LoadedSkill[] = [];
  private registryLoadFailures: AppOwnedArtifactLoadFailure[] = [];

  constructor(private readonly identity: ArtifactIdentityContext) {}

  async loadFromCatalog(catalog: AppCatalog): Promise<LoadedSkill[]> {
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
      metadata,
      name: artifactId,
      localName: config.name,
      description: config.description,
      tools: config.tools,
      content: config.content,
      ...(config.directory ? { directory: config.directory, files: config.files } : {}),
    })).sort((left, right) => left.name.localeCompare(right.name));
    this.registryLoadFailures = failures;
    return this.getAll();
  }

  getAll(): LoadedSkill[] {
    return [...this.skills];
  }

  get(name: string): LoadedSkill | undefined {
    const resolved = this.resolveName(name);
    return this.skills.find((skill) => skill.name === resolved);
  }

  getRegistryLoadFailures(): AppOwnedArtifactLoadFailure[] {
    return [...this.registryLoadFailures];
  }

  getMcpDefinitions(): SkillMcpDefinition[] {
    return this.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      tools: skill.tools,
      content: stripSkillStructuredSection(skill.content),
      ...(skill.directory ? { directory: skill.directory, files: skill.files } : {}),
      ownerType: skill.metadata.ownerType,
      ownerId: skill.metadata.ownerId,
    }));
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
