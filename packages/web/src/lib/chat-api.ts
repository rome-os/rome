import type {
  AgentCatalogGroup,
  ApprovalRecord,
  ChatMessage,
  ChatErrorCode,
  ChatErrorProvider,
  ChatErrorReason,
  ChatSearchMessageMatch,
  ChatSession,
  CreateTurnResponse,
  ProjectCatalog,
  ProjectOption,
  ReasoningEffort,
  RomeSessionsPageResult,
  SkillSummary,
  TurnInfo,
} from "./chat-types";
import type {
  RomeSessionDetail,
  RomeSessionType,
  SessionModelFilter,
  SessionMetricsDimension,
  SessionMetricsResponse,
  SessionOwnerFilter,
  SessionQueryScope,
  SessionSourceFilter,
  SessionsMetric,
  SessionsRange,
  SessionsSort,
  RunOutcome,
} from "@rome/api-types/sessions";
import type { TraceSnapshot } from "@rome/api-types/trace-segments";
import type { WidgetPlacement } from "@/pages/free/use-free-cells";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;
const SSE_HEADERS = { Accept: "text/event-stream" } as const;

export class ChatApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "ChatApiError";
    this.status = status;
    this.payload = payload;
  }
}

async function readErrorPayload(res: Response): Promise<unknown> {
  try {
    const raw = (await res.text()).trim();
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return { error: raw.slice(0, 200) };
    }
  } catch {
    return null;
  }
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const payload = await readErrorPayload(res);
    const message =
      (payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error?: unknown }).error ?? "")
        : "") || `Request failed with status ${res.status}`;
    throw new ChatApiError(message, res.status, payload);
  }
  return (await res.json()) as T;
}

export type SessionStatusFilter = "active" | "archived" | "all";

export async function listSessions(status: SessionStatusFilter = "active"): Promise<ChatSession[]> {
  const query = status === "active" ? "" : `?status=${status}`;
  const res = await fetch(`/api/chat/sessions${query}`, { credentials: "include" });
  return jsonOrThrow<ChatSession[]>(res);
}

/** Searches user + assistant message text across all chats (active and
 * archived). Returns one match per session — its most recent matching
 * message — newest first. */
export async function searchChatMessages(query: string): Promise<ChatSearchMessageMatch[]> {
  const res = await fetch(`/api/chat/sessions/search?q=${encodeURIComponent(query)}`, {
    credentials: "include",
  });
  return jsonOrThrow<ChatSearchMessageMatch[]>(res);
}

/** Archive (soft-hide) or unarchive a top-level webchat session. */
export async function archiveSession(sessionId: string, archived: boolean): Promise<ChatSession> {
  const res = await fetch(`/api/chat/sessions/${sessionId}/archive`, {
    method: "PATCH",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify({ archived }),
  });
  return jsonOrThrow<ChatSession>(res);
}

/** Pin or unpin a top-level guardian chat. */
export async function pinSession(sessionId: string, pinned: boolean): Promise<ChatSession> {
  const res = await fetch(`/api/chat/sessions/${sessionId}/pin`, {
    method: "PATCH",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify({ pinned }),
  });
  return jsonOrThrow<ChatSession>(res);
}

/** Rename a top-level webchat session. `name` should be trimmed by the caller;
 * the server also trims, rejects empty, and caps length. */
export async function renameSession(sessionId: string, name: string): Promise<ChatSession> {
  const res = await fetch(`/api/chat/sessions/${sessionId}/name`, {
    method: "PATCH",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  });
  return jsonOrThrow<ChatSession>(res);
}

export async function getSession(sessionId: string): Promise<ChatSession | null> {
  const res = await fetch(`/api/chat/sessions/${sessionId}`, { credentials: "include" });
  if (res.status === 404) return null;
  return jsonOrThrow<ChatSession>(res);
}

/**
 * Returns the message list for a session. `null` is reserved for "session
 * doesn't exist" (HTTP 404) so callers can distinguish a stale URL from a
 * transient failure. Any other non-OK response throws `ChatApiError`.
 */
export async function listSessionMessages(sessionId: string): Promise<ChatMessage[] | null> {
  const res = await fetch(`/api/chat/sessions/${sessionId}/messages`, {
    credentials: "include",
  });
  if (res.status === 404) return null;
  return jsonOrThrow<ChatMessage[]>(res);
}

export interface ListRomeSessionsOptions {
  agentName?: string;
  limit?: number;
  model?: SessionModelFilter;
  offset?: number;
  outcome?: RunOutcome;
  owner?: SessionOwnerFilter;
  projectPathPrefix?: string;
  query?: string;
  range?: SessionsRange;
  sort?: SessionsSort;
  source?: SessionSourceFilter;
  timeZone?: string;
  type?: RomeSessionType;
}

export async function listRomeSessions(
  options: ListRomeSessionsOptions = {},
): Promise<RomeSessionsPageResult> {
  const scope = sessionScope(options);
  const res = await fetch("/api/sessions/query", {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      scope,
      search: options.query?.trim() || undefined,
      sort: { field: options.sort ?? "activity", direction: "desc" },
      page: { offset: options.offset ?? 0, limit: options.limit ?? 50 },
    }),
  });
  return jsonOrThrow<RomeSessionsPageResult>(res);
}

export async function getRomeSession(sessionId: string): Promise<RomeSessionDetail | null> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    credentials: "include",
  });
  if (res.status === 404) return null;
  return jsonOrThrow<RomeSessionDetail>(res);
}

export interface SessionMetricsOptions {
  range: SessionsRange;
  timeZone?: string;
  metric: SessionsMetric;
  trendBy: "app" | "model";
  groupBy: SessionMetricsDimension;
  owner?: SessionOwnerFilter;
  projectPathPrefix?: string;
  type?: RomeSessionType;
  source?: SessionSourceFilter;
  agentName?: string;
  model?: SessionModelFilter;
}

function sessionScope(options: {
  range?: SessionsRange;
  timeZone?: string;
  owner?: SessionOwnerFilter;
  projectPathPrefix?: string;
  type?: RomeSessionType;
  source?: SessionSourceFilter;
  agentName?: string;
  model?: SessionModelFilter;
  outcome?: RunOutcome;
}): SessionQueryScope {
  const range = options.range ?? "7d";
  return {
    time: range === "all" ? { kind: "all" } : { kind: "preset", value: range },
    timeZone: options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    sessions: {
      types: options.type ? [options.type] : undefined,
      owners: options.owner ? [options.owner] : undefined,
      agentNames: options.agentName ? [options.agentName] : undefined,
      projectPathPrefix: options.projectPathPrefix,
      sources: options.source ? [options.source] : undefined,
    },
    runs: {
      models: options.model ? [options.model] : undefined,
      outcomes: options.outcome ? [options.outcome] : undefined,
    },
  };
}

export async function getSessionMetrics(
  options: SessionMetricsOptions,
): Promise<SessionMetricsResponse> {
  const res = await fetch("/api/sessions/metrics", {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      scope: sessionScope(options),
      projections: [
        {
          id: "trend",
          groupBy: options.trendBy,
          interval: "auto",
          rankBy: options.metric,
          limit: 6,
          includeOther: true,
        },
        {
          id: "breakdown",
          groupBy: options.groupBy,
          interval: "none",
          rankBy: "runs",
          limit: 50,
        },
      ],
    }),
  });
  return jsonOrThrow<SessionMetricsResponse>(res);
}

export async function listRomeSessionMessages(sessionId: string): Promise<ChatMessage[] | null> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
    credentials: "include",
  });
  if (res.status === 404) return null;
  return jsonOrThrow<ChatMessage[]>(res);
}

export interface CreateSessionInput {
  name: string;
  personaId?: string;
  projectPath: string;
  largeModelSelection?: string;
  reasoningEffort: ReasoningEffort;
  agentName?: string;
}

export async function listChatAgents(): Promise<AgentCatalogGroup[]> {
  const res = await fetch("/api/chat/agents", { credentials: "include" });
  if (!res.ok) return [];
  return (await res.json()) as AgentCatalogGroup[];
}

export async function listSkills(): Promise<SkillSummary[]> {
  const res = await fetch("/api/skills", { credentials: "include" });
  const data = await jsonOrThrow<{ skills?: SkillSummary[] }>(res);
  return data.skills ?? [];
}

export async function createSession(input: CreateSessionInput): Promise<ChatSession> {
  const res = await fetch("/api/chat/sessions", {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  return jsonOrThrow<ChatSession>(res);
}

export async function updateSessionProject(
  sessionId: string,
  projectPath: string,
): Promise<ChatSession> {
  const res = await fetch(`/api/chat/sessions/${sessionId}/project`, {
    method: "PATCH",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify({ projectPath }),
  });
  return jsonOrThrow<ChatSession>(res);
}

export async function deleteSession(sessionId: string): Promise<void> {
  await fetch(`/api/chat/sessions/${sessionId}`, {
    method: "DELETE",
    credentials: "include",
  });
}

export async function markSessionRead(
  sessionId: string,
): Promise<{ sessionId: string; lastSeenActivityAt: string | null; unread: boolean }> {
  const res = await fetch(`/api/chat/sessions/${sessionId}/read`, {
    method: "POST",
    credentials: "include",
  });
  return jsonOrThrow<{ sessionId: string; lastSeenActivityAt: string | null; unread: boolean }>(
    res,
  );
}

export async function listProjects(): Promise<ProjectCatalog> {
  const res = await fetch("/api/chat/projects", { credentials: "include" });
  return jsonOrThrow<ProjectCatalog>(res);
}

export async function createProject(name: string): Promise<ProjectOption> {
  const res = await fetch("/api/chat/projects", {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  });
  return jsonOrThrow<ProjectOption>(res);
}

export type PostTurnResult =
  | { ok: true; data: CreateTurnResponse }
  | {
      ok: false;
      status: number;
      message: string;
      code?: ChatErrorCode;
      provider?: ChatErrorProvider;
      reason?: ChatErrorReason;
    };

export interface PostSessionTurnOptions {
  /**
   * Reports the fraction of the multipart request body transferred to the
   * server. `null` means the browser did not expose a computable total.
   */
  onUploadProgress?: (progress: number | null) => void;
}

export async function listSessionTurns(sessionId: string): Promise<TurnInfo[] | null> {
  const res = await fetch(`/api/chat/sessions/${sessionId}/turns`, { credentials: "include" });
  if (!res.ok) return null;
  return (await res.json()) as TurnInfo[];
}

export async function postSessionTurnJson(
  sessionId: string,
  body: Record<string, unknown>,
): Promise<PostTurnResult> {
  const res = await fetch(`/api/chat/sessions/${sessionId}/turns`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inputId: crypto.randomUUID(), ...body }),
  });
  return parseTurnResponse(res);
}

function parseTurnResponseText(status: number, ok: boolean, raw: string): PostTurnResult {
  if (ok) {
    try {
      const data = JSON.parse(raw) as CreateTurnResponse;
      return { ok: true, data };
    } catch {
      return { ok: false, status, message: "" };
    }
  }
  let message = "";
  let code: ChatErrorCode | undefined;
  let provider: ChatErrorProvider | undefined;
  let reason: ChatErrorReason | undefined;
  const trimmed = raw.trim();
  if (trimmed) {
    try {
      const payload = JSON.parse(trimmed) as {
        error?: string;
        message?: string;
        code?: ChatErrorCode;
        provider?: ChatErrorProvider;
        reason?: ChatErrorReason;
      };
      message = payload.error ?? payload.message ?? "";
      code = payload.code;
      provider = payload.provider;
      reason = payload.reason;
    } catch {
      message = trimmed.slice(0, 200);
    }
  }
  return {
    ok: false,
    status,
    message,
    ...(code ? { code } : {}),
    ...(provider ? { provider } : {}),
    ...(reason ? { reason } : {}),
  };
}

async function parseTurnResponse(res: Response): Promise<PostTurnResult> {
  const raw = await res.text().catch(() => "");
  return parseTurnResponseText(res.status, res.ok, raw);
}

function postSessionTurnWithProgress(
  sessionId: string,
  body: FormData,
  onUploadProgress: (progress: number | null) => void,
): Promise<PostTurnResult> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    // Attach upload listeners before open(): despite the spec allowing either
    // order, browsers have historically required this ordering for upload
    // events to fire reliably.
    request.upload.onprogress = (event) => {
      onUploadProgress(
        event.lengthComputable && event.total > 0 ? event.loaded / event.total : null,
      );
    };
    // The last progress event is not guaranteed to report the exact total.
    // `load` is the browser's authoritative boundary for a fully transferred
    // request body; response processing may continue after it fires.
    request.upload.onload = () => onUploadProgress(1);
    request.open("POST", `/api/chat/sessions/${sessionId}/turns`);
    request.withCredentials = true;
    request.onload = () => {
      resolve(
        parseTurnResponseText(
          request.status,
          request.status >= 200 && request.status < 300,
          request.responseText,
        ),
      );
    };
    request.onerror = () => reject(new TypeError("Failed to fetch"));
    request.onabort = () => reject(new DOMException("The request was aborted", "AbortError"));
    request.send(body);
  });
}

export async function postSessionTurn(
  sessionId: string,
  body: FormData,
  options: PostSessionTurnOptions = {},
): Promise<PostTurnResult> {
  if (!body.has("inputId")) body.set("inputId", crypto.randomUUID());
  if (options.onUploadProgress) {
    return postSessionTurnWithProgress(sessionId, body, options.onUploadProgress);
  }
  const res = await fetch(`/api/chat/sessions/${sessionId}/turns`, {
    method: "POST",
    credentials: "include",
    body,
  });
  return parseTurnResponse(res);
}

export async function openTurnStream(turnId: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`/api/chat/turns/${turnId}/stream`, {
    method: "GET",
    credentials: "include",
    headers: SSE_HEADERS,
    signal,
  });
}

export async function interruptTurn(turnId: string): Promise<Response> {
  return fetch(`/api/chat/turns/${turnId}/interrupt`, {
    method: "POST",
    credentials: "include",
  });
}

export async function fetchApproval(approvalId: string): Promise<ApprovalRecord | null> {
  const res = await fetch(`/api/approvals/${approvalId}`, { credentials: "include" });
  if (!res.ok) return null;
  return (await res.json()) as ApprovalRecord;
}

export interface ResolveApprovalResult {
  ok: boolean;
  status: number;
  error?: string;
}

export async function resolveApproval(
  approvalId: string,
  intent: "approve" | "reject",
): Promise<ResolveApprovalResult> {
  const res = await fetch(`/api/approvals/${approvalId}/${intent}`, {
    method: "POST",
    credentials: "include",
  });
  if (res.ok || res.status === 409) {
    return { ok: true, status: res.status };
  }
  const payload = (await res.json().catch(() => null)) as { error?: string } | null;
  return { ok: false, status: res.status, error: payload?.error };
}

export interface CreateRoutinePayload {
  name: string;
  trigger: unknown;
  actionName: string;
  args: Record<string, unknown>;
}

export interface CreateRoutineResult {
  ok: boolean;
  status: number;
  routineId?: string;
  error?: string;
}

export async function createRoutine(payload: CreateRoutinePayload): Promise<CreateRoutineResult> {
  const res = await fetch("/api/routines", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, enabled: true }),
  });
  if (res.ok) {
    const row = (await res.json().catch(() => null)) as { id?: string } | null;
    return { ok: true, status: res.status, routineId: row?.id };
  }
  const payloadErr = (await res.json().catch(() => null)) as { error?: string } | null;
  return { ok: false, status: res.status, error: payloadErr?.error };
}

/** Names of existing routines, used by the draft card to detect a routine it
 * already created (so a reload doesn't offer to create a duplicate). */
export async function listRoutineNames(): Promise<string[]> {
  const res = await fetch("/api/routines", { credentials: "include" });
  if (!res.ok) return [];
  const rows = (await res.json().catch(() => [])) as Array<{ name?: string }>;
  return rows.map((r) => r.name ?? "").filter(Boolean);
}

export async function loadSettings(): Promise<Record<string, unknown>> {
  const res = await fetch("/api/settings", { credentials: "include" });
  if (!res.ok) return {};
  return (await res.json()) as Record<string, unknown>;
}

export async function saveSetting(key: string, value: unknown): Promise<boolean> {
  const res = await fetch("/api/settings", {
    method: "PUT",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify({ [key]: value }),
  });
  return res.ok;
}

export interface ChatShareSnapshot {
  mainSessionId: string;
  messages: ChatMessage[];
  traces: Record<string, TraceSnapshot>;
}

export interface SharedChatPayload {
  id: string;
  title: string;
  snapshot: ChatShareSnapshot;
  layout: WidgetPlacement[];
}

export interface ShareSummary {
  id: string;
  title: string;
  url: string;
  createdAt: string;
}

export interface CreateShareInput {
  turnIds: string[];
  title?: string;
  layout?: WidgetPlacement[];
}

export interface CreateShareResult {
  id: string;
  url: string;
  title: string;
}

export async function createShare(
  sessionId: string,
  input: CreateShareInput,
): Promise<CreateShareResult> {
  const res = await fetch(`/api/chat/sessions/${sessionId}/share`, {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  return jsonOrThrow<CreateShareResult>(res);
}

export async function listShares(sessionId: string): Promise<ShareSummary[]> {
  const res = await fetch(`/api/chat/sessions/${sessionId}/shares`, { credentials: "include" });
  return jsonOrThrow<ShareSummary[]>(res);
}

export async function revokeShare(shareId: string): Promise<void> {
  const res = await fetch(`/api/chat/shares/${shareId}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok && res.status !== 404) {
    throw new ChatApiError(`Failed to revoke share (${res.status})`, res.status, null);
  }
}

/** Public read of a shared chat. `null` when the token is missing or revoked. */
export async function fetchSharedChat(token: string): Promise<SharedChatPayload | null> {
  const res = await fetch(`/api/share/${encodeURIComponent(token)}`);
  if (res.status === 404) return null;
  return jsonOrThrow<SharedChatPayload>(res);
}
