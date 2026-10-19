import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ActionConfig } from "./types.js";
import type { AppOwnedArtifactLoadFailure, ArtifactMetadata } from "../apps/types.js";
import type { AppCatalog } from "../apps/catalog.js";
import { toArtifactMetadata } from "../apps/artifact-ref-adapter.js";
import { ActionConfigSchema } from "../apps/packaging/index.js";
import { resolveArtifactId, type ArtifactIdentityContext } from "../apps/artifact-id.js";
import { loadArtifactRecords } from "../apps/artifact-records.js";

export class ActionLoader {
  private records = new Map<
    string,
    { config: ActionConfig; metadata: ArtifactMetadata; directory: string }
  >();
  private registryLoadFailures: AppOwnedArtifactLoadFailure[] = [];

  constructor(private readonly identity: ArtifactIdentityContext) {}

  async loadFromCatalog(catalog: AppCatalog): Promise<void> {
    const { records, failures } = await loadArtifactRecords({
      kind: "action",
      sources: catalog.listArtifacts("action").map(toArtifactMetadata),
      identity: this.identity,
      read: (metadata) => this.readActionConfig(join(metadata.sourcePath, "action.yaml")),
    });
    this.records = new Map(
      Array.from(records, ([id, { config, metadata }]) => [
        id,
        { config, metadata, directory: metadata.sourcePath },
      ]),
    );
    this.registryLoadFailures = failures;
  }

  get(name: string): ActionConfig | undefined {
    return this.records.get(this.resolveName(name))?.config;
  }

  getAllRecords(): Map<
    string,
    { config: ActionConfig; metadata: ArtifactMetadata; directory: string }
  > {
    return new Map(this.records);
  }

  getRegistryLoadFailures(): AppOwnedArtifactLoadFailure[] {
    return [...this.registryLoadFailures];
  }

  private resolveName(name: string): string {
    try {
      return resolveArtifactId({
        kind: "action",
        value: name,
        legacyBindings: this.identity.legacyBindings,
      });
    } catch {
      return name;
    }
  }

  private async readActionConfig(yamlPath: string): Promise<ActionConfig> {
    const raw = await readFile(yamlPath, "utf-8");

    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (err) {
      throw new Error(
        `Failed to parse YAML in ${yamlPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const result = ActionConfigSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
        .join("\n");
      throw new Error(`Invalid action config in ${yamlPath}:\n${issues}`);
    }

    return result.data;
  }
}
