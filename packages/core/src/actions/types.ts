import type { ActionExecutionContext, ActionResult, PreviewPayload } from "@rome-os/app-runtime";

export interface ActionConfig {
  name: string;
  type: "system" | "custom";
  description: string;
  /** Optional relative module entry path from the action directory (default: ./index.ts or ./index.js). */
  entry?: string;
  /** Defaults to public. Explicit actions require an exact agent allow-list entry. */
  visibility?: "public" | "explicit";
  complexity: "simple" | "moderate" | "complex";
  speed: "fast" | "moderate" | "slow";
  reliability: "high" | "medium" | "low";
  sideEffects: "read-only" | "write";
  requiresApproval?: boolean;
  cancellable?: boolean;
  webhook?: boolean;
  favorRequirement?: FavorRequirementConfig;
}

export interface FavorRequirementConfig {
  amount: number;
  title: string;
  summary?: string;
  displayFields?: Array<{ label: string; from: string }>;
}

export interface Action {
  config: ActionConfig;
  /** Present = agent-callable action (tool). Absent = event-only action (workflow). */
  inputSchema?: Record<string, unknown>;
  execute(args: Record<string, unknown>, context?: ActionExecutionContext): Promise<ActionResult>;
  /**
   * Optional preview renderer. Returns a structured payload describing what
   * the action would do, used to build approval cards shown to the guardian.
   * Usually pure over args; may be async when the runtime lazily loads the
   * action implementation before rendering the preview.
   */
  preview?(args: Record<string, unknown>): PreviewPayload | Promise<PreviewPayload | undefined>;
}

// Canonical envelope types live in @rome-os/app-runtime so apps and core
// agree on the shape without two copies drifting. Re-exported here so
// existing imports from "../actions/types.js" keep working.
export type {
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
