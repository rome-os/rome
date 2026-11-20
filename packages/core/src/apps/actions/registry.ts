import type { Action, ActionRegistry } from "./types.js";
import type { ArtifactMetadata } from "../types.js";
import { validateActionArgs } from "./validate-action-args.js";
import { createLogger } from "../../logger.js";
import {
  artifactLocalName,
  formatArtifactId,
  type ArtifactIdentityContext,
} from "../artifact-id.js";

const log = createLogger("action-registry");

/** What an unknown-action error ends with when `name` is an action's name
 *  without its app: the full ID to call instead, or nothing. `permitted` keeps
 *  the hint to actions the caller may call, so it names nothing else. */
export function didYouMean(
  registry: Pick<ActionRegistry, "suggest">,
  name: string,
  permitted: (id: string) => boolean = () => true,
): string {
  const suggestion = registry.suggest?.(name);
  return suggestion && permitted(suggestion) ? `. Did you mean "${suggestion}"?` : "";
}

/** The one full ID among `ids` whose name without its app is `name`, or
 *  undefined when none or several are. */
export function suggestFullId(ids: Iterable<string>, name: string): string | undefined {
  if (name.includes(":")) return undefined;
  const matches = [...ids].filter((id) => id !== name && artifactLocalName(id) === name);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Full IDs keyed by their name without the app, for names exactly one of
 *  `ids` has. */
export function fullIdsByUniqueLocalName(ids: Iterable<string>): Record<string, string> {
  const byName = new Map<string, string[]>();
  for (const id of ids) {
    if (!id.includes(":")) continue;
    const name = artifactLocalName(id);
    byName.set(name, [...(byName.get(name) ?? []), id]);
  }
  return Object.fromEntries(
    [...byName].filter(([, matches]) => matches.length === 1).map(([name, [id]]) => [name, id]),
  );
}

export class ActionRegistryImpl implements ActionRegistry {
  private actions = new Map<string, Action>();
  private warnedAllowListNames = new Set<string>();
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
    return suggestFullId(this.actions.keys(), name);
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
      if (!action) this.warnBareAllowListName(name);
      if (action && action.inputSchema && !included.has(action.config.name)) {
        result.push(action);
        included.add(action.config.name);
      }
    }
    return result;
  }

  // An allow-list written before actions were named by full ID grants nothing
  // for its bare entries; the log names the ID to write instead, once each.
  private warnBareAllowListName(name: string): void {
    const suggestion = this.suggest(name);
    if (!suggestion || this.warnedAllowListNames.has(name)) return;
    this.warnedAllowListNames.add(name);
    log.warn("agent allow-list names an action without its app", { name, fullId: suggestion });
  }
}
