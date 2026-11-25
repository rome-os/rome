export { modelDisplayName } from "@rome/api-types/models";

const EFFORT_NAMES: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

/** `xhigh` → `Extra High`; an unknown effort comes back unchanged. */
export function reasoningEffortDisplayName(effort: string): string {
  return EFFORT_NAMES[effort] ?? effort;
}
