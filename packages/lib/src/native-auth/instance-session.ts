import type { CloudApi } from "./cloud-api.js";
import type { CredentialVault } from "./credential-vault.js";
import { fetchWithoutRedirect, responseJson } from "./http.js";
import type { CloudInstance, InstanceSession, InstanceSessionCookie } from "./types.js";
import { NativeAuthError } from "./types.js";
import {
  parseInstanceAuthorizationRequest,
  parseInstanceSession,
  parseVisitorAuthorizationRequest,
} from "./validation.js";

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

// The owner signs in as the guardian. Anyone else the Rome's owner shares it
// with signs in as a visitor, through a grant no instance build can take for
// the owner's (docs/adrs/visitor-grant-for-native-visitors.md).
function cookieFor(instance: CloudInstance): InstanceSessionCookie {
  return instance.role === "visitor" ? "rome_visitor" : "rome_session";
}

function isCallback(redirectUri: string, instance: CloudInstance, pathname: string): boolean {
  let callback: URL;
  try {
    callback = new URL(redirectUri);
  } catch {
    return false;
  }
  return (
    callback.origin === instance.origin &&
    callback.pathname === pathname &&
    !callback.search &&
    !callback.hash
  );
}

const NOT_SHARED = "Its owner no longer shares this Rome with you";

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
    if (stored && stored.cookieName === cookieFor(instance) && isFresh(stored, this.now())) {
      await this.cookieStore.install(stored);
      return stored;
    }
    return this.refresh(instance);
  }

  refresh(instance: CloudInstance): Promise<InstanceSession> {
    const active = this.inFlight.get(instance.origin);
    if (active) return active;
    const operation = this.create(instance, true).finally(() => {
      if (this.inFlight.get(instance.origin) === operation) this.inFlight.delete(instance.origin);
    });
    this.inFlight.set(instance.origin, operation);
    return operation;
  }

  private async start(instance: CloudInstance): Promise<NativeStartResponse> {
    const response = await this.post(instance, "/api/auth/cloud/native/start");
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
    if (!isCallback(authorizationRequest.redirect_uri, instance, "/api/auth/cloud/callback")) {
      throw new NativeAuthError("invalid_response", "This Rome returned an invalid callback");
    }
    return { authorizationRequest, origin, expiresAt };
  }

  private async create(instance: CloudInstance, retryComplete: boolean): Promise<InstanceSession> {
    const session =
      instance.role === "visitor"
        ? await this.createVisitor(instance, retryComplete)
        : await this.createOwner(instance, retryComplete);
    if (
      !session ||
      session.origin !== instance.origin ||
      session.cookieName !== cookieFor(instance) ||
      !isFresh(session, this.now())
    ) {
      throw new NativeAuthError("invalid_response", "This Rome returned an invalid session");
    }
    await this.vault.setInstanceSession(session);
    await this.cookieStore.install(session);
    return session;
  }

  private async createOwner(
    instance: CloudInstance,
    retryComplete: boolean,
  ): Promise<InstanceSession | null> {
    const credential = await this.requireCredential();
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
    const response = await this.post(instance, "/api/auth/cloud/native/complete", {
      code: authorization.code,
      state: authorization.state,
      iss: authorization.iss,
    });
    if (response.status === 400 && retryComplete) {
      return this.createOwner(instance, false);
    }
    if (!response.ok) {
      throw new NativeAuthError(
        response.status === 401 ? "session_rejected" : "network",
        "This Rome could not create a session",
      );
    }
    return parseInstanceSession(await responseJson(response));
  }

  /**
   * A dashboard admin's sign-in: the instance asks for a visitor sign-in,
   * Rome Cloud issues the code for this account, and the instance redeems it,
   * checking its own allow-list, for a `rome_visitor` session.
   */
  private async createVisitor(
    instance: CloudInstance,
    retryComplete: boolean,
  ): Promise<InstanceSession | null> {
    const credential = await this.requireCredential();
    const start = await this.post(instance, "/api/auth/visitor/native/start");
    const startBody = await responseJson(start).catch(() => null);
    const startValue =
      typeof startBody === "object" && startBody !== null
        ? (startBody as Record<string, unknown>)
        : null;
    if (start.status === 404 && startValue?.error === "dashboard_not_cloud_email_restricted") {
      throw new NativeAuthError("access_denied", NOT_SHARED);
    }
    // A Rome from before this sign-in has no such route: its edge asks for a
    // session, or its API knows no such path.
    if (start.status === 401 || start.status === 404) {
      throw new NativeAuthError(
        "session_rejected",
        "This Rome needs an update before Native sign-in",
      );
    }
    if (!start.ok) throw new NativeAuthError("network", "This Rome could not start a session");
    const request = parseVisitorAuthorizationRequest(startValue?.visitor_authorization_request);
    if (
      !request ||
      startValue?.origin !== instance.origin ||
      !isCallback(request.redirect_uri, instance, "/api/auth/visitor/callback")
    ) {
      throw new NativeAuthError(
        "invalid_response",
        "This Rome returned an invalid session request",
      );
    }

    const authorization = await this.cloudApi.createVisitorAuthorization(
      instance,
      request,
      credential,
    );
    if (authorization.state !== request.state || authorization.iss !== this.cloudApi.origin) {
      throw new NativeAuthError("invalid_response", "The service authorization did not match");
    }
    const response = await this.post(instance, "/api/auth/visitor/native/complete", {
      state: authorization.state,
      code: authorization.code,
    });
    // A stale attempt, such as the instance restarting between the calls.
    if (response.status === 400 && retryComplete) {
      return this.createVisitor(instance, false);
    }
    if (response.status === 403 || response.status === 404) {
      throw new NativeAuthError("access_denied", NOT_SHARED);
    }
    if (!response.ok) {
      throw new NativeAuthError(
        response.status >= 500 ? "network" : "session_rejected",
        "This Rome could not create a session",
      );
    }
    return parseInstanceSession(await responseJson(response));
  }

  private async requireCredential() {
    const credential = await this.vault.getCloudCredential();
    if (!credential) throw new NativeAuthError("cloud_unauthorized", "Sign in to Rome Cloud first");
    return credential;
  }

  private post(instance: CloudInstance, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    return fetchWithoutRedirect(
      this.fetchImpl,
      new URL(path, instance.origin).toString(),
      {
        method: "POST",
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      instance.origin,
    );
  }
}
