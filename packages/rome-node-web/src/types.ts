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

export type AuditResult = "succeeded" | "failed" | "no_result";
export type ContentName = "stdin" | "stdout" | "stderr" | "file";

type AuditStatus =
  | { state: "ok" }
  | {
      state: "unavailable";
      code: "sqlite_missing" | "newer_schema" | "unreadable" | "io";
      message: string;
    };

interface AuditEvent {
  seq: number;
  at: number;
  kind: "host" | "start" | "end" | "prune";
  action: string | null;
  startSeq: number | null;
  outcome: "ok" | "exit_nonzero" | "error" | "interrupted" | null;
  record: Record<string, unknown>;
}

export interface AuditItem extends AuditEvent {
  end: AuditEvent | null;
}

export interface AuditSummary {
  path: string;
  status: AuditStatus;
  bytes: number;
  records: number;
  requests: number;
  oldestAt: number | null;
  newestAt: number | null;
  lastPrune: AuditEvent | null;
  retention: { maxAgeDays: number; maxBytes: number };
}

export interface AuditStats {
  since: number;
  until: number;
  bucketMs: number;
  groups: { peer: null; bucket: number; result: AuditResult; count: number }[];
}

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
    summary: AuditSummary;
    counts: Record<AuditResult | "all", number> | null;
  };
}

export interface AuthSession {
  authRequired: boolean;
  authenticated: boolean;
}

export interface AuditItemsPage {
  items: AuditItem[];
  hasMore: boolean;
}

export interface AuditContentPreview {
  text: string;
  shownBytes: number;
  totalBytes: number;
  truncated: boolean;
}
