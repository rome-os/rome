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

export type AuditUnavailableCode = "sqlite_missing" | "newer_schema" | "unreadable" | "io";

export type AuditStatus =
  | { state: "ok" }
  | {
      state: "unavailable";
      code: AuditUnavailableCode;
      message: string;
    };

export type AuditResult = "succeeded" | "failed" | "no_result";
export type AuditContentName = "stdin" | "stdout" | "stderr" | "file";
export type AuditOutcome = "ok" | "exit_nonzero" | "error" | "interrupted";

export interface AuditContentMeta {
  size: number;
  sha256: string;
  storedBytes: number;
}

export interface AuditSummaryResponse {
  status: AuditStatus;
  bytes: number;
  records: number;
  requests: number;
  oldestAt: number | null;
  newestAt: number | null;
  retention: { maxAgeDays: number; maxBytes: number };
  counts: Record<AuditResult | "all", number> | null;
}

export interface AuditStatsResponse {
  since: number;
  until: number;
  bucketMs: number;
  groups: { peer: null; bucket: number; result: AuditResult; count: number }[];
}

export interface AuditEvent {
  seq: number;
  at: number;
  kind: "start" | "end";
  action: string | null;
  startSeq: number | null;
  outcome: AuditOutcome | null;
  record: Record<string, unknown> & {
    content?: Partial<Record<AuditContentName, AuditContentMeta>>;
    entriesCount?: number;
    recordTruncated?: true;
  };
}

export interface AuditItem extends AuditEvent {
  kind: "start";
  end: AuditEvent | null;
}

export interface AuditItemsResponse {
  items: AuditItem[];
  hasMore: boolean;
}

export interface AuditContentPreviewResponse {
  seq: number;
  name: AuditContentName;
  available: boolean;
  size: number;
  storedBytes: number;
  sha256: string;
  previewBytes: number;
  truncated: boolean;
  isBinary: boolean;
  text: string | null;
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
    status: AuditStatus;
    bytes: number;
    requests: number;
  };
}

export type PasswordSource = "none" | "setup" | "file" | "env";

export interface AuthSetupWindow {
  expired: boolean;
  remainingMs: number;
  expiresAt: string;
}

export interface AuthSession {
  authRequired: boolean;
  authenticated: boolean;
  passwordSource: PasswordSource;
  canRemovePassword?: boolean;
  setup?: AuthSetupWindow;
}
