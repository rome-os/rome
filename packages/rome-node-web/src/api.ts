import type {
  AuditContentName,
  AuditContentPreviewResponse,
  AuditItem,
  AuditItemsResponse,
  AuditResult,
  AuditStatsResponse,
  AuditSummaryResponse,
  AuthSession,
  HostSnapshot,
} from "./types";

export interface AuditItemsParams {
  limit?: number;
  beforeSeq?: number;
  since?: number;
  until?: number;
  result?: AuditResult;
  text?: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    let code: string | undefined;
    try {
      const parsed = (await res.json()) as { error?: unknown; code?: unknown } | null;
      if (typeof parsed?.error === "string" && parsed.error) message = parsed.error;
      if (typeof parsed?.code === "string") code = parsed.code;
    } catch {
      // Fall back to status message.
    }
    throw new ApiError(res.status, message, code);
  }
  return (await res.json()) as T;
}

export const api = {
  session: () => requestJson<AuthSession>("/api/auth/session"),
  setup: (newPassword: string) =>
    requestJson<AuthSession>("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ newPassword }),
    }),
  login: (password: string) =>
    requestJson<AuthSession>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  setPassword: (input: { currentPassword?: string; newPassword: string }) =>
    requestJson<AuthSession>("/api/auth/password", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  removePassword: (currentPassword: string) =>
    requestJson<AuthSession>("/api/auth/password", {
      method: "DELETE",
      body: JSON.stringify({ currentPassword }),
    }),
  logout: () => requestJson<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  status: () => requestJson<HostSnapshot>("/api/status"),
  authorize: (input: { cloudUrl: string; name: string }) =>
    requestJson<HostSnapshot>("/api/host/authorize", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  cancelAuthorize: () =>
    requestJson<HostSnapshot>("/api/host/authorize/cancel", { method: "POST" }),
  connect: () => requestJson<HostSnapshot>("/api/host/connect", { method: "POST" }),
  disconnect: () => requestJson<HostSnapshot>("/api/host/disconnect", { method: "POST" }),
  setExecution: (enabled: boolean) =>
    requestJson<HostSnapshot>("/api/host/execution", {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
  clearCredentials: () =>
    requestJson<HostSnapshot>("/api/host/credentials/clear", { method: "POST" }),
  auditSummary: (signal?: AbortSignal) =>
    requestJson<AuditSummaryResponse>("/api/audit/summary", { signal }),
  auditStats: (since: number, until: number, bucketMs: number, signal?: AbortSignal) => {
    const params = new URLSearchParams({
      since: String(since),
      until: String(until),
      bucketMs: String(bucketMs),
    });
    return requestJson<AuditStatsResponse>(`/api/audit/stats?${params.toString()}`, { signal });
  },
  auditItems: (params: AuditItemsParams = {}, signal?: AbortSignal) => {
    const search = new URLSearchParams();
    if (params.limit !== undefined) search.set("limit", String(params.limit));
    if (params.beforeSeq !== undefined) search.set("beforeSeq", String(params.beforeSeq));
    if (params.since !== undefined) search.set("since", String(params.since));
    if (params.until !== undefined) search.set("until", String(params.until));
    if (params.result !== undefined) search.set("result", params.result);
    if (params.text !== undefined) search.set("text", params.text);
    const qs = search.toString();
    return requestJson<AuditItemsResponse>(qs ? `/api/audit/items?${qs}` : "/api/audit/items", {
      signal,
    });
  },
  auditItem: (seq: number, signal?: AbortSignal) =>
    requestJson<{ item: AuditItem }>(`/api/audit/items/${seq}`, { signal }),
  auditContent: (seq: number, name: AuditContentName, maxBytes?: number, signal?: AbortSignal) => {
    const qs = maxBytes !== undefined ? `?maxBytes=${maxBytes}` : "";
    return requestJson<AuditContentPreviewResponse>(
      `/api/audit/items/${seq}/content/${name}${qs}`,
      { signal },
    );
  },
};

export function subscribeEvents(handlers: {
  onStatus: (snapshot: HostSnapshot) => void;
  onError?: () => void;
}): () => void {
  if (typeof EventSource === "undefined") return () => {};
  const source = new EventSource("/api/events");
  source.addEventListener("status", (event) => {
    try {
      const parsed = JSON.parse((event as MessageEvent<string>).data) as {
        snapshot?: HostSnapshot;
      };
      if (parsed.snapshot) handlers.onStatus(parsed.snapshot);
    } catch {
      // Ignore malformed SSE payload.
    }
  });
  source.onerror = () => {
    handlers.onError?.();
  };
  return () => {
    source.close();
  };
}
