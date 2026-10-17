import {
  type CloudInstance,
  type CredentialVault,
  fetchWithoutRedirect,
  type InstanceSession,
  type InstanceSessionCoordinator,
  NativeAuthError,
} from "@rome-os/libs/native-auth";

function apiUrl(instance: CloudInstance, path: string): URL {
  if (!path.startsWith("/api/") || path.startsWith("//") || path.includes("\\")) {
    throw new Error("RomeApiClient accepts only relative /api/* paths");
  }
  const url = new URL(path, instance.origin);
  if (url.origin !== instance.origin || !url.pathname.startsWith("/api/")) {
    throw new Error("RomeApiClient path escaped the selected Rome");
  }
  return url;
}

export class RomeApiClient {
  constructor(
    readonly instance: CloudInstance,
    private readonly vault: CredentialVault,
    private readonly coordinator: InstanceSessionCoordinator,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async requestWithSession(
    path: string,
    init: RequestInit,
    session: InstanceSession,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (headers.has("cookie") || headers.has("authorization")) {
      throw new Error("Business callers cannot provide authentication headers");
    }
    headers.set("cookie", `${session.cookieName}=${session.token}`);
    const url = apiUrl(this.instance, path);
    return fetchWithoutRedirect(
      this.fetchImpl,
      url.toString(),
      { ...init, headers, credentials: "omit" },
      this.instance.origin,
    );
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    apiUrl(this.instance, path);
    let session = await this.vault.getInstanceSession(this.instance.origin);
    if (!session || Date.parse(session.expiresAt) <= Date.now()) {
      session = await this.coordinator.refresh(this.instance);
    }
    let response = await this.requestWithSession(path, init, session);
    if (response.status !== 401) return response;
    session = await this.coordinator.refresh(this.instance);
    response = await this.requestWithSession(path, init, session);
    if (response.status === 401) {
      throw new NativeAuthError("session_rejected", "This Rome rejected the refreshed session");
    }
    return response;
  }

  asFetch(): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const raw = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
      const url = new URL(raw);
      if (url.origin !== this.instance.origin) {
        throw new Error("RomeApiClient blocked an unselected origin");
      }
      return this.request(`${url.pathname}${url.search}`, init);
    }) as typeof fetch;
  }
}
