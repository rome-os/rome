import { clearChatDraft } from "./chat-draft-storage";
import type { DeviceFilesResponse } from "@rome/api-types/devices";
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
  ChatLocations,
  ProjectOption,
  ReasoningEffort,
  RomeSessionsPageResult,
  SkillSummary,
  ThreadSummary,
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
import { randomUUID } from "./random-uuid";

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

/**
 * A non-JSON error body as text the chat can show, or "" for a web page. While
 * Rome restarts, the proxy in front of it answers with its own HTML error page,
 * and its markup is not a message.
 */
export function plainErrorText(raw: string): string {
  const text = raw.trim();
  return text.startsWith("<") ? "" : text.slice(0, 200);
}

/**
 * The statuses a proxy answers with when Rome behind it does not, as during a
 * restart: bad gateway, unavailable, gateway timeout, and Cloudflare's 52x.
 */
export function isUnreachableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530);
}

async function readErrorPayload(res: Response): Promise<unknown> {
  try {
    const raw = (await res.text()).trim();
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      const text = plainErrorText(raw);
      return text ? { error: text } : null;
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

export type SessionScope = "mine" | "all";

export async function listSessions(
  status: SessionStatusFilter = "active",
  scope?: SessionScope,
  signal?: AbortSignal,
): Promise<ChatSession[]> {
  const params = new URLSearchParams();
  if (status !== "active") params.set("status", status);
  if (scope) params.set("scope", scope);
  const query = params.size ? `?${params}` : "";
  const res = await fetch(`/api/chat/sessions${query}`, { credentials: "include", signal });
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

/**
 * What archiving or unarchiving a topic chat does with its follows and open
 * tasks. `followsAndTasks: "stop"` ends them when it is archived; without it
 * they move to the main chat. `follows: "moveBack"` moves the follows its
 * archive moved back to it when it is unarchived; without it they stay.
 */
export interface ArchiveSessionOptions {
  followsAndTasks?: "stop";
  follows?: "moveBack";
}

/** Archive (soft-hide) or unarchive a top-level webchat session. */
export async function archiveSession(
  sessionId: string,
  archived: boolean,
  options: ArchiveSessionOptions = {},
): Promise<ChatSession> {
  const res = await fetch(`/api/chat/sessions/${sessionId}/archive`, {
    method: "PATCH",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify({ archived, ...options }),
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

/** Store the model an open chat runs on from its next turn. "auto" clears it. */
export async function updateSessionModel(
  sessionId: string,
  largeModelSelection: string,
): Promise<ChatSession> {
  const res = await fetch(`/api/chat/sessions/${sessionId}/model`, {
    method: "PATCH",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify({ largeModelSelection }),
  });
  return jsonOrThrow<ChatSession>(res);
}

const inFlightReads = new Map<string, Promise<unknown>>();

/**
 * Callers that ask for the same read while one is in flight share its result.
 * Mounting the chat fires the same read from several components at once, and
 * nothing is cached once it settles, so a later call fetches fresh data.
 */
function shareInFlight<T>(key: string, load: () => Promise<T>): Promise<T> {
  const pending = inFlightReads.get(key) as Promise<T> | undefined;
  if (pending) return pending;
  const run = load().finally(() => {
    if (inFlightReads.get(key) === run) inFlightReads.delete(key);
  });
  inFlightReads.set(key, run);
  return run;
}

export function getSession(sessionId: string): Promise<ChatSession | null> {
  return shareInFlight(`session:${sessionId}`, async () => {
    const res = await fetch(`/api/chat/sessions/${sessionId}`, { credentials: "include" });
    if (res.status === 404) return null;
    return jsonOrThrow<ChatSession>(res);
  });
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

/** One page of a session's history: whole turns, oldest first within the page. */
export interface ChatMessagePage {
  /** Every message of the page. */
  messages: ChatMessage[];
  /**
   * Pass as `before` for the page of older history; null when this page
   * reaches the start. A cursor reads only in the mode that made it.
   */
  nextCursor: string | null;
  /**
   * The session's saved workspace layout, as `GET /layout` returns it. Sent on
   * the first page only (no `before`); `null` when none is saved, absent on
   * older pages.
   */
  layout?: unknown[] | null;
  /**
   * Present when the server paged the chat by its main-line messages
   * (`type=concierge`, docs/domains/chats.md#chat-thread); absent for turn
   * paging.
   */
  concierge?: {
    /** The main line and the newest reply of each thread (every reply, for one thread read by itself): what says where the loaded history stands. The waiting replies and trace rows are not in it. */
    body: ChatMessage[];
    /** When the oldest main-line message of the page was said, in ms; null for an empty page. */
    oldestAt: number | null;
    /** The name of each thread that waits with a root that is not on the page, by root, when it has one. */
    titles: ReadonlyMap<string, string>;
    /** What the page says of each thread with replies, by root: those of its main line, and the ones that wait outside it. */
    threads: ReadonlyMap<string, ThreadSummary>;
  };
}

/** What `GET /messages?type=concierge` answers. */
interface ConciergeWirePage {
  mainLine: {
    message: ChatMessage;
    thread: {
      replyCount: number;
      unreadCount: number;
      latestReply: ChatMessage;
      /** Only in an answer for one thread. */
      replies?: ChatMessage[];
    } | null;
  }[];
  outside: {
    root: string;
    title: string | null;
    replyCount: number;
    unreadCount: number;
    latestUnread: ChatMessage;
  }[];
  /** The trace rows of the turns on the page. */
  traces?: ChatMessage[];
  nextCursor: string | null;
  layout?: unknown[] | null;
}

/** When `message` was said, in ms. */
const saidAt = (message: ChatMessage) => Date.parse(message.createdAt);

/**
 * Reads a Concierge page into the messages the transcript keeps: the main
 * line, the newest reply of each thread (all of them, for one thread read by
 * itself), the one unread reply of each thread that waits outside the page,
 * and the trace rows of their turns. What the page says of each thread comes
 * apart, as its summary.
 */
export function conciergePageOf(wire: ConciergeWirePage): ChatMessagePage {
  const body = wire.mainLine.flatMap(({ message, thread }) => [
    message,
    ...(thread ? (thread.replies ?? [thread.latestReply]) : []),
  ]);
  const times = wire.mainLine.map(({ message }) => saidAt(message));
  const threads = new Map<string, ThreadSummary>();
  for (const { message, thread } of wire.mainLine) {
    if (!thread) continue;
    threads.set(message.id, {
      replyCount: thread.replyCount,
      unreadCount: thread.unreadCount,
      latestReply: thread.latestReply,
      unreadAt: thread.unreadCount > 0 ? saidAt(thread.latestReply) : 0,
    });
  }
  for (const entry of wire.outside) {
    threads.set(entry.root, {
      replyCount: entry.replyCount,
      unreadCount: entry.unreadCount,
      latestReply: entry.latestUnread,
      unreadAt: saidAt(entry.latestUnread),
    });
  }
  const messages = new Map(
    [...body, ...wire.outside.map((entry) => entry.latestUnread), ...(wire.traces ?? [])].map(
      (message) => [message.id, message],
    ),
  );
  return {
    messages: [...messages.values()],
    nextCursor: wire.nextCursor,
    ...(wire.layout === undefined ? {} : { layout: wire.layout }),
    concierge: {
      body,
      oldestAt: times.length > 0 ? Math.min(...times) : null,
      titles: new Map(
        wire.outside.flatMap((entry) => (entry.title ? [[entry.root, entry.title] as const] : [])),
      ),
      threads,
    },
  };
}

/**
 * The newest `limit` turns of a session, or the `limit` turns before `before`.
 * `null` means the session doesn't exist (HTTP 404), as for `listSessionMessages`.
 *
 * With `concierge`, the page is asked for by main-line messages and each
 * brings a summary of its thread. A chat that is not a Concierge chat refuses, and the
 * read is made again by turns, `fallbackLimit` of them, so a caller that does
 * not know the chat yet reads either kind. Which way it was paged is in the
 * page's `concierge`.
 */
export async function listSessionMessagePage(
  sessionId: string,
  options: {
    limit: number;
    before?: string | null;
    /** A message the page must reach, however far back: one read lands on it. */
    through?: string;
    concierge?: { fallbackLimit: number };
  },
): Promise<ChatMessagePage | null> {
  const read = (params: URLSearchParams) =>
    fetch(`/api/chat/sessions/${sessionId}/messages?${params}`, { credentials: "include" });
  const query = (limit: number, concierge: boolean) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (concierge) params.set("type", "concierge");
    if (options.before) params.set("before", options.before);
    if (options.through) params.set("through", options.through);
    return params;
  };
  if (options.concierge) {
    const res = await read(query(options.limit, true));
    if (res.status === 404) return null;
    if (res.ok) return conciergePageOf((await res.json()) as ConciergeWirePage);
    const payload = await readErrorPayload(res);
    const code = payload && typeof payload === "object" && "code" in payload ? payload.code : null;
    if (res.status !== 400 || code !== "not_concierge") {
      throw new ChatApiError(
        payload && typeof payload === "object" && "error" in payload
          ? String(payload.error)
          : `Request failed with status ${res.status}`,
        res.status,
        payload,
      );
    }
    const turns = await read(query(options.concierge.fallbackLimit, false));
    if (turns.status === 404) return null;
    return jsonOrThrow<ChatMessagePage>(turns);
  }
  const res = await read(query(options.limit, false));
  if (res.status === 404) return null;
  return jsonOrThrow<ChatMessagePage>(res);
}

/**
 * One chat thread of a Concierge chat, whole, named by any message of it: its
 * root, every reply, and the trace rows of their turns. `null` means the
 * session doesn't exist (HTTP 404). A thread the chat does not hold comes
 * back with no messages.
 */
export async function listSessionThread(
  sessionId: string,
  key: string,
): Promise<ChatMessagePage | null> {
  const params = new URLSearchParams({ type: "concierge", thread: key });
  const res = await fetch(`/api/chat/sessions/${sessionId}/messages?${params}`, {
    credentials: "include",
  });
  if (res.status === 404) return null;
  return conciergePageOf(await jsonOrThrow<ConciergeWirePage>(res));
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
  /** Defaults to `desc`, which is the useful end of every field the API sorts by. */
  sortDirection?: "asc" | "desc";
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
      sort: { field: options.sort ?? "activity", direction: options.sortDirection ?? "desc" },
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
  // The turn, not the session, carries reasoning effort; a turn that omits it
  // gets the guardian's stored preference.
  reasoningEffort?: ReasoningEffort;
  agentName?: string;
  /** Folder on a rome-node device the chat works in. Core checks it before saving. */
  deviceFolder?: { deviceId: string; path: string };
}

export function listChatAgents(): Promise<AgentCatalogGroup[]> {
  return shareInFlight("agents", async () => {
    const res = await fetch("/api/chat/agents", { credentials: "include" });
    return jsonOrThrow<AgentCatalogGroup[]>(res);
  });
}

export async function listSkills(): Promise<SkillSummary[]> {
  const res = await fetch("/api/skills", { credentials: "include" });
  const data = await jsonOrThrow<{ skills: SkillSummary[] }>(res);
  return data.skills;
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

/** Projects and Cloud's devices for the new-chat location menu. Probes no device. */
export async function listChatLocations(): Promise<ChatLocations> {
  const res = await fetch("/api/chat/locations", { credentials: "include" });
  return jsonOrThrow<ChatLocations>(res);
}

/**
 * Lists one folder on a device; no path means the device user's home. A
 * failure throws `ChatApiError` whose message is a `DeviceFilesErrorCode`.
 */
export async function listDeviceFiles(
  deviceId: string,
  path?: string,
  signal?: AbortSignal,
): Promise<DeviceFilesResponse> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/files${query}`, {
    credentials: "include",
    signal,
  });
  return jsonOrThrow<DeviceFilesResponse>(res);
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

/**
 * Deletes a chat. For a topic chat, `followsAndTasks: "stop"` ends its follows
 * and stops its open tasks; without it they move to the main chat.
 */
/** Fired on `window` once a delete has gone through, with the chat's id as `detail`. */
export const CHAT_SESSION_DELETED_EVENT = "rome:chat-session-deleted";

export async function deleteSession(
  sessionId: string,
  options: { followsAndTasks?: "stop" } = {},
): Promise<void> {
  const query = options.followsAndTasks ? `?followsAndTasks=${options.followsAndTasks}` : "";
  const res = await fetch(`/api/chat/sessions/${sessionId}${query}`, {
    method: "DELETE",
    credentials: "include",
  });
  // A chat that was already gone is gone too, for every list that still shows it.
  if (res.ok || res.status === 404) {
    clearChatDraft(sessionId);
    window.dispatchEvent(new CustomEvent(CHAT_SESSION_DELETED_EVENT, { detail: sessionId }));
  }
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

/** Tells the server the owner has seen the messages `ids` of chat `sessionId`. */
export async function markMessagesRead(
  sessionId: string,
  ids: readonly string[],
): Promise<{ marked: number }> {
  const res = await fetch(`/api/chat/sessions/${sessionId}/messages/read`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  return jsonOrThrow<{ marked: number }>(res);
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
   * Reports the fraction of the attached files' bytes transferred to the
   * server. `null` means the browser did not expose a computable total.
   */
  onUploadProgress?: (progress: number | null) => void;
  /**
   * Aborts the in-flight request. Rejects with an `AbortError`, which callers
   * treat as a user-initiated cancel rather than a transport failure.
   */
  signal?: AbortSignal;
}

export async function listSessionTurns(sessionId: string): Promise<TurnInfo[] | null> {
  const res = await fetch(`/api/chat/sessions/${sessionId}/turns`, { credentials: "include" });
  if (!res.ok) return null;
  return (await res.json()) as TurnInfo[];
}

/** Where a client sends every event a widget fires. A widget is a message of
 *  its own, so `widgetId` is its message's id; core routes the event to the
 *  widget's app, or answers the agent waiting on it. */
export const widgetEventPath = (widgetId: string) =>
  `/api/chat/widgets/${encodeURIComponent(widgetId)}/events`;

/** What core said to an event: whether it took it, its status when not,
 *  whether the event answered the agent waiting on the widget, and a link the
 *  reply asks the client to open. */
export interface WidgetEventOutcome {
  ok: boolean;
  status: number;
  answered?: boolean;
  open?: string;
  /** Why core or the widget's owner refused the event, to show the guardian. */
  error?: string;
}

/** Sends an event a widget fired to core, which decides what it means. `turn`
 *  is the chat's own turn fields, used only when the event starts a turn. */
export async function postWidgetEvent(
  widgetId: string,
  body: { name: string; context?: unknown; turn?: Record<string, unknown> },
): Promise<WidgetEventOutcome> {
  const res = await fetch(widgetEventPath(widgetId), {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, turn: { inputId: randomUUID(), ...body.turn } }),
  });
  const reply = (await res.json().catch(() => null)) as {
    answered?: unknown;
    open?: unknown;
    error?: unknown;
  } | null;
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      ...(typeof reply?.error === "string" ? { error: reply.error } : {}),
    };
  }
  return {
    ok: true,
    status: res.status,
    answered: reply?.answered === true,
    // Core vets the link it sends; the client opens it as given.
    ...(typeof reply?.open === "string" ? { open: reply.open } : {}),
  };
}

export async function postSessionTurnJson(
  sessionId: string,
  body: Record<string, unknown>,
): Promise<PostTurnResult> {
  const res = await fetch(`/api/chat/sessions/${sessionId}/turns`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inputId: randomUUID(), ...body }),
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
      message = plainErrorText(trimmed);
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
  signal?: AbortSignal,
): Promise<PostTurnResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The request was aborted", "AbortError"));
      return;
    }
    // The body is written in entry order, so moving the files to the end puts
    // them in its last `fileBytes`. Progress is then measured over those bytes
    // alone; the text, workspace JSON and part headers sent first do not count
    // as attachment progress.
    const fileEntries = [...body].filter(
      (entry): entry is [string, File] => entry[1] instanceof File,
    );
    for (const name of new Set(fileEntries.map(([name]) => name))) body.delete(name);
    for (const [name, file] of fileEntries) body.append(name, file);
    const fileBytes = fileEntries.reduce((sum, [, file]) => sum + file.size, 0);
    const request = new XMLHttpRequest();
    // Attach upload listeners before open(): despite the spec allowing either
    // order, browsers have historically required this ordering for upload
    // events to fire reliably.
    request.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) {
        onUploadProgress(null);
        return;
      }
      if (fileBytes === 0) {
        onUploadProgress(event.loaded / event.total);
        return;
      }
      const fileStart = event.total - fileBytes;
      onUploadProgress(Math.max(0, Math.min(1, (event.loaded - fileStart) / fileBytes)));
    };
    // The last progress event is not guaranteed to report the exact total.
    // `load` is the browser's authoritative boundary for a fully transferred
    // request body; response processing may continue after it fires.
    request.upload.onload = () => onUploadProgress(1);
    request.open("POST", `/api/chat/sessions/${sessionId}/turns`);
    request.withCredentials = true;
    // One detach point for every terminal path, so a cancelled turn cannot
    // leave a listener pinned to a long-lived controller.
    const abort = () => request.abort();
    const settle = (run: () => void) => {
      signal?.removeEventListener("abort", abort);
      run();
    };
    request.onload = () =>
      settle(() =>
        resolve(
          parseTurnResponseText(
            request.status,
            request.status >= 200 && request.status < 300,
            request.responseText,
          ),
        ),
      );
    request.onerror = () => settle(() => reject(new TypeError("Failed to fetch")));
    request.onabort = () =>
      settle(() => reject(new DOMException("The request was aborted", "AbortError")));
    signal?.addEventListener("abort", abort);
    request.send(body);
  });
}

export async function postSessionTurn(
  sessionId: string,
  body: FormData,
  options: PostSessionTurnOptions = {},
): Promise<PostTurnResult> {
  if (!body.has("inputId")) body.set("inputId", randomUUID());
  if (options.onUploadProgress) {
    return postSessionTurnWithProgress(sessionId, body, options.onUploadProgress, options.signal);
  }
  const res = await fetch(`/api/chat/sessions/${sessionId}/turns`, {
    method: "POST",
    credentials: "include",
    body,
    signal: options.signal,
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
  /** Unique routine key; the route accepts only `chat-routine:<id>` keys
   * (other prefixes belong to apps' managed routines). A repeat create with
   * the same key returns the routine that already holds it, not a duplicate. */
  key?: string;
  /** The chat whose card turns it on. */
  chatId?: string;
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
  const row = (await res.json().catch(() => null)) as { id?: string; error?: string } | null;
  if (res.ok) {
    return { ok: true, status: res.status, routineId: row?.id };
  }
  // 409 on a keyed create: this routine was already created (a retried click,
  // another tab). Treat it as success and hand back the existing id.
  if (res.status === 409 && payload.key !== undefined && row?.id) {
    return { ok: true, status: res.status, routineId: row.id };
  }
  return { ok: false, status: res.status, error: row?.error };
}

/** Identity and state of existing routines, used by the routine card to find
 * the routine it created (so a reload links to it instead of offering to
 * create a duplicate) and to show whether it is paused. */
export interface RoutineRef {
  id: string;
  name: string;
  key: string | null;
  enabled: boolean;
}

/** Null when the list can't be loaded, so a failed fetch never reads as "the
 * routine is gone". */
export async function listRoutineRefs(): Promise<RoutineRef[] | null> {
  const res = await fetch("/api/routines", { credentials: "include" }).catch(() => null);
  if (!res?.ok) return null;
  const rows = (await res.json().catch(() => null)) as Array<Partial<RoutineRef>> | null;
  if (!Array.isArray(rows)) return null;
  return rows.flatMap((r) =>
    typeof r.id === "string"
      ? [{ id: r.id, name: r.name ?? "", key: r.key ?? null, enabled: r.enabled !== false }]
      : [],
  );
}

export interface RoutineMutationResult {
  ok: boolean;
  error?: string;
}

async function routineMutation(
  id: string,
  init: RequestInit,
  fallback: string,
): Promise<RoutineMutationResult> {
  const res = await fetch(`/api/routines/${encodeURIComponent(id)}`, {
    credentials: "include",
    ...init,
  }).catch(() => null);
  if (res?.ok) return { ok: true };
  const payload = (await res?.json().catch(() => null)) as { error?: string } | null;
  return { ok: false, error: payload?.error ?? fallback };
}

export function setRoutineEnabled(id: string, enabled: boolean): Promise<RoutineMutationResult> {
  return routineMutation(
    id,
    { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ enabled }) },
    enabled ? "Couldn't resume the routine." : "Couldn't pause the routine.",
  );
}

export function deleteRoutine(id: string): Promise<RoutineMutationResult> {
  return routineMutation(id, { method: "DELETE" }, "Couldn't delete the routine.");
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
  /** The name the chat showed for its main agent; absent on older shares. */
  agentName?: string;
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
  /** The name the chat shows for its main agent, frozen for the shared page. */
  agentName?: string;
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
