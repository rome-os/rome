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

const APPROVAL_PER_CALL = Symbol("approval-per-call");

/** Marks a `requiresApproval` action whose `preview` also decides each call:
 *  a call it words no card for runs without approval. Core's agent tools are
 *  marked (agent-tool.ts); the mark is core's, so no app action carries it. */
export function withApprovalPerCall(action: Action): Action {
  return Object.assign(action, { [APPROVAL_PER_CALL]: true });
}

export function decidesApprovalPerCall(action: Action): boolean {
  return (action as { [APPROVAL_PER_CALL]?: boolean })[APPROVAL_PER_CALL] === true;
}

export interface ActionRegistry {
  register(action: Action): void;
  get(name: string): Action | undefined;
  has(name: string): boolean;
  getCanonicalName?(name: string): string | undefined;
  /** Who registered action `name`, under any of its names. */
  getMetadata?(name: string): ArtifactMetadata | undefined;
  list(): string[];
  /** Return named agent-callable actions plus public actions when "*" is present. */
  getForAgent(names: string[]): Action[];
}
