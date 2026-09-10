// Canonical shapes for cross-package data types live in @rome-os/app-runtime
// so that core and rome_apps/* agree on a single definition. Anything
// re-exported from here exists in the SDK; types unique to core (sessions,
// configs, policies, etc.) stay defined locally.

import type { ReasoningEffort } from "@rome-os/app-runtime";

export type {
  Attachment,
  ChannelSendResult,
  OutgoingAttachment,
  OutgoingMessage,
  ApprovalCardStatus,
  MessagePart,
  MessageReplyReference,
  NormalizedMessage,
  AgentMessage,
  AgentPlan,
  AgentPlanStep,
  AgentPlanStepStatus,
  AgentAccounting,
  AgentContextUsage,
  AgentTokenUsage,
  ReasoningEffort,
} from "@rome-os/app-runtime";

export interface McpServerConfig {
  command: string;
  args: string[];
}

export interface AgentConfig {
  name: string;
  description: string;
  /**
   * Provider-agnostic capability tier. Required unless modelId is set.
   * The loader normalizes legacy model: opus|sonnet|haiku to this field.
   */
  tier?: "large" | "medium" | "small";
  /**
   * Exact provider model ID. Requires providerId and excludes tier.
   * Resolution uses this ID without tier mapping or automatic substitution.
   */
  modelId?: string;
  /** Provider-agnostic reasoning effort. Defaults to `high` when omitted in YAML. */
  reasoningEffort: ReasoningEffort;
  /**
   * Optional provider pin (yaml `provider: anthropic|openai`). Required for
   * modelId. With tier, restricts model resolution to this provider.
   * An unavailable pinned provider fails with ModelResolutionError instead
   * of falling back to another provider.
   */
  providerId?: "anthropic" | "openai";
  systemPromptPrefix: string;
  tools: string[];
  actions?: string[];
  permissionMode: "acceptEdits" | "bypassPermissions" | "default";
  maxTurns?: number;
  allowedSubagents?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  networkDiscovery?: boolean;
  outputSchema?: Record<string, unknown>;
  /**
   * a code-backed agent. Its turns are always produced by a
   * turn-middleware rather than a model, so its session opens a null model
   * session (no provider query — nothing to resume or bill).
   */
  codeBacked?: boolean;
}

export interface AgentSession {
  id: string;
  agentName: string;
  channelThreadKey: string;
  providerThreadId?: string;
  createdAt: Date;
  lastActiveAt: Date;
  status: "active" | "completed" | "error";
}

/**
 * A person and the accounts linked to them.
 *
 * `channelMappings` keeps the table's and the wire's name — a channel mapping is
 * a [link](docs/concepts/people.md#link), and `channelUserId` is the account's
 * own [address](docs/concepts/people.md#address) — because
 * `@rome-os/app-runtime` publishes the field to apps.
 */
export interface PersonMapping {
  id: string;
  displayName: string;
  channelMappings: {
    channel: string;
    channelUserId: string;
  }[];
  bondLevel: "guardian" | "inner-circle" | "acquaintance" | "other";
  profilePath?: string;
  approved: boolean;
  createdAt: Date;
}

export interface Policy {
  id: string;
  scope: PolicyScope;
  rules: PolicyRule[];
  priority: number;
}

export type PolicyScope =
  | { type: "channel"; channel: string }
  | { type: "sender"; bondLevel: string }
  | { type: "sender_specific"; personId: string }
  | { type: "thread"; threadName: string; threadType: string }
  | { type: "global" };

export interface PolicyRule {
  action: "allow" | "block" | "require_approval" | "sentinel_review";
  conditions?: Record<string, unknown>;
}

export interface Settings {
  sentinelReviewIntervalMinutes: number;
  trustedBondLevels: string[];
  replyToBondLevels: string[];
  database: {
    type: "sqlite" | "postgresql";
    sqlitePath?: string;
    postgresConnectionString?: string;
    encryptionKey?: string;
  };
  webServer: {
    port: number;
    host: string;
  };
}
