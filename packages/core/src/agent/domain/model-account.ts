// The model provider account: whose subscription the agent's turns run under
// when Rome credits is not the payer (the payer is `ModelFunding` in
// model-port.ts). The account reports its own availability, with the status
// and usage it read it off, and Rome derives none of it: a turn the provider
// refuses is learned by the provider's adapter and shows in the account's
// next report. The guardian authorizes Rome to run models under their
// subscription, by browser or by device code, may cancel an authorization in
// progress, and revokes it.
//
// Rome never acts or chats as this account, so it is not a connection
// (docs/domains/connections.md), and the guardian signing in to Rome is a
// different act, so the port's operations say authorize and revoke. The one
// exception is the status field `loggedIn`, which keeps the name the dashboard
// reads today. docs/domains/agents.md carries the language.

import type { ModelAccountReport } from "./model-account-report.js";

/** The provider's subscription tier, as the provider reports it. */
export type ModelPlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "prolite"
  | "team"
  | "self_serve_business_usage_based"
  | "business"
  | "enterprise_cbp_usage_based"
  | "enterprise"
  | "edu"
  | "unknown";

/** What the provider says about the account: whether Rome is authorized, how, and as whom. */
export interface ModelAccountStatus {
  loggedIn: boolean;
  authMode?: "chatgpt" | "apikey" | null;
  planType?: ModelPlanType;
  email?: string;
  authMethod?: string;
  accountType?: string;
  needsReauth?: boolean;
  /** The models the plan does not allow, when the provider withholds some. Absent means none. */
  modelsDenied?: readonly string[];
  /**
   * Whether the provider limits the account's usage, as it does a
   * subscription and not an account billed per use. Absent reads as limited.
   */
  usageLimited?: boolean;
}

/** One of the provider's rolling usage windows. */
export interface ModelUsageWindow {
  usedPercent?: number;
  remainingPercent?: number;
  resetsAt?: string;
}

/** The account's usage against the provider's limits, as last read. */
export interface ModelAccountUsage {
  checkedAt: string;
  source: string;
  fiveHour?: ModelUsageWindow;
  sevenDay?: ModelUsageWindow;
  error?: string;
}

/** How the guardian authorizes Rome: in a browser, or by typing a device code. */
export type ModelAuthorizationMode = "browser" | "device";

/** An authorization in progress, or none. */
export interface ModelAuthorizationState {
  running: boolean;
  mode: ModelAuthorizationMode | null;
  userCode: string | null;
  verificationUrl: string | null;
  lastError: string | null;
}

/** A browser authorization the provider started: the URL the guardian opens. */
export interface ModelBrowserAuthorization {
  authorizationId: string;
  authUrl: string;
}

/** A device-code authorization the provider started: the code and where to enter it. */
export interface ModelDeviceAuthorization {
  authorizationId: string;
  userCode: string;
  verificationUrl: string;
}

/**
 * The model provider account as this context reads it. Model accounts
 * read it and remember the answer; the dashboard revokes it; the agent run
 * never calls it. The adapter in infrastructure/ implements it on the
 * provider's own process.
 */
export interface ModelAccount {
  /**
   * Whether a run can use the provider now and why not, with the status and
   * usage it was read off. Rejects when the account could not be read at all.
   */
  report(): Promise<ModelAccountReport>;
  /** Takes the authorization back. */
  revoke(): Promise<void>;
  /** Fires when the account's report may have changed; returns the unsubscribe. */
  onChanged(listener: () => void): () => void;
  close(): void;
}

/**
 * Authorizing Rome under the account from inside Rome. Only the Codex
 * adapter implements it: the guardian authorizes Claude outside Rome, with
 * the Claude CLI.
 */
export interface ModelAccountAuthorization {
  authorizationState(): ModelAuthorizationState;
  startBrowserAuthorization(): Promise<ModelBrowserAuthorization>;
  startDeviceAuthorization(): Promise<ModelDeviceAuthorization>;
  cancelAuthorization(): Promise<void>;
}
