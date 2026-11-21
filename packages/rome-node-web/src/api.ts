import type { AuthSession, HostSnapshot } from "./types";

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
  setup: (input: { token: string; newPassword: string }) =>
    requestJson<AuthSession>("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify(input),
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
