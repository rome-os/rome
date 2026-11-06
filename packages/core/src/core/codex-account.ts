// What the dashboard needs from the guardian's Codex account: its sign-in
// state, its usage, and the sign-in and sign-out operations. The API declares
// it here; the Codex adapter in agent/infrastructure/ implements it on the
// shared app-server. The agent run never reads it.

import type { AIToolStatusProbeResult } from "../lib/ai-tool-probes.js";
import type { AIToolUsageStatus } from "../lib/provider-usage.js";

export type CodexLoginMode = "browser" | "device";

export interface CodexLoginState {
  running: boolean;
  mode: CodexLoginMode | null;
  userCode: string | null;
  verificationUrl: string | null;
  lastError: string | null;
}

export interface CodexBrowserLogin {
  loginId: string;
  authUrl: string;
}

export interface CodexDeviceLogin {
  loginId: string;
  userCode: string;
  verificationUrl: string;
}

export interface CodexAccountService {
  getStatus(): Promise<AIToolStatusProbeResult>;
  getUsage(): Promise<AIToolUsageStatus | null>;
  getLoginState(): CodexLoginState;
  startBrowserLogin(): Promise<CodexBrowserLogin>;
  startDeviceLogin(): Promise<CodexDeviceLogin>;
  cancelLogin(): Promise<void>;
  logout(): Promise<void>;
  onAccountChanged(listener: () => void): () => void;
  close(): void;
}
