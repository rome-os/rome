import type { Action } from "@rome-os/app-runtime";

// Canonical action and envelope types live in @rome-os/app-runtime so apps and
// core agree on the shape without two copies drifting.
export type {
  Action,
  ActionConfig,
  FavorRequirementConfig,
  PreviewPayload,
  ActionResult,
  PendingApproval,
  PendingInteraction,
  Handoff,
  HandbackSpec,
} from "@rome-os/app-runtime";

export interface ActionRegistry {
  register(action: Action): void;
  get(name: string): Action | undefined;
  has(name: string): boolean;
  getCanonicalName?(name: string): string | undefined;
  list(): string[];
  /** Return named agent-callable actions plus public actions when "*" is present. */
  getForAgent(names: string[]): Action[];
}
