import { readdir, readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AppOwnedArtifactLoadFailure, ArtifactMetadata } from "../../apps/types.js";
import type { AppCatalog } from "../../apps/catalog.js";
import { listCoreAgents } from "../../apps/core-artifacts.js";
import { toArtifactMetadata } from "../../apps/artifact-ref-adapter.js";
import { AgentConfigSchema } from "../../apps/packaging/index.js";
import { resolveArtifactId, type ArtifactIdentityContext } from "../../apps/artifact-id.js";
import { loadArtifactRecords } from "../../apps/artifact-records.js";
import { createLogger } from "../../logger.js";
import {
  type Agent,
  type AgentCatalog,
  type AgentDefinition,
  resolveSubagents,
} from "../domain/agent-definition.js";

const log = createLogger("agent-loader");

/** An agent's file as the packaging schema reads it: the definition and its local name. */
type AgentFile = AgentDefinition & { name: string };

/**
 * The agent catalog, loaded from the agents core ships and the agents
 * installed apps offer. The composition root reloads it on every app catalog
 * event, as it does the skill and action loaders.
 */
export class AgentLoader implements AgentCatalog {
  private agents = new Map<string, Agent>();
  private failures: AppOwnedArtifactLoadFailure[] = [];

  constructor(
    private readonly identity: ArtifactIdentityContext,
    /** Traits Rome gives agents, by canonical id, beyond what their files declare. */
    private readonly traits: { savedSelectionOutranksPin?: readonly string[] } = {},
  ) {}

  list(): readonly Agent[] {
    return [...this.agents.values()];
  }

  find(name: string): Agent | undefined {
    return this.agents.get(this.resolveName(name));
  }

  async loadFromCatalog(catalog: AppCatalog): Promise<void> {
    const coreRefs = await listCoreAgents();
    const appRefs = catalog.listArtifacts("agent");
    await this.loadRecords([...coreRefs, ...appRefs].map(toArtifactMetadata));
  }

  /** Every agent file in `dir`, as core agents. For tests that run on fixtures. */
  async loadAll(dir: string): Promise<void> {
    const entries = await readdir(dir);
    const yamlFiles = entries
      .filter((f) => extname(f) === ".yaml" || extname(f) === ".yml")
      .map((file) => ({
        kind: "agent" as const,
        ownerType: "core" as const,
        ownerId: "core",
        publicName: file.replace(/\.(yaml|yml)$/u, ""),
        aliases: [],
        sourcePath: join(dir, file),
      }));

    if (yamlFiles.length === 0) {
      throw new Error(`No YAML files found in directory: ${dir}`);
    }

    await this.loadRecords(yamlFiles);
  }

  getRegistryLoadFailures(): AppOwnedArtifactLoadFailure[] {
    return [...this.failures];
  }

  private async loadRecords(sources: ArtifactMetadata[]): Promise<void> {
    const { records, failures } = await loadArtifactRecords<AgentFile>({
      kind: "agent",
      sources,
      identity: this.identity,
      read: (metadata) => this.readAgentFile(metadata.sourcePath),
    });

    // Every agent that passed its schema and identity, before any subagent check.
    const ids = new Set<string>(records.keys());
    const installedId = (reference: string): string | undefined => {
      const id = this.resolveName(reference);
      return ids.has(id) ? id : undefined;
    };

    const agents = new Map<string, Agent>();
    for (const [id, { config, metadata }] of records) {
      const { name: localName, ...definition } = config;
      if (definition.allowedSubagents) {
        const resolution = resolveSubagents(definition, metadata.ownerType, installedId);
        if (!resolution.ok) {
          failures.push({
            kind: metadata.kind,
            ownerId: metadata.ownerId,
            publicName: metadata.publicName,
            sourcePath: metadata.sourcePath,
            error:
              `Agent "${localName}" references unknown subagent "${resolution.missing}". ` +
              `Available agents: ${Array.from(ids).join(", ")}`,
          });
          continue;
        }
        for (const subagent of resolution.dropped) {
          log.warn("core agent loaded without unknown subagent", { agent: localName, subagent });
        }
        definition.allowedSubagents = resolution.subagents;
      }
      if (this.traits.savedSelectionOutranksPin?.includes(id)) {
        definition.savedSelectionOutranksPin = true;
      }
      agents.set(id, {
        name: id,
        localName,
        ownerType: metadata.ownerType,
        ownerId: metadata.ownerId,
        definition,
      });
    }

    this.agents = agents;
    this.failures = failures;
  }

  private resolveName(name: string): string {
    try {
      return resolveArtifactId({
        kind: "agent",
        value: name,
        legacyBindings: this.identity.legacyBindings,
      });
    } catch {
      return name;
    }
  }

  private async readAgentFile(filePath: string): Promise<AgentFile> {
    const raw = await readFile(filePath, "utf-8");

    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (err) {
      throw new Error(
        `Failed to parse YAML in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const result = AgentConfigSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
        .join("\n");
      throw new Error(`Invalid agent config in ${filePath}:\n${issues}`);
    }

    return result.data;
  }
}
