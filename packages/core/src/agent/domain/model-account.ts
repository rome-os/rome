// The model provider account: whose subscription the agent's turns run under
// when Rome credits is not the payer (the payer is `ModelFunding` in
// model-port.ts). The guardian authorizes Rome to run models under their
// subscription, by browser or by device code, may cancel an authorization in
// progress, and revokes it.
//
// Rome never acts or chats as this account, so it is not a connection
// (docs/domains/connections.md), and the guardian signing in to Rome is a
// different act, so the port's operations say authorize and revoke. The one
// exception is the status field `loggedIn`, which keeps the name the dashboard
// reads today; renaming it is the application layer's move.
// docs/domains/agents.md carries the language.

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
 * The model provider account as this context reads and changes it. The
 * dashboard and the composition root call it; the agent run never does. The
 * adapter in infrastructure/ implements it on the provider's own process.
 */
export interface ModelAccount {
  status(): Promise<ModelAccountStatus>;
  usage(): Promise<ModelAccountUsage | null>;
  authorizationState(): ModelAuthorizationState;
  startBrowserAuthorization(): Promise<ModelBrowserAuthorization>;
  startDeviceAuthorization(): Promise<ModelDeviceAuthorization>;
  cancelAuthorization(): Promise<void>;
  revoke(): Promise<void>;
  /** Fires when the account's status may have changed; returns the unsubscribe. */
  onChanged(listener: () => void): () => void;
  close(): void;
}
