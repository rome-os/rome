import type { CloudApi } from "./cloud-api.js";
import type { CredentialVault } from "./credential-vault.js";
import { fetchWithoutRedirect, responseJson } from "./http.js";
import type { CloudInstance, InstanceSession } from "./types.js";
import { NativeAuthError } from "./types.js";
import { parseInstanceAuthorizationRequest, parseInstanceSession } from "./validation.js";

/**
 * Where a host puts the instance session so its web view sends it: a WebView
 * cookie jar on mobile, an Electron session on desktop.
 */
export interface SessionCookieStore {
  install(session: InstanceSession): Promise<void>;
}

interface NativeStartResponse {
  authorizationRequest: NonNullable<ReturnType<typeof parseInstanceAuthorizationRequest>>;
  origin: string;
  expiresAt: string;
}

function isFresh(session: InstanceSession, now: number): boolean {
  return Date.parse(session.expiresAt) > now + 30_000;
}

export class InstanceSessionCoordinator {
  private readonly inFlight = new Map<string, Promise<InstanceSession>>();

  constructor(
    private readonly cloudApi: CloudApi,
    private readonly vault: CredentialVault,
    private readonly cookieStore: SessionCookieStore,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async restore(instance: CloudInstance): Promise<InstanceSession> {
    const stored = await this.vault.getInstanceSession(instance.origin);
    if (stored && isFresh(stored, this.now())) {
      await this.cookieStore.install(stored);
      return stored;
    }
    return this.refresh(instance);
  }

  refresh(instance: CloudInstance): Promise<InstanceSession> {
    const active = this.inFlight.get(instance.origin);
    if (active) return active;
    const operation = this.create(instance).finally(() => {
      if (this.inFlight.get(instance.origin) === operation) this.inFlight.delete(instance.origin);
    });
    this.inFlight.set(instance.origin, operation);
    return operation;
  }

  private async start(instance: CloudInstance): Promise<NativeStartResponse> {
    const response = await fetchWithoutRedirect(
      this.fetchImpl,
      new URL("/api/auth/cloud/native/start", instance.origin).toString(),
      { method: "POST", headers: { accept: "application/json" } },
      instance.origin,
    );
    if (response.status === 404) {
      throw new NativeAuthError(
        "session_rejected",
        "This Rome needs an update before Native sign-in",
      );
    }
    if (response.status === 409) {
      throw new NativeAuthError("session_rejected", "This Rome is not enrolled for Native sign-in");
    }
    if (!response.ok) throw new NativeAuthError("network", "This Rome could not start a session");
    const body = await responseJson(response);
    const value =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
    const authorizationRequest = parseInstanceAuthorizationRequest(value?.authorization_request);
    const origin = typeof value?.origin === "string" ? value.origin : null;
    const expiresAt = typeof value?.expires_at === "string" ? value.expires_at : null;
    if (!authorizationRequest || origin !== instance.origin || !expiresAt) {
      throw new NativeAuthError(
        "invalid_response",
        "This Rome returned an invalid session request",
      );
    }
    const callback = new URL(authorizationRequest.redirect_uri);
    if (
      callback.origin !== instance.origin ||
      callback.pathname !== "/api/auth/cloud/callback" ||
      callback.search ||
      callback.hash
    ) {
      throw new NativeAuthError("invalid_response", "This Rome returned an invalid callback");
    }
    return { authorizationRequest, origin, expiresAt };
  }

  private async create(instance: CloudInstance, retryComplete = true): Promise<InstanceSession> {
    const credential = await this.vault.getCloudCredential();
    if (!credential) throw new NativeAuthError("cloud_unauthorized", "Sign in to Rome Cloud first");
    const start = await this.start(instance);
    const authorization = await this.cloudApi.createInstanceAuthorization(
      instance,
      start.authorizationRequest,
      credential,
    );
    if (
      authorization.state !== start.authorizationRequest.state ||
      authorization.iss !== this.cloudApi.origin
    ) {
      throw new NativeAuthError("invalid_response", "The service authorization did not match");
    }
    const response = await fetchWithoutRedirect(
      this.fetchImpl,
      new URL("/api/auth/cloud/native/complete", instance.origin).toString(),
      {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          code: authorization.code,
          state: authorization.state,
          iss: authorization.iss,
        }),
      },
      instance.origin,
    );
    if (response.status === 400 && retryComplete) {
      return this.create(instance, false);
    }
    if (!response.ok) {
      throw new NativeAuthError(
        response.status === 401 ? "session_rejected" : "network",
        "This Rome could not create a session",
      );
    }
    const session = parseInstanceSession(await responseJson(response));
    if (!session || session.origin !== instance.origin || !isFresh(session, this.now())) {
      throw new NativeAuthError("invalid_response", "This Rome returned an invalid session");
    }
    await this.vault.setInstanceSession(session);
    await this.cookieStore.install(session);
    return session;
  }
}
