import type {
  AuditContentPreview,
  AuditItem,
  AuditItemsPage,
  AuditResult,
  AuditStats,
  AuthSession,
  ContentName,
  HostSnapshot,
} from "./types";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
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
    try {
      const parsed = (await res.json()) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      // Fall back to status message.
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export const api = {
  session: () => requestJson<AuthSession>("/api/auth/session"),
  login: (token: string) =>
    requestJson<AuthSession>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ token }),
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
  auditStats: (since: number, until: number, bucketMs: number, signal?: AbortSignal) =>
    requestJson<AuditStats>(`/api/audit/stats?since=${since}&until=${until}&bucketMs=${bucketMs}`, {
      signal,
    }),
  auditItems: (
    params: {
      limit?: number;
      beforeSeq?: number;
      result?: AuditResult;
      action?: string;
      text?: string;
      since?: number;
      until?: number;
    },
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.beforeSeq !== undefined) query.set("beforeSeq", String(params.beforeSeq));
    if (params.result) query.set("result", params.result);
    if (params.action) query.set("action", params.action);
    if (params.text) query.set("text", params.text);
    if (params.since !== undefined) query.set("since", String(params.since));
    if (params.until !== undefined) query.set("until", String(params.until));
    return requestJson<AuditItemsPage>(`/api/audit/items?${query.toString()}`, { signal });
  },
  auditItem: (seq: number) => requestJson<AuditItem>(`/api/audit/items/${seq}`),
  async auditContent(seq: number, name: ContentName): Promise<AuditContentPreview | null> {
    const res = await fetch(`/api/audit/items/${seq}/content/${name}`, {
      credentials: "same-origin",
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const totalBytes = Number(res.headers.get("x-content-total-bytes") ?? bytes.byteLength);
    const truncated = res.headers.get("x-content-truncated") === "true";
    return {
      text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
      shownBytes: bytes.byteLength,
      totalBytes,
      truncated,
    };
  },
};

export function subscribeEvents(handlers: {
  onStatus: (snapshot: HostSnapshot) => void;
  onAudit: () => void;
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
  source.addEventListener("audit", () => {
    handlers.onAudit();
  });
  source.onerror = () => {
    handlers.onError?.();
  };
  return () => {
    source.close();
  };
}
