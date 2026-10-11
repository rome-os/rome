import type { Action, ActionRegistry } from "./types.js";
import type { ArtifactMetadata } from "../apps/types.js";
import {
  formatArtifactId,
  resolveArtifactId,
  type ArtifactIdentityContext,
} from "../apps/artifact-id.js";

export class ActionRegistryImpl implements ActionRegistry {
  private actions = new Map<string, Action>();
  private metadata = new Map<string, ArtifactMetadata>();

  constructor(private readonly identity?: ArtifactIdentityContext) {}

  register(action: Action, metadata?: ArtifactMetadata): void {
    const artifactId =
      metadata && this.identity
        ? formatArtifactId(metadata.ownerId, action.config.name)
        : action.config.name;
    const registeredAction =
      artifactId === action.config.name
        ? action
        : { ...action, config: { ...action.config, name: artifactId } };
    this.actions.set(artifactId, registeredAction);
    this.metadata.set(
      artifactId,
      metadata ?? {
        kind: "action",
        ownerType: "core",
        ownerId: "core",
        publicName: action.config.name,
        aliases: [],
        sourcePath: "",
      },
    );
  }

  unregister(name: string): boolean {
    this.metadata.delete(name);
    return this.actions.delete(name);
  }

  unregisterOwnedBy(ownerType: ArtifactMetadata["ownerType"], ownerId?: string): string[] {
    const removed: string[] = [];

    for (const [name, metadata] of this.metadata.entries()) {
      if (metadata.ownerType !== ownerType) {
        continue;
      }
      if (ownerId !== undefined && metadata.ownerId !== ownerId) {
        continue;
      }

      this.metadata.delete(name);
      this.actions.delete(name);
      removed.push(name);
    }

    return removed;
  }

  get(name: string): Action | undefined {
    return this.actions.get(this.resolveName(name));
  }

  has(name: string): boolean {
    return this.actions.has(this.resolveName(name));
  }

  isExplicit(name: string): boolean {
    return this.get(name)?.config.visibility === "explicit";
  }

  getCanonicalName(name: string): string | undefined {
    return this.get(name)?.config.name;
  }

  list(): string[] {
    return Array.from(this.actions.keys());
  }

  getMetadata(name: string): ArtifactMetadata | undefined {
    return this.metadata.get(this.resolveName(name));
  }

  listMetadata(): ArtifactMetadata[] {
    return Array.from(this.metadata.values());
  }

  /**
   * Return agent-callable actions (those with inputSchema) the agent may use:
   * public actions when the allow-list contains "*", plus actions named in the
   * allow-list. An explicit action never enters through
   * the wildcard. This is the single resolution point for both the model-facing
   * tool catalog and the execution gate, so the two cannot disagree about what
   * an agent is permitted to call.
   */
  getForAgent(names: string[]): Action[] {
    const result: Action[] = [];
    const included = new Set<string>();

    if (names.includes("*")) {
      for (const action of this.actions.values()) {
        if (action.inputSchema && action.config.visibility !== "explicit") {
          result.push(action);
          included.add(action.config.name);
        }
      }
    }

    for (const name of new Set(names.filter((name) => name !== "*"))) {
      const action = this.get(name);
      if (action && action.inputSchema && !included.has(action.config.name)) {
        result.push(action);
        included.add(action.config.name);
      }
    }
    return result;
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
}
