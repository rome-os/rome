import type { Action } from "@rome-os/app-runtime";
import type { ArtifactMetadata } from "../types.js";

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
} from "@rome-os/app-runtime";

export interface ActionRegistry {
  register(action: Action): void;
  get(name: string): Action | undefined;
  has(name: string): boolean;
  /** The full ID of the one action whose name without its app is `name`, for
   *  an error to suggest. Never resolves `name` for a lookup. */
  suggest?(name: string): string | undefined;
  /** Who registered action `name`. */
  getMetadata?(name: string): ArtifactMetadata | undefined;
  list(): string[];
  /** Return named agent-callable actions plus public actions when "*" is present. */
  getForAgent(names: string[]): Action[];
}
