// The agents Rome can run and what each declares. docs/domains/agents.md
// carries the language; the fields are in docs/concepts/agents.md.

import type { AgentPolicy } from "./agent-policy.js";
import type { McpServerConfig, ModelReasoningEffort } from "./model-port.js";
import type { ModelTier } from "./model-tier.js";
import type { AgentName } from "./session.js";

/** What an agent declares about itself in its file. Rome reads it and never stores or edits it. */
export interface AgentDefinition {
  description: string;
  /** Required unless `modelId` is set. */
  tier?: ModelTier;
  /** An exact model. Requires `providerId` and excludes `tier`. */
  modelId?: string;
  reasoningEffort: ModelReasoningEffort;
  /** With `modelId`, the provider that serves it. With `tier`, restricts the tier to this provider. */
  providerId?: "anthropic" | "openai";
  systemPromptPrefix: string;
  tools: string[];
  actions?: string[];
  permissionMode: "acceptEdits" | "bypassPermissions" | "default";
  maxTurns?: number;
  /** Canonical ids once loaded. */
  allowedSubagents?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  networkDiscovery?: boolean;
  outputSchema?: Record<string, unknown>;
  /** Its turns come from a turn middleware, never a model, so its session opens no provider query. */
  codeBacked?: boolean;
  policy?: Partial<AgentPolicy>;
  /**
   * On a cold resume, the model a chat saved replaces the model the session is
   * pinned to. Rome sets it for the Concierge, whose quota failover must reach
   * background turns (docs/adrs/concierge-provider-failover.md). No agent file
   * declares it.
   */
  savedSelectionOutranksPin?: boolean;
}

/** An installed agent. */
export interface Agent {
  /** The canonical id, `<app-id>:<local-name>`. */
  name: AgentName;
  /** The name in its own file. */
  localName: string;
  /** Core, or the app that installed the agent, and that app's id. */
  ownerType: "core" | "app";
  ownerId: string;
  definition: AgentDefinition;
}

/** The agents Rome can run. Installs show at once. A session keeps the definition it opened with. */
export interface AgentCatalog {
  /** In load order. */
  list(): readonly Agent[];
  /** By canonical id, alias or legacy name. */
  find(name: string): Agent | undefined;
}

/** The agent by any of its names. Throws when no installed agent has the name. */
export function requireAgent(catalog: AgentCatalog, name: string): Agent {
  const agent = catalog.find(name);
  if (agent) return agent;
  const known = catalog.list().map((a) => a.name);
  throw new Error(
    `Agent "${name}" not found. Available agents: ${known.join(", ") || "(none loaded)"}`,
  );
}

export type SubagentResolution =
  | { ok: true; subagents: string[]; dropped: string[] }
  | { ok: false; missing: string };

/**
 * A subagent that is not installed. A core agent loads without it, because a
 * core agent's subagents come from apps that may be reinstalling or disabled.
 * An app's agent fails to load. `installedId` answers for every agent that
 * passed its schema and identity in this load, before any subagent check, so
 * a subagent that fails to load for its own reasons does not fail the agent
 * that names it.
 */
export function resolveSubagents(
  definition: AgentDefinition,
  ownerType: Agent["ownerType"],
  installedId: (reference: string) => string | undefined,
): SubagentResolution {
  const subagents: string[] = [];
  const dropped: string[] = [];
  for (const reference of definition.allowedSubagents ?? []) {
    const id = installedId(reference);
    if (id !== undefined) subagents.push(id);
    else if (ownerType === "app") return { ok: false, missing: reference };
    else dropped.push(reference);
  }
  return { ok: true, subagents, dropped };
}
