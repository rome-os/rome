import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ActionConfig } from "./types.js";
import type { AppOwnedArtifactLoadFailure, ArtifactMetadata } from "../apps/types.js";
import type { AppCatalog } from "../apps/catalog.js";
import { listCoreArtifactsByKind } from "../apps/core-artifacts.js";
import { toArtifactMetadata } from "../apps/artifact-ref-adapter.js";
import { ActionConfigSchema } from "../apps/packaging/index.js";
import {
  claimLegacyArtifactNames,
  formatArtifactId,
  resolveArtifactId,
  type ArtifactIdentityContext,
} from "../apps/artifact-id.js";

export class ActionLoader {
  private records = new Map<
    string,
    { config: ActionConfig; metadata: ArtifactMetadata; directory: string }
  >();
  private registryLoadFailures: AppOwnedArtifactLoadFailure[] = [];

  constructor(private readonly identity?: ArtifactIdentityContext) {}

  async loadFromCatalog(catalog: AppCatalog): Promise<void> {
    const coreRefs = await listCoreArtifactsByKind("action");
    const appRefs = catalog.listArtifacts("action");
    const sources = [...coreRefs, ...appRefs].map((ref) => {
      const metadata = toArtifactMetadata(ref);
      return {
        yamlPath: join(metadata.sourcePath, "action.yaml"),
        directory: metadata.sourcePath,
        metadata,
      };
    });
    await this.loadRecords(sources);
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

  private async loadRecords(
    sources: Array<{ yamlPath: string; directory: string; metadata: ArtifactMetadata }>,
  ): Promise<void> {
    const nextRecords = new Map<
      string,
      { config: ActionConfig; metadata: ArtifactMetadata; directory: string }
    >();
    const registryLoadFailures: AppOwnedArtifactLoadFailure[] = [];

    for (const source of sources) {
      let config: ActionConfig;
      try {
        config = await this.readActionConfig(source.yamlPath);
      } catch (err) {
        if (source.metadata.ownerType !== "app") {
          throw err;
        }

        registryLoadFailures.push({
          kind: source.metadata.kind,
          ownerId: source.metadata.ownerId,
          publicName: source.metadata.publicName,
          sourcePath: source.metadata.sourcePath,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const artifactId = this.identity
        ? formatArtifactId(source.metadata.ownerId, config.name)
        : config.name;
      if (
        this.identity &&
        (source.metadata.ownerType === "core" || source.metadata.formatVersion !== 2)
      ) {
        const claim = claimLegacyArtifactNames(
          this.identity.legacyBindings,
          "action",
          [config.name, source.metadata.publicName, ...source.metadata.aliases],
          artifactId as ReturnType<typeof formatArtifactId>,
        );
        if (claim.conflicts.length > 0) {
          const error = `Legacy action name conflict: ${claim.conflicts
            .map(
              ({ legacyName, artifactId: owner }) =>
                `${JSON.stringify(legacyName)} is bound to ${owner}`,
            )
            .join(", ")}`;
          if (source.metadata.ownerType !== "app") throw new Error(error);
          registryLoadFailures.push({
            kind: source.metadata.kind,
            ownerId: source.metadata.ownerId,
            publicName: source.metadata.publicName,
            sourcePath: source.metadata.sourcePath,
            error,
          });
          continue;
        }
      }

      if (nextRecords.has(artifactId)) {
        if (source.metadata.ownerType !== "app") {
          throw new Error(`Duplicate action name "${config.name}" found in ${source.yamlPath}`);
        }

        registryLoadFailures.push({
          kind: source.metadata.kind,
          ownerId: source.metadata.ownerId,
          publicName: source.metadata.publicName,
          sourcePath: source.metadata.sourcePath,
          error: `Duplicate action name "${config.name}" found in ${source.yamlPath}`,
        });
        continue;
      }
      nextRecords.set(artifactId, {
        config,
        metadata: source.metadata,
        directory: source.directory,
      });
    }

    this.records = nextRecords;
    this.registryLoadFailures = registryLoadFailures;
  }

  private resolveName(name: string): string {
    if (!this.identity) return name;
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
