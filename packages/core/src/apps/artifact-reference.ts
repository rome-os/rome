export type ArtifactReferenceKind = "agent" | "action";

export interface ArtifactReferenceInput {
  kind: ArtifactReferenceKind;
  value: string;
}

/**
 * Builds the one runtime boundary that turns external artifact references into
 * canonical IDs. Registries own legacy-name compatibility; this function only
 * selects the registry for the requested artifact kind.
 */
export function createArtifactReferenceResolver(deps: {
  /** The agent's canonical id. Throws when no installed agent has the name. */
  canonicalAgentName: (name: string) => string;
  actionRegistry: {
    getCanonicalName(name: string): string | undefined;
  };
}): (input: ArtifactReferenceInput) => string {
  return (input) => {
    if (input.kind === "agent") {
      return deps.canonicalAgentName(input.value);
    }

    const actionName = deps.actionRegistry.getCanonicalName(input.value);
    if (!actionName) {
      throw new Error(`Action "${input.value}" not found`);
    }
    return actionName;
  };
}
