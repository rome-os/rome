import { readdir, readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AppOwnedArtifactLoadFailure, ArtifactMetadata } from "./types.js";
import type { AppCatalog } from "./catalog.js";
import { listCoreAgents } from "./core-artifacts.js";
import { toArtifactMetadata } from "./artifact-ref-adapter.js";
import { AgentConfigSchema } from "./packaging/index.js";
import { resolveArtifactId, type ArtifactIdentityContext } from "./artifact-id.js";
import { loadArtifactRecords } from "./artifact-records.js";
import { createLogger } from "../logger.js";
import {
  type Agent,
  type AgentCatalog,
  type AgentDefinition,
  resolveSubagents,
} from "../agent/index.js";

const log = createLogger("agent-loader");

/** An agent's file as the packaging schema reads it: the definition and its local name. */
type AgentFile = AgentDefinition & { name: string };

/**
 * The agent catalog, loaded from the agents core ships and the agents
 * installed apps offer. The composition root reloads it on every app catalog
 * event, as it does the skill and action loaders.
 */
/**
 * An agent as read from its file, before its subagents are resolved. Which
 * subagents resolve depends on what else is installed, so the loader resolves
 * them again whenever an agent is added or removed.
 */
export interface LoadedAgent {
  agent: Agent;
  metadata: ArtifactMetadata;
}

export class AgentLoader implements AgentCatalog {
  /** Every added agent, by canonical id, with its subagents unresolved. */
  private loaded = new Map<string, LoadedAgent>();
  /** What `list` and `find` serve: loaded agents whose subagents resolve. */
  private agents = new Map<string, Agent>();
  private coreFailures: AppOwnedArtifactLoadFailure[] = [];
  private readonly appFailures = new Map<string, AppOwnedArtifactLoadFailure[]>();
  private subagentFailures: AppOwnedArtifactLoadFailure[] = [];

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
    return [
      ...this.coreFailures,
      ...[...this.appFailures.values()].flat(),
      ...this.subagentFailures,
    ];
  }

  /** Loads the agents core ships. App agents arrive through `add`. */
  async loadCore(): Promise<void> {
    const { loaded, failures } = await this.read((await listCoreAgents()).map(toArtifactMetadata));
    for (const entry of loaded) this.loaded.set(entry.agent.name, entry);
    this.coreFailures = failures;
    this.resolve();
  }

  /** Reads one app's agents without adding them, and records that app's load failures. */
  async loadApp(catalog: AppCatalog, appId: string): Promise<LoadedAgent[]> {
    const sources = catalog
      .listArtifacts("agent")
      .filter((ref) => ref.ownerId === appId)
      .map(toArtifactMetadata);
    const { loaded, failures } = await this.read(sources);
    this.appFailures.set(appId, failures);
    return loaded;
  }

  /**
   * Adds one agent and returns its undo, which removes it only while it is
   * still this entry. Both resolve every agent's subagents again, so the main
   * agent gains or loses an app's agent as that app comes and goes.
   */
  add(entry: LoadedAgent): () => void {
    this.loaded.set(entry.agent.name, entry);
    this.resolve();
    return () => {
      if (this.loaded.get(entry.agent.name) !== entry) return;
      this.loaded.delete(entry.agent.name);
      this.resolve();
    };
  }

  private async loadRecords(sources: ArtifactMetadata[]): Promise<void> {
    const { loaded, failures } = await this.read(sources);
    this.loaded = new Map(loaded.map((entry) => [entry.agent.name, entry]));
    this.coreFailures = failures;
    this.appFailures.clear();
    this.resolve(true);
  }

  private async read(
    sources: ArtifactMetadata[],
  ): Promise<{ loaded: LoadedAgent[]; failures: AppOwnedArtifactLoadFailure[] }> {
    const { records, failures } = await loadArtifactRecords<AgentFile>({
      kind: "agent",
      sources,
      identity: this.identity,
      read: (metadata) => this.readAgentFile(metadata.sourcePath),
    });

    const loaded: LoadedAgent[] = [];
    for (const [id, { config, metadata }] of records) {
      const { name: localName, ...definition } = config;
      if (this.traits.savedSelectionOutranksPin?.includes(id)) {
        definition.savedSelectionOutranksPin = true;
      }
      loaded.push({
        agent: {
          name: id,
          localName,
          ownerType: metadata.ownerType,
          ownerId: metadata.ownerId,
          definition,
        },
        metadata,
      });
    }
    return { loaded, failures };
  }

  /**
   * Resolves every loaded agent's subagents against the loaded set. An app
   * agent naming one that is not loaded is left out and reported; a core
   * agent drops it. Warns only on a full load, since an app added later
   * brings the missing agent.
   */
  private resolve(warn = false): void {
    const ids = new Set(this.loaded.keys());
    const installedId = (reference: string): string | undefined => {
      const id = this.resolveName(reference);
      return ids.has(id) ? id : undefined;
    };

    const agents = new Map<string, Agent>();
    const failures: AppOwnedArtifactLoadFailure[] = [];
    for (const [id, { agent, metadata }] of this.loaded) {
      const definition = agent.definition;
      if (!definition.allowedSubagents) {
        agents.set(id, agent);
        continue;
      }
      const resolution = resolveSubagents(definition, metadata.ownerType, installedId);
      if (!resolution.ok) {
        failures.push({
          kind: metadata.kind,
          ownerId: metadata.ownerId,
          publicName: metadata.publicName,
          sourcePath: metadata.sourcePath,
          error:
            `Agent "${agent.localName}" references unknown subagent "${resolution.missing}". ` +
            `Available agents: ${Array.from(ids).join(", ")}`,
        });
        continue;
      }
      if (warn) {
        for (const subagent of resolution.dropped) {
          log.warn("core agent loaded without unknown subagent", {
            agent: agent.localName,
            subagent,
          });
        }
      }
      agents.set(id, {
        ...agent,
        definition: { ...definition, allowedSubagents: resolution.subagents },
      });
    }
    this.agents = agents;
    this.subagentFailures = failures;
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
