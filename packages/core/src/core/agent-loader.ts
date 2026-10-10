import { readdir, readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentConfig } from "../types.js";
import type { AppOwnedArtifactLoadFailure, ArtifactMetadata } from "../apps/types.js";
import type { AppCatalog } from "../apps/catalog.js";
import { listCoreAgents } from "../apps/core-artifacts.js";
import { toArtifactMetadata } from "../apps/artifact-ref-adapter.js";
import { AgentConfigSchema } from "../apps/packaging/index.js";
import { resolveArtifactId, type ArtifactIdentityContext } from "../apps/artifact-id.js";
import { loadArtifactRecords } from "../apps/artifact-records.js";
import { createLogger } from "../logger.js";

const log = createLogger("agent-loader");

export class AgentLoader {
  private agents: Map<string, AgentConfig> = new Map();
  private records: Map<string, { config: AgentConfig; metadata: ArtifactMetadata }> = new Map();
  private registryLoadFailures: AppOwnedArtifactLoadFailure[] = [];

  constructor(private readonly identity: ArtifactIdentityContext) {}

  /** Load all agent YAML files from a directory, validate, and store them. */
  async loadAll(dir: string = "agents"): Promise<Map<string, AgentConfig>> {
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

    return this.loadRecords(yamlFiles);
  }

  async loadFromCatalog(catalog: AppCatalog): Promise<Map<string, AgentConfig>> {
    const coreRefs = await listCoreAgents();
    const appRefs = catalog.listArtifacts("agent");
    return this.loadRecords([...coreRefs, ...appRefs].map(toArtifactMetadata));
  }

  /** Get an agent config by name. Throws if not found. */
  get(name: string): AgentConfig {
    const config = this.agents.get(this.resolveName(name));
    if (!config) {
      throw new Error(
        `Agent "${name}" not found. ` +
          `Available agents: ${Array.from(this.agents.keys()).join(", ") || "(none loaded)"}`,
      );
    }
    return config;
  }

  has(name: string): boolean {
    return this.agents.has(this.resolveName(name));
  }

  getCanonicalName(name: string): string {
    const resolved = this.resolveName(name);
    if (!this.agents.has(resolved)) {
      this.get(name);
    }
    return resolved;
  }

  getAll(): Map<string, AgentConfig> {
    return new Map(this.agents);
  }

  getRecord(name: string): { config: AgentConfig; metadata: ArtifactMetadata } {
    const record = this.records.get(this.resolveName(name));
    if (!record) {
      throw new Error(
        `Agent "${name}" not found. ` +
          `Available agents: ${Array.from(this.agents.keys()).join(", ") || "(none loaded)"}`,
      );
    }
    return record;
  }

  getAllRecords(): Map<string, { config: AgentConfig; metadata: ArtifactMetadata }> {
    return new Map(this.records);
  }

  getAllResolvableRecords(): Map<string, { config: AgentConfig; metadata: ArtifactMetadata }> {
    const records = this.getAllRecords();

    for (const [legacyName, artifactId] of Object.entries(this.identity.legacyBindings.agent)) {
      const record = this.records.get(artifactId);
      if (record) records.set(legacyName, record);
    }
    return records;
  }

  getRegistryLoadFailures(): AppOwnedArtifactLoadFailure[] {
    return [...this.registryLoadFailures];
  }

  private async loadRecords(sources: ArtifactMetadata[]): Promise<Map<string, AgentConfig>> {
    const { records, failures: registryLoadFailures } = await loadArtifactRecords({
      kind: "agent",
      sources,
      identity: this.identity,
      read: (metadata) => this.readAgentConfig(metadata.sourcePath),
    });
    const nextRecords = new Map<string, { config: AgentConfig; metadata: ArtifactMetadata }>(
      records,
    );

    const nameSet = new Set(nextRecords.keys());
    for (const [name, { config, metadata }] of nextRecords.entries()) {
      if (!config.allowedSubagents) continue;
      const resolvedSubagents: string[] = [];
      for (const subagent of config.allowedSubagents) {
        const resolved = this.resolveName(subagent);
        if (!nameSet.has(resolved)) {
          const message =
            `Agent "${config.name}" references unknown subagent "${subagent}". ` +
            `Available agents: ${Array.from(nameSet).join(", ")}`;
          // A core agent's subagents come from apps, which leave the catalog
          // while they reinstall and stay out while disabled. Boot already
          // checks that every referenced app ships, so a gap here is temporary
          // or guardian-chosen: the agent loads without that subagent instead
          // of failing the whole reload.
          if (metadata.ownerType !== "app") {
            log.warn("core agent loaded without unknown subagent", {
              agent: config.name,
              subagent,
            });
            continue;
          }

          registryLoadFailures.push({
            kind: metadata.kind,
            ownerId: metadata.ownerId,
            publicName: metadata.publicName,
            sourcePath: metadata.sourcePath,
            error: message,
          });
          nextRecords.delete(name);
          break;
        }
        resolvedSubagents.push(resolved);
      }
      if (nextRecords.has(name)) {
        nextRecords.set(name, {
          metadata,
          config: { ...config, allowedSubagents: resolvedSubagents },
        });
      }
    }

    this.records = nextRecords;
    this.agents = new Map(
      Array.from(nextRecords.entries()).map(([name, record]) => [name, record.config]),
    );
    this.registryLoadFailures = registryLoadFailures;
    return this.getAll();
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

  private async readAgentConfig(filePath: string): Promise<AgentConfig> {
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
