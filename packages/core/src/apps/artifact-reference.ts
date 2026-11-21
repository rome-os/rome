export type ArtifactReferenceKind = "agent" | "action";

export interface ArtifactReferenceInput {
  kind: ArtifactReferenceKind;
  value: string;
}

/**
 * Builds the one runtime boundary that turns external artifact references into
 * canonical IDs. An action is referenced by its full ID only; this function
 * selects the registry for the requested artifact kind.
 */
export function createArtifactReferenceResolver(deps: {
  /** The agent's canonical id. Throws when no installed agent has the name. */
  canonicalAgentName: (name: string) => string;
  actionRegistry: {
    has(name: string): boolean;
  };
}): (input: ArtifactReferenceInput) => string {
  return (input) => {
    if (input.kind === "agent") {
      return deps.canonicalAgentName(input.value);
    }

    if (!deps.actionRegistry.has(input.value)) {
      throw new Error(`Action "${input.value}" not found`);
    }
    return input.value;
  };
}
