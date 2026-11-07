import { requireAgent, type AgentCatalog } from "../agent/index.js";

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
  agentLoader: AgentCatalog;
  actionRegistry: {
    getCanonicalName(name: string): string | undefined;
  };
}): (input: ArtifactReferenceInput) => string {
  return (input) => {
    if (input.kind === "agent") {
      return requireAgent(deps.agentLoader, input.value).name;
    }

    const actionName = deps.actionRegistry.getCanonicalName(input.value);
    if (!actionName) {
      throw new Error(`Action "${input.value}" not found`);
    }
    return actionName;
  };
}
