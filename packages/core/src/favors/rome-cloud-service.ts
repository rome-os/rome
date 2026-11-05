import type { FavorRequiredActionDefinition } from "@rome-os/app-runtime";
import type { ResolvedApp } from "../apps/state.js";
import { cloudBearer } from "../lib/instance-identity.js";
import { getConfiguredInstanceOrigin, getRomeCloudOrigin } from "../lib/rome-cloud-origin.js";
import type { RomeAppViewer } from "../lib/visitor-session.js";
import type {
  FavorActionDispatchClaim,
  FavorActionDispatchResult,
  FavorActionRequestSyncPage,
  FavorActionRequestView,
  FavorBalanceView,
  FavorLedgerPage,
  FavorRechargePackView,
  FavorService,
} from "./types.js";
import { getEmbeddedAppHref } from "../lib/app-routes.js";

const REQUEST_TIMEOUT_MS = 30_000;

export class FavorServiceUnavailableError extends Error {
  constructor(message = "Rome Cloud favors are unavailable for this instance.") {
    super(message);
    this.name = "FavorServiceUnavailableError";
  }
}

export class FavorServiceRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "FavorServiceRequestError";
  }
}

interface ErrorPayload {
  error?: unknown;
  message?: unknown;
}

function requesterAppIdentity(app: ResolvedApp): Record<string, unknown> {
  return {
    appId: app.appId,
    manifestId: app.manifest.id,
    version: app.manifest.version,
    displayName: app.displayName,
    source: app.source,
    installedHash: app.installedHash,
    installedVersion: app.installedVersion,
    firstParty: app.firstParty,
  };
}

export class RomeCloudFavorService implements FavorService {
  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  private async access(): Promise<{ origin: string; token: string }> {
    const token = await cloudBearer();
    const origin = getRomeCloudOrigin();
    if (!token || !origin) throw new FavorServiceUnavailableError();
    return { origin, token };
  }

  private async headers(options?: { json?: boolean }): Promise<Headers> {
    const { token } = await this.access();
    const headers = new Headers({
      Authorization: `Bearer ${token}`,
      "Cache-Control": "no-store",
    });
    if (options?.json) headers.set("Content-Type", "application/json");
    return headers;
  }

  private authorizationUrl(id: string, decision: "pay" | "decline", returnTo?: string): string {
    const origin = getRomeCloudOrigin();
    if (!origin) throw new FavorServiceUnavailableError();
    const url = new URL(`/favors/action-requests/${encodeURIComponent(id)}/authorize`, origin);
    url.searchParams.set("decision", decision);
    const instanceOrigin = getConfiguredInstanceOrigin();
    if (returnTo) {
      url.searchParams.set("return_to", returnTo);
    } else if (instanceOrigin) {
      // Guardian-facing default: back to the dashboard favors page. Visitor
      // (app-payer) flows must pass an explicit returnTo — see
      // visitorReturnUrl() — because visitors cannot access /dashboard.
      url.searchParams.set("return_to", `${instanceOrigin}/dashboard/settings/favors`);
    }
    return url.toString();
  }

  /**
   * Where an app-initiated payer lands after deciding on Rome Cloud.
   *
   * The requesting app may suggest the exact page the favor was requested
   * from (`requested`, an absolute path like `/apps/foo/checkout?x=1`), so
   * the payer returns to where they left off. The suggestion is only honored
   * when it stays on this instance's origin AND inside the requesting app's
   * own page prefix (`/apps/<appId>`), which keeps `return_to` from becoming
   * an app-controlled redirect to arbitrary pages (e.g. the guardian-only
   * dashboard, or another app). Anything else falls back to the app root.
   */
  private visitorReturnUrl(app: ResolvedApp, requested?: string): string | undefined {
    const instanceOrigin = getConfiguredInstanceOrigin();
    if (!instanceOrigin) return undefined;
    const appPrefix = getEmbeddedAppHref(app.appId);
    const fallback = `${instanceOrigin}${appPrefix}`;
    if (typeof requested !== "string" || !requested.startsWith("/") || requested.startsWith("//")) {
      return fallback;
    }
    try {
      const url = new URL(requested, instanceOrigin);
      if (url.origin !== instanceOrigin) return fallback;
      if (url.pathname !== appPrefix && !url.pathname.startsWith(`${appPrefix}/`)) return fallback;
      url.hash = "";
      return url.toString();
    } catch {
      return fallback;
    }
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const { origin } = await this.access();
    const response = await this.fetchImpl(new URL(path, origin), {
      ...init,
      headers: await this.headers({
        json: init.body !== undefined,
      }),
      cache: "no-store",
      signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const data = (await response.json().catch(() => null)) as (T & ErrorPayload) | null;
    if (!response.ok) {
      const message =
        typeof data?.error === "string"
          ? data.error
          : typeof data?.message === "string"
            ? data.message
            : `Favor request failed with status ${response.status}`;
      throw new FavorServiceRequestError(response.status, message);
    }
    if (data === null)
      throw new FavorServiceRequestError(response.status, "Favor response was empty");
    return data as T;
  }

  async getBalance(_viewer?: RomeAppViewer): Promise<FavorBalanceView> {
    return this.json<FavorBalanceView>("/api/favors/balance", {
      method: "GET",
    });
  }

  async listLedger(cursor?: string, _viewer?: RomeAppViewer): Promise<FavorLedgerPage> {
    const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return this.json<FavorLedgerPage>(`/api/favors/ledger${suffix}`, {
      method: "GET",
    });
  }

  async getActionRequest(id: string, _viewer?: RomeAppViewer): Promise<FavorActionRequestView> {
    return this.json<FavorActionRequestView>(
      `/api/favors/action-requests/${encodeURIComponent(id)}`,
      {
        method: "GET",
      },
    );
  }

  async listActionRequests(
    cursor?: string,
    _viewer?: RomeAppViewer,
  ): Promise<FavorActionRequestSyncPage> {
    const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return this.json<FavorActionRequestSyncPage>(`/api/favors/action-requests${suffix}`, {
      method: "GET",
    });
  }

  async syncActionRequests(cursor?: string): Promise<FavorActionRequestSyncPage> {
    const params = new URLSearchParams({ role: "requestor" });
    if (cursor) params.set("cursor", cursor);
    return this.json<FavorActionRequestSyncPage>(`/api/favors/action-requests?${params}`, {
      method: "GET",
    });
  }

  async requestAction(input: {
    app: ResolvedApp;
    viewer: RomeAppViewer;
    actionName: string;
    args: Record<string, unknown>;
    taskRef?: Record<string, unknown>;
    idempotencyKey: string;
    returnTo?: string;
  }): Promise<
    | { status: "queued"; request: FavorActionRequestView }
    | { status: "pending_consent"; request: FavorActionRequestView; authorizationUrl: string }
    | { status: "declined"; request: FavorActionRequestView }
    | { status: "error"; error: string }
  > {
    if (!input.viewer.favorViewerToken) {
      return { status: "error", error: "visitor_favor_auth_required" };
    }

    try {
      const result = await this.json<
        | { status: "queued"; request: FavorActionRequestView }
        | { status: "pending_consent"; request: FavorActionRequestView }
        | { status: "declined"; request: FavorActionRequestView }
        | { status: "failed"; request: FavorActionRequestView }
      >("/api/favors/action-requests", {
        method: "POST",
        body: JSON.stringify({
          requesterAppId: input.app.appId,
          requesterAppIdentity: requesterAppIdentity(input.app),
          actionName: input.actionName,
          args: input.args,
          taskRef: input.taskRef,
          idempotencyKey: input.idempotencyKey,
          payerToken: input.viewer.favorViewerToken,
        }),
      });
      if (result.status === "failed") {
        return { status: "error", error: result.request.failureReason ?? "favor_request_failed" };
      }
      if (result.status === "pending_consent") {
        return {
          ...result,
          // App-initiated payments are approved by visitors, so the
          // authorization page must send them back to the requesting app —
          // never to the guardian-only dashboard default.
          authorizationUrl: this.authorizationUrl(
            result.request.id,
            "pay",
            this.visitorReturnUrl(input.app, input.returnTo),
          ),
        };
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: "error", error: message };
    }
  }

  async resolveActionRequest(
    id: string,
    decision: "pay" | "decline",
    _viewer?: RomeAppViewer,
  ): Promise<{ authorizationUrl: string }> {
    return { authorizationUrl: this.authorizationUrl(id, decision) };
  }

  async claimDispatch(id: string): Promise<FavorActionDispatchClaim> {
    return this.json<FavorActionDispatchClaim>(
      `/api/favors/action-requests/${encodeURIComponent(id)}/claim-dispatch`,
      { method: "POST", body: JSON.stringify({}) },
    );
  }

  async renewDispatchClaim(id: string, claimToken: string): Promise<{ claimExpiresAt: string }> {
    return this.json<{ claimExpiresAt: string }>(
      `/api/favors/action-requests/${encodeURIComponent(id)}/renew-dispatch-claim`,
      { method: "POST", body: JSON.stringify({ claimToken }) },
    );
  }

  async reportDispatchResult(id: string, result: FavorActionDispatchResult): Promise<void> {
    await this.json<{ ok: true }>(
      `/api/favors/action-requests/${encodeURIComponent(id)}/report-dispatch`,
      { method: "POST", body: JSON.stringify(result) },
    );
  }

  async listRechargePacks(_viewer?: RomeAppViewer): Promise<{ packs: FavorRechargePackView[] }> {
    return this.json<{ packs: FavorRechargePackView[] }>("/api/favors/recharge", {
      method: "GET",
    });
  }

  async createRechargeCheckout(packId: string, _viewer?: RomeAppViewer): Promise<{ url: string }> {
    return this.json<{ url: string }>("/api/favors/recharge", {
      method: "POST",
      body: JSON.stringify({ packId }),
    });
  }

  async syncActionRequirements(input: {
    appId: string;
    requesterAppIdentity: Record<string, unknown>;
    definitions: FavorRequiredActionDefinition[];
  }): Promise<{ synced: number }> {
    return this.json<{ synced: number }>("/api/favors/action-requirements/sync", {
      method: "POST",
      body: JSON.stringify({
        requesterAppId: input.appId,
        requesterAppIdentity: input.requesterAppIdentity,
        definitions: input.definitions,
      }),
    });
  }
}

export function favorAppIdentity(app: ResolvedApp): Record<string, unknown> {
  return requesterAppIdentity(app);
}
