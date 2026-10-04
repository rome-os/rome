import type { RomeAppApiHandler, RomeAppApiRequest, RomeAppContext } from "@rome-os/app-runtime";
import {
  ComposioClient,
  isComposioAuthenticationError,
  isComposioNotFoundError,
} from "./composio-client.js";
import {
  ensureComposioWebhookRegistered,
  RelayWebhookUnavailableError,
} from "./composio-webhook.js";
import {
  CliLoginError,
  completeCliLogin,
  logoutCliSession,
  readSessionApiKey,
  startCliLogin,
} from "./composio-login.js";
import { buildCallbackResponse } from "./callback-response.js";
import { type ConnectOrigin, CsrfStore, randomToken } from "./csrf.js";
import { EventsRepo, EMITTED_EVENTS_RING_CAP } from "./events-repo.js";
import {
  GITHUB_DELIVERY_HEADER,
  GITHUB_EVENT_HEADER,
  GITHUB_PING_EVENT,
  GITHUB_SIGNATURE_HEADER,
  verifyGithubSignature,
} from "./github-webhook.js";
import {
  processGithubWebhook,
  processVerifiedWebhook,
  publishEmittedEvent,
} from "./process-webhook.js";
import { resolveRelayDepositUrl } from "./relay-webhook.js";
import { SettingsStore } from "./settings-store.js";
import { buildTopic } from "./topic.js";
import {
  isRomeManagedToolkit,
  isSupportedToolkit,
  romeManagedConnectHint,
  unsupportedToolkitHint,
  ROME_USER_ID,
  subscribeTriggerFeed,
} from "../shared.js";

const APP_ID = "connector";
const EVENTS_DEFAULT_LIMIT = 100;
const EVENTS_MAX_LIMIT = EMITTED_EVENTS_RING_CAP;

// `composio login --key` blocks until the guardian authorizes in their browser.
// Bound the wait so a stalled session doesn't hang the request forever — a
// timeout surfaces as "not authorized yet, retry". The dashboard auto-fires
// completion right after opening the auth tab, so the normal path (authorize in
// the tab) returns in a second or two.
const LOGIN_COMPLETE_TIMEOUT_MS = 60_000;

// The active `login/complete` run, so `login/cancel` (and a superseding
// `login/start`) can abort it. A fresh handler instance is built per request,
// so this must live at module scope to span the start → complete → cancel
// requests. Keyed by `cliKey` so a stale/`keepalive` cancel from an old tab or
// unmount only aborts the run it was issued for — never a newer sign-in that
// has since taken the slot. Single guardian → at most one in flight.
let activeLogin: { cliKey: string; controller: AbortController } | null = null;

// AppApiDispatcher constructs a fresh handler per request, so any state on the
// handler instance is discarded between PUT (handleStartConnector) and CONSUME
// (handleCallback). The OAuth round-trip lives in the user's browser, not in
// the same request, so the CSRF token must survive across requests — hoist
// the store to module scope so it sits in the cached ESM module instead.
const csrfStore = new CsrfStore();

function rawHeader(headers: Record<string, string>, key: string): string | undefined {
  const value = headers[key];
  if (value) return value;
  const lower = key.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k];
  }
  return undefined;
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: code, message }, { status });
}

function authenticationError(): Response {
  return jsonError(
    401,
    "composio_unauthenticated",
    "Composio authorization is no longer valid. Sign in again.",
  );
}

function trimToUndef(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function parseJsonBody<T>(body: Uint8Array | undefined): T | null {
  if (!body || body.byteLength === 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(body)) as T;
  } catch {
    return null;
  }
}

interface ConnectorBody {
  provider?: string;
  callbackUrl?: string;
  origin?: string;
}

interface FeedBody {
  triggerSlug?: string;
  connectedAccountId?: string;
  config?: Record<string, unknown>;
}

class ComposioApiHandler implements RomeAppApiHandler {
  private readonly settings: SettingsStore;
  private readonly events: EventsRepo;
  private readonly csrf: CsrfStore = csrfStore;

  constructor(private readonly ctx: RomeAppContext) {
    this.settings = new SettingsStore(ctx.db);
    this.events = new EventsRepo(ctx.db);
  }

  async handle(request: RomeAppApiRequest): Promise<Response> {
    const path = request.path.join("/");
    const method = request.method.toUpperCase();

    try {
      if (method === "GET" && (path === "" || path === "status")) {
        return await this.handleStatus();
      }
      if (method === "POST" && path === "login/start") return await this.handleLoginStart();
      if (method === "POST" && path === "login/complete") {
        return await this.handleLoginComplete(request);
      }
      if (method === "POST" && path === "login/cancel") return this.handleLoginCancel(request);
      if (method === "POST" && path === "logout") return await this.handleLogout();
      if (method === "POST" && path === "webhook/register")
        return await this.handleRegisterWebhook();
      if (method === "POST" && path === "connectors") {
        return await this.handleStartConnector(request);
      }
      if (method === "GET" && path === "callback") {
        return await this.handleCallback(request);
      }
      if (method === "GET" && path === "connectors") {
        return await this.handleListConnectors();
      }
      if (method === "DELETE" && request.path[0] === "connectors" && request.path.length === 2) {
        return await this.handleDisconnectConnector(request.path[1]);
      }
      if (method === "POST" && path === "feeds") {
        return await this.handleCreateFeed(request);
      }
      if (method === "GET" && path === "feeds") {
        return await this.handleListFeeds();
      }
      if (method === "DELETE" && request.path[0] === "feeds" && request.path.length === 2) {
        return await this.handleDeleteFeed(request.path[1]);
      }
      if (method === "GET" && path === "events") {
        return await this.handleListEvents(request);
      }
      if (method === "POST" && path === "webhook") {
        return await this.handleWebhook(request);
      }

      return jsonError(404, "not_found", `Unknown route: ${method} /${path}`);
    } catch (err) {
      if (isComposioAuthenticationError(err)) return authenticationError();
      this.ctx.log.error("composio api error", {
        method,
        path,
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonError(500, "internal_error", err instanceof Error ? err.message : "unknown error");
    }
  }

  private async loadClient(): Promise<ComposioClient | null> {
    const apiKey = await readSessionApiKey();
    if (!apiKey) return null;
    return new ComposioClient({ apiKey });
  }

  // Local reads only — the dashboard blocks its first paint on this response,
  // so it must never make a Composio round trip. Key health is asserted where
  // the key is exercised (finalizeLogin pings; connect/list surface auth
  // failures per request).
  private async handleStatus(): Promise<Response> {
    const [apiKey, webhookSecret, webhookEndpointId, relayDepositUrl] = await Promise.all([
      readSessionApiKey(),
      this.settings.get("webhookSecret"),
      this.settings.get("webhookEndpointId"),
      resolveRelayDepositUrl(this.ctx.repositories.settings),
    ]);
    return Response.json({
      appId: APP_ID,
      version: this.ctx.app.version,
      hasKey: Boolean(apiKey),
      webhookRegistered: Boolean(webhookSecret && webhookEndpointId),
      relayConfigured: Boolean(relayDepositUrl),
    });
  }

  /**
   * Start a fresh browser login. The dashboard treats logging in to Composio as
   * one explicit action ("Log in with Composio" / "Re-authorize"), so this stays
   * dumb: always log out any existing session first (the CLI short-circuits
   * `login` while a session is active and would issue no new URL), then hand back
   * the authorization URL plus an opaque `cliKey` the dashboard passes to
   * `POST /login/complete` once the guardian authorizes.
   */
  private async handleLoginStart(): Promise<Response> {
    try {
      // A fresh login supersedes any prior one still blocking on `--key`; abort
      // it so it can't persist a key for the session being replaced.
      activeLogin?.controller.abort();
      activeLogin = null;
      await logoutCliSession();
      const session = await startCliLogin();
      return Response.json({
        loginUrl: session.loginUrl,
        cliKey: session.cliKey,
      });
    } catch (err) {
      return this.mapLoginError(err);
    }
  }

  /**
   * Step 2 of CLI-driven login: complete the authorized session (which persists
   * the issued key into the CLI session — our source of truth), then validate it
   * and re-register the webhook. The guardian must have authorized in
   * the opened tab first — otherwise the CLI blocks and we time out with a
   * `not_authorized` 409 telling them to retry.
   */
  private async handleLoginComplete(request: RomeAppApiRequest): Promise<Response> {
    const body = parseJsonBody<{ cliKey?: string }>(request.body);
    const cliKey = body?.cliKey?.trim();
    if (!cliKey) return jsonError(400, "missing_cli_key", "cliKey is required");
    // The cliKey is spawned as a `composio login --key` argument (array args, no
    // shell — so not an injection vector), but reject anything that isn't the
    // expected opaque token shape to fail fast with a clear error.
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(cliKey)) {
      return jsonError(400, "invalid_cli_key", "cliKey has an unexpected format");
    }

    // Register this run so `login/cancel` can abort it. The `attempt` guard on
    // the client only discards a superseded response; the abort is what stops
    // the server from persisting a key the guardian canceled. Keep it live
    // through persistence — a cancel that lands after the CLI returns but before
    // the settings write must still win — and only clear it once we're done.
    const controller = new AbortController();
    activeLogin?.controller.abort();
    activeLogin = { cliKey, controller };
    try {
      let apiKey: string;
      try {
        apiKey = await completeCliLogin(cliKey, LOGIN_COMPLETE_TIMEOUT_MS, controller.signal);
      } catch (err) {
        return this.mapLoginError(err);
      }
      return await this.finalizeLogin(apiKey, controller.signal);
    } finally {
      if (activeLogin?.controller === controller) activeLogin = null;
    }
  }

  /**
   * Cancel an in-flight browser login: abort the blocking `login --key` run so it
   * exits before reading/persisting a key. Scoped to `cliKey` — a stale cancel
   * (old tab, unmount, or a `keepalive` request that lands late) is ignored
   * unless it names the run currently in flight, so it can't kill a newer
   * sign-in. Idempotent: a no-match or nothing-in-flight just reports ok.
   */
  private handleLoginCancel(request: RomeAppApiRequest): Response {
    const cliKey = parseJsonBody<{ cliKey?: string }>(request.body)?.cliKey?.trim();
    if (cliKey && activeLogin?.cliKey === cliKey) {
      activeLogin.controller.abort();
      activeLogin = null;
    }
    return Response.json({ ok: true });
  }

  /**
   * Finalize a completed CLI login: validate the issued key (ping a low-cost
   * authenticated endpoint), then refresh the project-level webhook. The key
   * itself is NOT stored — `completeCliLogin` already persisted it into the CLI
   * session, which is the single source of truth the app reads live everywhere.
   */
  private async finalizeLogin(apiKey: string, signal?: AbortSignal): Promise<Response> {
    const client = new ComposioClient({ apiKey });
    const ping = await client.ping();
    if (!ping.ok) {
      if (ping.status === 401) return authenticationError();
      return jsonError(502, "composio_unavailable", ping.message);
    }

    // A new Composio project cannot use signing material from the previous one.
    // Drop it before upserting so a failed recovery never leaves the dashboard
    // reporting a webhook that only belongs to the old project.
    const endpointId = await this.settings.get("webhookEndpointId");
    const belongsToCurrentProject = endpointId
      ? await client.webhookSubscriptionExists(endpointId)
      : false;

    // The CLI session has already accepted the key. Do not let a canceled UI
    // interaction make any later webhook writes after that point.
    if (signal?.aborted) {
      return jsonError(409, "login_canceled", "Composio login was canceled.");
    }
    if (endpointId && !belongsToCurrentProject) {
      await this.settings.delete("webhookSecret");
      await this.settings.delete("webhookEndpointId");
    }

    // Re-register on every successful login rather than only when local state
    // is absent. The upsert repairs a new Composio project, an endpoint deleted
    // upstream, a changed relay mailbox address, or a rotated signing secret.
    // Only credential rejection makes login fail. Other webhook failures leave
    // tool access usable and can be retried through the registration button.
    try {
      await this.ensureWebhookRegistered(client);
    } catch (err) {
      if (isComposioAuthenticationError(err)) return authenticationError();
      this.ctx.log.warn("login: webhook registration failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return Response.json({ ok: true });
  }

  private mapLoginError(err: unknown): Response {
    if (err instanceof CliLoginError) {
      const status =
        err.code === "not_authorized" || err.code === "canceled"
          ? 409
          : err.code === "spawn_failed"
            ? 500
            : 502;
      return jsonError(status, `login_${err.code}`, err.message);
    }
    this.ctx.log.error("composio cli login error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonError(
      500,
      "login_error",
      "Login failed unexpectedly. Check the server logs for details.",
    );
  }

  /**
   * Sign out of Composio: tear down the project webhook endpoint while a usable
   * key is still on hand, then drop the app-owned webhook state and clear the
   * CLI session (the credential) so the next "Sign in" starts from a clean
   * slate. Idempotent — safe to call when nothing is stored.
   */
  private async handleLogout(): Promise<Response> {
    const client = await this.loadClient();
    const endpointId = await this.settings.get("webhookEndpointId");
    if (client && endpointId) {
      try {
        await client.deleteWebhookEndpoint(endpointId);
      } catch (err) {
        if (!isComposioNotFoundError(err)) {
          this.ctx.log.warn("logout: webhook endpoint delete failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    await this.settings.delete("webhookSecret");
    await this.settings.delete("webhookEndpointId");
    try {
      await logoutCliSession();
    } catch (err) {
      this.ctx.log.warn("logout: cli session logout failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return Response.json({ ok: true });
  }

  private async ensureWebhookRegistered(client: ComposioClient): Promise<{ webhookUrl: string }> {
    return ensureComposioWebhookRegistered({
      client,
      appSettings: this.settings,
      settings: this.ctx.repositories.settings,
    });
  }

  private webhookRegistrationError(err: unknown): Response {
    if (isComposioAuthenticationError(err)) return authenticationError();
    const message = err instanceof Error ? err.message : String(err);
    return jsonError(
      err instanceof RelayWebhookUnavailableError ? 409 : 502,
      "webhook_registration_failed",
      message,
    );
  }

  private async handleRegisterWebhook(): Promise<Response> {
    const client = await this.loadClient();
    if (!client) return jsonError(409, "no_api_key", "Log in to Composio first");
    try {
      const { webhookUrl } = await this.ensureWebhookRegistered(client);
      return Response.json({ ok: true, webhookUrl });
    } catch (err) {
      return this.webhookRegistrationError(err);
    }
  }

  private async handleStartConnector(request: RomeAppApiRequest): Promise<Response> {
    const body = parseJsonBody<ConnectorBody>(request.body);
    const provider = body?.provider?.trim();
    if (!provider) return jsonError(400, "missing_provider", "provider is required");

    // Rome-brokered toolkits (e.g. GitHub) are connected in Settings → Connections
    // and bridged into Composio by core. Refuse a Composio OAuth here even though
    // the UI and agent actions already route away — so a stale bundle, replayed
    // connect-card, or direct request can't mint a second, unmanaged connection.
    if (isRomeManagedToolkit(provider)) {
      return jsonError(409, "rome_managed_toolkit", romeManagedConnectHint(provider));
    }

    // Only toolkits in the supported catalog have a Composio managed auth config.
    // Reject anything else before touching Composio so a stale bundle or direct
    // request can't start an OAuth that has nowhere to land.
    if (!isSupportedToolkit(provider)) {
      return jsonError(400, "unsupported_toolkit", unsupportedToolkitHint(provider));
    }

    const client = await this.loadClient();
    if (!client) return jsonError(409, "no_api_key", "Log in to Composio first");

    try {
      await this.ensureWebhookRegistered(client);
    } catch (err) {
      if (isComposioAuthenticationError(err)) throw err;
      // A webhook is required to receive trigger events, but not to complete an
      // OAuth connection or use Composio tools. Keep the recovery attempt here
      // while allowing the connection flow to proceed; feed creation remains
      // the hard gate below.
      this.ctx.log.warn("connectors.start: webhook registration failed; continuing OAuth", {
        provider,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const authConfigId = await client.ensureAuthConfig(provider);

    // Only an inline chat-transcript card sends `webchat`; everything else (the
    // dashboard, an omitted field) lands on the dashboard, which stays the safe
    // default for any client that doesn't name its origin.
    const origin: ConnectOrigin = body?.origin === "webchat" ? "webchat" : "dashboard";

    const csrfToken = randomToken();
    const callbackUrl =
      body?.callbackUrl?.trim() ?? this.resolveDashboardCallbackUrl(request, csrfToken);

    const outcome = await client.ensureConnection(
      ROME_USER_ID,
      authConfigId,
      provider,
      callbackUrl,
    );

    // Already connected — nothing to authorize, so don't register a CSRF token
    // or hand back a redirect; the dashboard just refreshes its connection list.
    if (outcome.kind === "existing") {
      return Response.json({ provider, alreadyConnected: true });
    }

    this.csrf.put(csrfToken, provider, origin);
    return Response.json({
      authorizationUrl: outcome.url,
      csrfToken,
      provider,
    });
  }

  private resolveDashboardCallbackUrl(request: RomeAppApiRequest, csrfToken: string): string {
    const forwardedHost =
      rawHeader(request.headers, "x-forwarded-host") ?? rawHeader(request.headers, "host");
    const forwardedProto = rawHeader(request.headers, "x-forwarded-proto") ?? "https";
    if (!forwardedHost) {
      throw new Error("Cannot derive callback URL — forward Host header");
    }
    return `${forwardedProto}://${forwardedHost}/api/apps/${APP_ID}/callback?csrf=${encodeURIComponent(csrfToken)}`;
  }

  private async handleCallback(request: RomeAppApiRequest): Promise<Response> {
    const csrfToken = request.query.get("csrf");
    if (!csrfToken) {
      return jsonError(403, "missing_csrf", "csrf token missing on callback");
    }
    const consumed = this.csrf.consume(csrfToken);
    if (!consumed) {
      return jsonError(403, "csrf_invalid", "csrf token expired or unknown");
    }

    // Don't trust Composio's redirect `status` (it returns "success", not Rome's
    // ACTIVE vocabulary). Resolve the real state of our managed account so the
    // ACTIVE check reflects whether the connection actually landed. This is a
    // live Composio call reached from a browser redirect: a transient failure
    // must still land the guardian on a terminal page (as `failed`), never on a
    // raw 500 from the outer handler.
    const client = await this.loadClient();
    let resolved:
      | { kind: "ok"; id: string }
      | { kind: "none" }
      | { kind: "ambiguous"; ids: string[] };
    try {
      resolved = client
        ? await client.findActiveConnectedAccount(ROME_USER_ID, consumed.provider)
        : { kind: "none" };
    } catch {
      resolved = { kind: "none" };
    }
    return buildCallbackResponse(consumed.origin, consumed.provider, resolved.kind === "ok");
  }

  private async handleListConnectors(): Promise<Response> {
    const client = await this.loadClient();
    if (!client) return jsonError(409, "no_api_key", "Log in to Composio first");
    const items = await client.listConnectedAccounts(ROME_USER_ID);
    return Response.json({ items });
  }

  private async handleDisconnectConnector(toolkit: string): Promise<Response> {
    const provider = toolkit.trim();
    if (!provider) return jsonError(400, "missing_provider", "toolkit is required");

    const client = await this.loadClient();
    if (!client) return jsonError(409, "no_api_key", "Log in to Composio first");

    const { deleted } = await client.disconnectToolkit(ROME_USER_ID, provider);
    this.ctx.log.info("connectors.disconnect", { provider, deleted });
    return Response.json({ ok: true, deleted });
  }

  private async handleCreateFeed(request: RomeAppApiRequest): Promise<Response> {
    const body = parseJsonBody<FeedBody>(request.body);
    const triggerSlug = trimToUndef(body?.triggerSlug);
    if (!triggerSlug) {
      return jsonError(400, "missing_trigger_slug", "triggerSlug is required");
    }

    const client = await this.loadClient();
    if (!client) return jsonError(409, "no_api_key", "Log in to Composio first");

    try {
      await this.ensureWebhookRegistered(client);
    } catch (err) {
      return this.webhookRegistrationError(err);
    }

    const result = await subscribeTriggerFeed(client, {
      slug: triggerSlug,
      config: body?.config ?? {},
      connectedAccountId: trimToUndef(body?.connectedAccountId),
    });
    if (!result.ok) {
      const status = result.code === "unknown_trigger_slug" ? 400 : 409;
      return jsonError(status, result.code, result.message);
    }

    return Response.json({
      triggerInstanceId: result.triggerInstanceId,
      topic: result.eventName,
    });
  }

  private async handleListFeeds(): Promise<Response> {
    const client = await this.loadClient();
    if (!client) return jsonError(409, "no_api_key", "Log in to Composio first");

    const items: Array<{
      triggerInstanceId: string;
      provider: string;
      eventType: string;
      topic: string;
      config: Record<string, unknown>;
      updatedAt: string;
    }> = [];
    for (const row of await client.listActiveTriggers()) {
      let provider: string;
      try {
        const type = await client.getTriggerType(row.triggerName);
        provider = type.toolkit.slug.toLowerCase();
      } catch (err) {
        this.ctx.log.warn("triggers.getType failed — skipping row", {
          triggerName: row.triggerName,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      const eventType = row.triggerName.toLowerCase();
      items.push({
        triggerInstanceId: row.triggerInstanceId,
        provider,
        eventType,
        topic: buildTopic(provider, eventType),
        config: row.triggerConfig,
        updatedAt: row.updatedAt,
      });
    }

    return Response.json({ items });
  }

  private async handleDeleteFeed(triggerInstanceId: string): Promise<Response> {
    const client = await this.loadClient();
    if (!client) return jsonError(409, "no_api_key", "Log in to Composio first");
    try {
      await client.deleteTrigger(triggerInstanceId);
    } catch (err) {
      // 404 means the trigger is already gone upstream (out-of-band deletion
      // or a double-click) — the desired post-state holds, so treat as ok.
      if (!isComposioNotFoundError(err)) throw err;
      this.ctx.log.info("triggers.delete — upstream already gone", { triggerInstanceId });
    }
    return Response.json({ ok: true });
  }

  private async handleListEvents(request: RomeAppApiRequest): Promise<Response> {
    const topic = request.query.get("topic") ?? undefined;
    const limitRaw = Number.parseInt(request.query.get("limit") ?? "", 10);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(limitRaw, EVENTS_MAX_LIMIT)
        : EVENTS_DEFAULT_LIMIT;
    const rows = await this.events.listEvents({ topic, limit });
    return Response.json({
      items: rows.map((row) => ({
        eventId: row.eventId,
        topic: row.topic,
        provider: row.provider,
        eventType: row.eventType,
        receivedAt: row.receivedAt.toISOString(),
        data: safeParsePayload(row.payloadJson),
      })),
    });
  }

  private async handleWebhook(request: RomeAppApiRequest): Promise<Response> {
    // Rome Mail rides the same relay/webhook transport but is not a
    // Composio webhook. Rome Cloud stamps `x-rome-mail-source: agentmail` on the
    // deposit (the relay strips only `x-rome-internal-*`, so this marker
    // survives replay). Route those straight into core's `email_inbound` action,
    // which verifies the per-inbox HMAC before trusting the body — this branch
    // is pure transport and never authenticates anything itself.
    if (rawHeader(request.headers, "x-rome-mail-source") === "agentmail") {
      return await this.handleMailInbound(request);
    }

    // Rome's own GitHub webhook (no Composio): GitHub stamps `X-GitHub-Event` on
    // every delivery. This rides the same relay/`/webhook` transport as Composio
    // (custom headers survive replay, like `x-rome-mail-source`), but verifies
    // GitHub's own HMAC scheme against the secret `connector_github_subscribe`
    // registered — never Composio's.
    if (rawHeader(request.headers, GITHUB_EVENT_HEADER)) {
      return await this.handleGithubWebhook(request);
    }

    const webhookSecret = await this.settings.get("webhookSecret");
    if (!webhookSecret) {
      // Not-yet-configured is a transient state, not a rejected request: the
      // relay drainer ACKs a terminal 4xx (permanently dropping the event), so
      // answer 503 to keep buffered deliveries queued until the guardian
      // finishes connecting Composio. Signature failures below stay 401 — those
      // are genuinely terminal.
      this.ctx.log.warn("webhook hit before connect", {});
      return new Response(null, { status: 503 });
    }

    const rawBytes = request.body ?? new Uint8Array(0);
    const rawString = new TextDecoder().decode(rawBytes);

    const webhookId = rawHeader(request.headers, "webhook-id");
    const webhookSignature = rawHeader(request.headers, "webhook-signature");
    const webhookTimestamp = rawHeader(request.headers, "webhook-timestamp");
    if (!webhookId || !webhookSignature || !webhookTimestamp) {
      return new Response(null, { status: 401 });
    }

    const client = await this.loadClient();
    if (!client) return new Response(null, { status: 401 });

    let verified;
    try {
      verified = ComposioClient.verifyWebhook({
        id: webhookId,
        payload: rawString,
        secret: webhookSecret,
        signature: webhookSignature,
        timestamp: webhookTimestamp,
      });
    } catch (err) {
      this.ctx.log.warn("webhook hmac failed", {
        webhookId,
        error: err instanceof Error ? err.message : String(err),
      });
      return new Response(null, { status: 401 });
    }

    const rawPayload = verified.rawPayload ?? safeParseJson(rawString);
    const result = await processVerifiedWebhook(
      this.events,
      async (slug) => {
        try {
          const type = await client.getTriggerType(slug);
          return type.toolkit.slug;
        } catch (err) {
          if (isComposioNotFoundError(err)) return null;
          throw err;
        }
      },
      rawPayload,
      webhookId,
      new Date(),
    );
    if (result.kind === "ignored") {
      this.ctx.log.info("webhook ignored", { webhookId, reason: result.reason });
      return Response.json({ ok: true, ignored: result.reason });
    }
    if (result.kind === "deduped") {
      this.ctx.log.info("webhook retry dedup", { eventId: result.event.eventId });
    }
    if (result.kind === "emitted") {
      try {
        await publishEmittedEvent((name, args) => this.ctx.runAction(name, args), result);
        this.ctx.log.info("published composio event to bus", {
          eventId: result.event.eventId,
          topic: result.topic,
        });
      } catch (err) {
        // The event is already persisted in connector__emitted_events (visible
        // via GET /events), so the trigger fire is recoverable. Ack Composio
        // anyway: a non-2xx would make it retry, and the retry dedups — it
        // would never republish, so 500-ing here strands the event instead of
        // recovering it.
        this.ctx.log.error("failed to publish composio event to bus", {
          eventId: result.event.eventId,
          topic: result.topic,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return Response.json({ ok: true, deduped: result.kind === "deduped" });
  }

  /**
   * Ingest a verified GitHub webhook delivery — Rome's own GitHub event path,
   * zero Composio. Verifies the `X-Hub-Signature-256` HMAC against the secret
   * `connector_github_subscribe` minted and registered on the hook, then emits
   * `provider:event:github.<event>` onto the bus (deduped on GitHub's delivery
   * GUID) so a routine's event-bus trigger fires. A `ping` (GitHub's creation
   * test delivery) is acked without emitting.
   */
  private async handleGithubWebhook(request: RomeAppApiRequest): Promise<Response> {
    const secret = await this.settings.get("githubWebhookSecret");
    if (!secret) {
      // No GitHub hook was registered through Rome, so there is no secret to
      // verify against. Terminal 401: GitHub surfaces it as a failed delivery,
      // the right signal that this instance isn't expecting GitHub webhooks.
      this.ctx.log.warn("github webhook hit before subscribe", {});
      return new Response(null, { status: 401 });
    }

    const rawString = new TextDecoder().decode(request.body ?? new Uint8Array(0));
    const signature = rawHeader(request.headers, GITHUB_SIGNATURE_HEADER);
    if (!(await verifyGithubSignature(rawString, signature, secret))) {
      this.ctx.log.warn("github webhook hmac failed", {});
      return new Response(null, { status: 401 });
    }

    const eventType = rawHeader(request.headers, GITHUB_EVENT_HEADER) ?? "";
    if (eventType === GITHUB_PING_EVENT) {
      return Response.json({ ok: true, ping: true });
    }
    const deliveryId = rawHeader(request.headers, GITHUB_DELIVERY_HEADER);
    if (!eventType || !deliveryId) {
      return new Response(null, { status: 400 });
    }

    const result = await processGithubWebhook(
      this.events,
      safeParseJson(rawString),
      eventType,
      deliveryId,
      new Date(),
    );
    if (result.kind === "deduped") {
      this.ctx.log.info("github webhook retry dedup", { eventId: result.event.eventId });
    }
    if (result.kind === "emitted") {
      try {
        await publishEmittedEvent((name, args) => this.ctx.runAction(name, args), result);
        this.ctx.log.info("published github event to bus", {
          eventId: result.event.eventId,
          topic: result.topic,
        });
      } catch (err) {
        // Already persisted (visible via GET /events), so the fire is
        // recoverable. Ack anyway: a non-2xx makes GitHub redeliver, and the
        // retry dedups — it would never republish, so 500-ing strands the event.
        this.ctx.log.error("failed to publish github event to bus", {
          eventId: result.event.eventId,
          topic: result.topic,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return Response.json({ ok: true, deduped: result.kind === "deduped" });
  }

  // Transport-only bridge for inbound Rome Mail: hand the raw deposit body and
  // its HMAC to core's `email_inbound` action. We never verify or interpret the
  // mail here — `email_inbound`/EmailAdapter own the per-inbox HMAC check and
  // all email semantics. Always ACK 200: a missing/disabled email channel or a
  // bad signature is handled (and dropped) downstream, and a relay retry would
  // not change the outcome.
  private async handleMailInbound(request: RomeAppApiRequest): Promise<Response> {
    const signature = rawHeader(request.headers, "x-rome-mail-signature") ?? "";
    const rawBody = new TextDecoder().decode(request.body ?? new Uint8Array(0));
    try {
      await this.ctx.runAction("email_inbound", { rawBody, signature });
    } catch (err) {
      this.ctx.log.error("email_inbound transport failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return Response.json({ ok: true });
  }
}

function safeParsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function safeParseJson(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function createApiHandler(ctx: RomeAppContext): RomeAppApiHandler {
  return new ComposioApiHandler(ctx);
}
