import type { Agent } from "../agent/index.js";
import type { LegacyArtifactBindings } from "./artifact-id.js";

/** The agents keyed by canonical id, and by each legacy name bound to one of them. */
export function agentsByLegacyName(
  agents: readonly Agent[],
  bindings: Readonly<LegacyArtifactBindings>,
): Map<string, Agent> {
  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  for (const [legacyName, id] of Object.entries(bindings.agent)) {
    const agent = byName.get(id);
    if (agent) byName.set(legacyName, agent);
  }
  return byName;
}
