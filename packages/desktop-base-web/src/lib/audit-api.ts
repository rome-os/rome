import type { NodeStats } from "@rome-os/node-ui";

/** The audit window's view of the main process's audit log. Shapes match `@rome-os/node-core`. */

type AuditOutcome = "ok" | "exit_nonzero" | "error" | "interrupted";
export type ContentName = "stdin" | "stdout" | "stderr" | "file";
type AuditStatus =
  | { state: "ok" }
  | {
      state: "unavailable";
      code: "sqlite_missing" | "newer_schema" | "unreadable" | "io";
      message: string;
    };

interface ContentInfo {
  size: number;
  sha256: string;
  storedBytes: number;
}

interface AuditEvent {
  seq: number;
  at: number;
  kind: "host" | "start" | "end" | "prune";
  action: string | null;
  startSeq: number | null;
  outcome: AuditOutcome | null;
  record: Record<string, unknown> & { content?: Partial<Record<ContentName, ContentInfo>> };
}

export interface AuditItem extends AuditEvent {
  end: AuditEvent | null;
}

export interface AuditQuery {
  beforeSeq?: number;
  limit?: number;
  since?: number;
  until?: number;
  action?: string;
  outcome?: AuditOutcome | "no_end";
  text?: string;
  requestsOnly?: boolean;
  result?: "succeeded" | "failed" | "no_result";
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

export interface AuditApi {
  status(): Promise<AuditSummary>;
  list(query?: AuditQuery): Promise<AuditItem[]>;
  get(seq: number): Promise<AuditItem | null>;
  counts(): Promise<Record<"all" | "succeeded" | "failed" | "no_result", number>>;
  stats(since: number, until: number, bucketMs: number): Promise<NodeStats>;
  content(seq: number, name: ContentName): Promise<{ size: number; preview: Uint8Array } | null>;
  reveal(): Promise<void>;
}

/** Present only in the app's own `file:` pages; a browser preview gets null. */
export const auditApi: AuditApi | null =
  (window as unknown as { rome?: { audit?: AuditApi } }).rome?.audit ?? null;
