import type { Action, ActionRegistry } from "./types.js";
import type { ArtifactMetadata } from "../types.js";
import { validateActionArgs } from "./validate-action-args.js";
import {
  artifactLocalName,
  formatArtifactId,
  type ArtifactIdentityContext,
} from "../artifact-id.js";

/** What an unknown-action error ends with when `name` is an action's name
 *  without its app: the full ID to call instead, or nothing. */
export function didYouMean(registry: Pick<ActionRegistry, "suggest">, name: string): string {
  const suggestion = registry.suggest?.(name);
  return suggestion ? `. Did you mean "${suggestion}"?` : "";
}

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
    return this.actions.get(name);
  }

  has(name: string): boolean {
    return this.actions.has(name);
  }

  isExplicit(name: string): boolean {
    return this.get(name)?.config.visibility === "explicit";
  }

  /** Checks args against the named action's input schema. Returns an error
   * message, or null when the args fit, the action declares no schema, or the
   * action is unknown (`has()` answers that). */
  validateArgs(name: string, args: Record<string, unknown>): string | null {
    const action = this.get(name);
    if (!action) return null;
    return validateActionArgs(action.config.name, args, action.inputSchema);
  }

  suggest(name: string): string | undefined {
    if (name.includes(":")) return undefined;
    const matches = this.list().filter((id) => id !== name && artifactLocalName(id) === name);
    return matches.length === 1 ? matches[0] : undefined;
  }

  list(): string[] {
    return Array.from(this.actions.keys());
  }

  getMetadata(name: string): ArtifactMetadata | undefined {
    return this.metadata.get(name);
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
}
