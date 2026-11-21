export type HostPhase =
  | "unconfigured"
  | "authorizing"
  | "connecting"
  | "online"
  | "retrying"
  | "disconnected"
  | "revoked"
  | "superseded"
  | "error";

export type AuditStatus =
  | { state: "ok" }
  | {
      state: "unavailable";
      code: "sqlite_missing" | "newer_schema" | "unreadable" | "io";
      message: string;
    };

interface PendingAuthorization {
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  expiresAt: number;
}

export interface HostSnapshot {
  phase: HostPhase;
  since: number;
  configured: boolean;
  executionEnabled: boolean;
  autoConnect: boolean;
  cloudUrl: string;
  deviceName: string;
  deviceId: string | null;
  platform: string;
  version: string | null;
  pendingAuth: PendingAuthorization | null;
  lastError: string | null;
  audit: {
    status: AuditStatus;
    bytes: number;
    requests: number;
  };
}

export type PasswordSource = "none" | "file" | "env";

export interface AuthSession {
  authRequired: boolean;
  authenticated: boolean;
  passwordSource: PasswordSource;
}
