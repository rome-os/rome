import { artifactLocalName } from "./artifact-name";

/** Rome Core's default agent, in its legacy (`main`) or canonical form. */
export function isMainAgentName(name: string | null | undefined): boolean {
  return name === "main" || name === "core:main";
}

// "workflow-planner" → "Workflow Planner". Canonical runtime ids are reduced
// to their app-local name first, so `dream:skill-review` stays a runtime value
// and renders as "Skill Review" in chat labels.
export function prettyAgentName(name: string): string {
  return artifactLocalName(name)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
