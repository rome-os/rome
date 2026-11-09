// Canonical shapes for cross-package data types live in @rome-os/app-runtime
// so that core and rome_apps/* agree on a single definition. Anything
// re-exported from here exists in the SDK; types unique to core (sessions,
// configs, policies, etc.) stay defined locally.

import type { PolicyRule } from "@rome-os/app-runtime";

export type {
  Attachment,
  PolicyRule,
  OutgoingAttachment,
  OutgoingMessage,
  ApprovalCardStatus,
  MessagePart,
  MessageReplyReference,
  AgentEvent,
  /** @deprecated Use AgentEvent from @rome-os/app-runtime. */
  AgentMessage,
  AgentPlan,
  AgentPlanStep,
  AgentPlanStepStatus,
  AgentAccounting,
  AgentStop,
  AgentStopReason,
  AgentContextUsage,
  AgentTokenUsage,
  ReasoningEffort,
} from "@rome-os/app-runtime";

import type { McpServerConfig } from "./agent/index.js";

export type { McpServerConfig };

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

export interface Settings {
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
