import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
}

export interface SkillMcpDefinition {
  name: string;
  description: string;
  tools?: string[];
  content: string;
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
        return { ...parsed.value, content };
      },
    });

    this.skills = Array.from(records, ([artifactId, { config, metadata }]) => ({
      metadata,
      name: artifactId,
      localName: config.name,
      description: config.description,
      tools: config.tools,
      content: config.content,
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
