// Root actions main runs in its own process. Placement rule:
// docs/concepts/actions.md#placement.
import { artifactLocalName, formatArtifactId } from "../apps/artifact-id.js";
import type { ArtifactMetadata } from "../apps/types.js";

/**
 * Canonical ids of the actions main runs in-process when it dispatches them as
 * a root. Each is a first-party, non-cancellable leaf whose handler only calls
 * main-owned services, so a worker would add nothing but a slot taken from the
 * capped worker budget. Adding an id moves that handler, and any crash in it,
 * into main.
 */
export const MAIN_PROCESS_ACTION_IDS: ReadonlySet<string> = new Set([
  "system:create_routine",
  "system:send_user_message",
  "system:send_feedback",
]);

/**
 * Builds the ActionEngine `runsRootInMain` check. An action matches only when
 * its registry metadata names the owner that the allowlisted canonical id
 * names, so another app's action with the same local name never matches.
 */
export function createRunsRootInMain(registry: {
  getMetadata(name: string): ArtifactMetadata | undefined;
}): (actionName: string) => boolean {
  return (actionName) => {
    const metadata = registry.getMetadata(actionName);
    if (metadata?.ownerType !== "app") return false;
    return MAIN_PROCESS_ACTION_IDS.has(
      formatArtifactId(metadata.ownerId, artifactLocalName(actionName)),
    );
  };
}
