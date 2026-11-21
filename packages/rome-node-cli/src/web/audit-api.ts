import { isRecord } from "@rome-os/node-core";
import type {
  AuditItem,
  AuditQuery,
  AuditResult,
  AuditStatus,
  AuditSummary,
  ContentName,
} from "@rome-os/node-core/host";
import { ControllerInputError } from "./host-controller.js";

export const DEFAULT_LIST_LIMIT = 200;
export const MAX_LIST_LIMIT = 200;
export const MAX_TEXT_QUERY_LENGTH = 256;
export const MIN_BUCKET_MS = 60_000;
export const MAX_STATS_BUCKETS = 1000;
export const DEFAULT_CONTENT_PREVIEW_BYTES = 256 * 1024;
export const MAX_CONTENT_PREVIEW_BYTES = 256 * 1024;

const BINARY_PROBE_BYTES = 8192;
const LIST_MAX_STRING_CHARS = 4 * 1024;
const DETAIL_MAX_STRING_CHARS = 64 * 1024;
const MAX_ARGS_ITEMS = 256;
const MAX_ENV_KEYS = 512;

const AUDIT_RATE_WINDOW_MS = 60_000;
const AUDIT_RATE_MAX_REQUESTS = 120;
const AUDIT_RATE_MAX_KEYS = 1024;

const VALID_RESULTS = new Set<AuditResult>(["succeeded", "failed", "no_result"]);
const VALID_CONTENT_NAMES = new Set<ContentName>(["stdin", "stdout", "stderr", "file"]);

export interface ContentMeta {
  size: number;
  sha256: string;
  storedBytes: number;
}

export interface SanitizedAuditSummary {
  status: AuditStatus;
  bytes: number;
  records: number;
  requests: number;
  oldestAt: number | null;
  newestAt: number | null;
  retention: { maxAgeDays: number; maxBytes: number };
  counts: Record<AuditResult | "all", number> | null;
}

export interface SanitizedAuditEvent {
  seq: number;
  at: number;
  kind: "start" | "end";
  action: string | null;
  startSeq: number | null;
  outcome: AuditItem["outcome"];
  record: Record<string, unknown> & {
    content?: Partial<Record<ContentName, ContentMeta>>;
    entriesCount?: number;
    recordTruncated?: true;
  };
}

export interface SanitizedAuditItem extends SanitizedAuditEvent {
  kind: "start";
  end: SanitizedAuditEvent | null;
}

export interface AuditContentPreviewResponse {
  seq: number;
  name: ContentName;
  available: boolean;
  size: number;
  storedBytes: number;
  sha256: string;
  previewBytes: number;
  truncated: boolean;
  isBinary: boolean;
  text: string | null;
}

export interface AuditRateLimiter {
  consume(remoteAddress: string): { allowed: true } | { allowed: false; retryAfterSeconds: number };
}

export function createAuditRateLimiter(now: () => number = () => Date.now()): AuditRateLimiter {
  const buckets = new Map<string, { windowStart: number; count: number }>();

  function prune(currentTime: number): void {
    for (const [key, state] of buckets) {
      if (currentTime - state.windowStart >= AUDIT_RATE_WINDOW_MS) {
        buckets.delete(key);
      }
    }
    while (buckets.size >= AUDIT_RATE_MAX_KEYS) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
  }

  return {
    consume(remoteAddress: string) {
      const key = remoteAddress || "unknown";
      const currentTime = now();
      let state = buckets.get(key);
      if (state && currentTime - state.windowStart >= AUDIT_RATE_WINDOW_MS) {
        buckets.delete(key);
        state = undefined;
      }
      if (!state) {
        prune(currentTime);
        state = { windowStart: currentTime, count: 0 };
        buckets.set(key, state);
      }
      if (state.count >= AUDIT_RATE_MAX_REQUESTS) {
        const remainingMs = AUDIT_RATE_WINDOW_MS - (currentTime - state.windowStart);
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)) };
      }
      state.count += 1;
      return { allowed: true };
    },
  };
}

function parseStrictInt(raw: string | null, name: string): number | undefined {
  if (raw === null || raw === "") return undefined;
  if (!/^-?\d+$/.test(raw)) {
    throw new ControllerInputError(`${name} must be an integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new ControllerInputError(`${name} is out of range.`);
  }
  return value;
}

export function parseAuditSeq(raw: string): number {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new ControllerInputError("seq must be a positive integer.");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ControllerInputError("seq must be a positive integer.");
  }
  return value;
}

export function parseContentName(raw: string): ContentName {
  if (!VALID_CONTENT_NAMES.has(raw as ContentName)) {
    throw new ControllerInputError("Content stream must be one of stdin, stdout, stderr, or file.");
  }
  return raw as ContentName;
}

export function parseMaxPreviewBytes(raw: string | null): number {
  const parsed = parseStrictInt(raw, "maxBytes");
  if (parsed === undefined) return DEFAULT_CONTENT_PREVIEW_BYTES;
  if (parsed < 1 || parsed > MAX_CONTENT_PREVIEW_BYTES) {
    throw new ControllerInputError(`maxBytes must be between 1 and ${MAX_CONTENT_PREVIEW_BYTES}.`);
  }
  return parsed;
}

export function parseAuditStatsParams(searchParams: URLSearchParams): {
  since: number;
  until: number;
  bucketMs: number;
} {
  const since = parseStrictInt(searchParams.get("since"), "since");
  const until = parseStrictInt(searchParams.get("until"), "until");
  const bucketMs = parseStrictInt(searchParams.get("bucketMs"), "bucketMs");
  if (since === undefined || until === undefined || bucketMs === undefined) {
    throw new ControllerInputError("since, until, and bucketMs are required.");
  }
  if (until <= since) {
    throw new ControllerInputError("until must be greater than since.");
  }
  if (bucketMs < MIN_BUCKET_MS) {
    throw new ControllerInputError(`bucketMs must be at least ${MIN_BUCKET_MS}.`);
  }
  const buckets = Math.ceil((until - since) / bucketMs);
  if (buckets > MAX_STATS_BUCKETS) {
    throw new ControllerInputError(`Requested range exceeds ${MAX_STATS_BUCKETS} buckets.`);
  }
  return { since, until, bucketMs };
}

export function parseAuditListParams(searchParams: URLSearchParams): {
  query: AuditQuery;
  limit: number;
} {
  const limitRaw = parseStrictInt(searchParams.get("limit"), "limit");
  const limit = limitRaw ?? DEFAULT_LIST_LIMIT;
  if (limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new ControllerInputError(`limit must be between 1 and ${MAX_LIST_LIMIT}.`);
  }

  const beforeSeq = parseStrictInt(searchParams.get("beforeSeq"), "beforeSeq");
  if (beforeSeq !== undefined && beforeSeq < 1) {
    throw new ControllerInputError("beforeSeq must be a positive integer.");
  }

  const since = parseStrictInt(searchParams.get("since"), "since");
  const until = parseStrictInt(searchParams.get("until"), "until");
  if (since !== undefined && until !== undefined && until < since) {
    throw new ControllerInputError("until must be greater than or equal to since.");
  }

  const resultRaw = searchParams.get("result");
  let result: AuditResult | undefined;
  if (resultRaw !== null && resultRaw !== "") {
    if (!VALID_RESULTS.has(resultRaw as AuditResult)) {
      throw new ControllerInputError("result must be succeeded, failed, or no_result.");
    }
    result = resultRaw as AuditResult;
  }

  const textRaw = searchParams.get("text");
  let text: string | undefined;
  if (textRaw !== null) {
    const trimmed = textRaw.trim();
    if (trimmed.length > MAX_TEXT_QUERY_LENGTH) {
      throw new ControllerInputError(
        `text query must be at most ${MAX_TEXT_QUERY_LENGTH} characters.`,
      );
    }
    if (trimmed.length > 0) text = trimmed;
  }

  return {
    limit,
    query: {
      requestsOnly: true,
      limit: limit + 1,
      ...(beforeSeq !== undefined ? { beforeSeq } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
      ...(result !== undefined ? { result } : {}),
      ...(text !== undefined ? { text } : {}),
    },
  };
}

function sanitizeContentMap(
  raw: unknown,
  allowed: readonly ContentName[],
): Partial<Record<ContentName, ContentMeta>> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Partial<Record<ContentName, ContentMeta>> = {};
  let hasAny = false;
  for (const name of allowed) {
    const entry = raw[name];
    if (!isRecord(entry)) continue;
    if (
      typeof entry.size === "number" &&
      typeof entry.sha256 === "string" &&
      typeof entry.storedBytes === "number"
    ) {
      out[name] = {
        size: entry.size,
        sha256: entry.sha256,
        storedBytes: entry.storedBytes,
      };
      hasAny = true;
    }
  }
  return hasAny ? out : undefined;
}

function capString(value: string, maxChars: number, markTruncated: () => void): string {
  if (value.length <= maxChars) return value;
  markTruncated();
  return `${value.slice(0, maxChars)}…`;
}

function sanitizeArgs(
  action: string | null,
  rawArgs: unknown,
  maxStringChars: number,
  markTruncated: () => void,
): Record<string, unknown> | undefined {
  if (!isRecord(rawArgs)) return undefined;
  if (action === "exec") {
    const out: Record<string, unknown> = {};
    if (typeof rawArgs.command === "string") {
      out.command = capString(rawArgs.command, maxStringChars, markTruncated);
    }
    if (Array.isArray(rawArgs.args)) {
      const capped = rawArgs.args.slice(0, MAX_ARGS_ITEMS);
      if (rawArgs.args.length > MAX_ARGS_ITEMS) markTruncated();
      out.args = capped.map((part) => capString(String(part), maxStringChars, markTruncated));
    }
    if (typeof rawArgs.cwd === "string") {
      out.cwd = capString(rawArgs.cwd, maxStringChars, markTruncated);
    }
    return out;
  }
  if (action === "fs.list") {
    const out: Record<string, unknown> = {};
    if (typeof rawArgs.path === "string") {
      out.path = capString(rawArgs.path, maxStringChars, markTruncated);
    }
    return out;
  }
  if (action === "transfer.open") {
    const out: Record<string, unknown> = {};
    if (rawArgs.direction === "push" || rawArgs.direction === "pull") {
      out.direction = rawArgs.direction;
    }
    if (typeof rawArgs.path === "string") {
      out.path = capString(rawArgs.path, maxStringChars, markTruncated);
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawArgs).slice(0, 32)) {
    if (typeof value === "string") {
      out[key] = capString(value, maxStringChars, markTruncated);
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      out[key] = value;
    }
  }
  return out;
}

export function sanitizeAuditSummary(
  summary: AuditSummary,
  counts: Record<AuditResult | "all", number> | null,
): SanitizedAuditSummary {
  return {
    status: summary.status,
    bytes: summary.bytes,
    records: summary.records,
    requests: summary.requests,
    oldestAt: summary.oldestAt,
    newestAt: summary.newestAt,
    retention: summary.retention,
    counts,
  };
}

export function sanitizeAuditItem(item: AuditItem, mode: "list" | "detail"): SanitizedAuditItem {
  const maxStringChars = mode === "detail" ? DETAIL_MAX_STRING_CHARS : LIST_MAX_STRING_CHARS;
  let truncated = false;
  const markTruncated = () => {
    truncated = true;
  };

  const startRecord: SanitizedAuditEvent["record"] = {};
  if (typeof item.record.requestId === "string") {
    startRecord.requestId = capString(item.record.requestId, 256, markTruncated);
  }
  if (typeof item.record.from === "string") {
    startRecord.from = capString(item.record.from, 256, markTruncated);
  }
  if (typeof item.record.transport === "string") {
    startRecord.transport = item.record.transport;
  }
  const args = sanitizeArgs(item.action, item.record.args, maxStringChars, markTruncated);
  if (args) startRecord.args = args;
  if (Array.isArray(item.record.envKeys)) {
    const keys = item.record.envKeys.slice(0, MAX_ENV_KEYS).map((k) => String(k));
    if (item.record.envKeys.length > MAX_ENV_KEYS) markTruncated();
    startRecord.envKeys = keys;
  }
  const startContent = sanitizeContentMap(item.record.content, ["stdin"]);
  if (startContent) startRecord.content = startContent;
  if (truncated) startRecord.recordTruncated = true;

  let sanitizedEnd: SanitizedAuditEvent | null = null;
  if (item.end) {
    const endRaw = item.end.record;
    const endRecord: SanitizedAuditEvent["record"] = {};
    if (typeof endRaw.durationMs === "number") endRecord.durationMs = endRaw.durationMs;
    if (typeof endRaw.exitCode === "number") endRecord.exitCode = endRaw.exitCode;
    if (typeof endRaw.signal === "string") endRecord.signal = endRaw.signal;
    if (typeof endRaw.errorCode === "string") endRecord.errorCode = endRaw.errorCode;
    if (typeof endRaw.pid === "number") endRecord.pid = endRaw.pid;
    if (typeof endRaw.bytes === "number") endRecord.bytes = endRaw.bytes;
    if (typeof endRaw.sha256 === "string") endRecord.sha256 = endRaw.sha256;
    if (typeof endRaw.ackedBytes === "number") endRecord.ackedBytes = endRaw.ackedBytes;
    if (typeof endRaw.replyBytes === "number") endRecord.replyBytes = endRaw.replyBytes;
    if (typeof endRaw.path === "string") {
      endRecord.path = capString(endRaw.path, maxStringChars, markTruncated);
    }
    if (typeof endRaw.truncated === "boolean") endRecord.truncated = endRaw.truncated;
    if (endRaw.replaced !== undefined) {
      if (isRecord(endRaw.replaced) && typeof endRaw.replaced.size === "number") {
        endRecord.replaced = { size: endRaw.replaced.size };
      } else if (endRaw.replaced === null || typeof endRaw.replaced === "boolean") {
        endRecord.replaced = endRaw.replaced;
      }
    }
    if (Array.isArray(endRaw.entries)) {
      endRecord.entriesCount = endRaw.entries.length;
    }
    const endContent = sanitizeContentMap(endRaw.content, ["stdout", "stderr", "file"]);
    if (endContent) endRecord.content = endContent;

    sanitizedEnd = {
      seq: item.end.seq,
      at: item.end.at,
      kind: "end",
      action: item.end.action,
      startSeq: item.end.startSeq,
      outcome: item.end.outcome,
      record: endRecord,
    };
  }

  return {
    seq: item.seq,
    at: item.at,
    kind: "start",
    action: item.action,
    startSeq: item.startSeq,
    outcome: item.outcome,
    record: startRecord,
    end: sanitizedEnd,
  };
}

export function getContentMeta(
  item: AuditItem,
  name: ContentName,
): { ownerSeq: number; meta: ContentMeta } | null {
  const owner = name === "stdin" ? item : item.end;
  if (!owner || !isRecord(owner.record.content)) return null;
  const entry = owner.record.content[name];
  if (
    !isRecord(entry) ||
    typeof entry.size !== "number" ||
    typeof entry.sha256 !== "string" ||
    typeof entry.storedBytes !== "number"
  ) {
    return null;
  }
  return {
    ownerSeq: owner.seq,
    meta: {
      size: entry.size,
      sha256: entry.sha256,
      storedBytes: entry.storedBytes,
    },
  };
}

function trimIncompleteUtf8Tail(buffer: Buffer): Buffer {
  const len = buffer.byteLength;
  if (len === 0) return buffer;
  let i = len - 1;
  const minIndex = Math.max(0, len - 4);
  while (i > minIndex && (buffer[i]! & 0xc0) === 0x80) {
    i -= 1;
  }
  const lead = buffer[i]!;
  if ((lead & 0x80) === 0) return buffer;
  let expected = 0;
  if ((lead & 0xe0) === 0xc0) expected = 2;
  else if ((lead & 0xf0) === 0xe0) expected = 3;
  else if ((lead & 0xf8) === 0xf0) expected = 4;
  else return buffer;
  if (len - i < expected) {
    return buffer.subarray(0, i);
  }
  return buffer;
}

export function decodeContentPreview(
  preview: Buffer,
  truncated: boolean,
): { isBinary: boolean; text: string | null; previewBytes: number } {
  const probeLen = Math.min(preview.byteLength, BINARY_PROBE_BYTES);
  if (preview.subarray(0, probeLen).includes(0)) {
    return {
      isBinary: true,
      text: null,
      previewBytes: preview.byteLength,
    };
  }
  const safeSlice = truncated ? trimIncompleteUtf8Tail(preview) : preview;
  return {
    isBinary: false,
    text: safeSlice.toString("utf8"),
    previewBytes: safeSlice.byteLength,
  };
}
