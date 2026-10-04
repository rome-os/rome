import { createHmac, timingSafeEqual } from "node:crypto";
import { Composio as ComposioRestClient } from "@composio/client";

const DEFAULT_BASE_URL = "https://backend.composio.dev";

/**
 * Webhook freshness window (seconds). Deliveries whose `webhook-timestamp` is
 * older/newer than this are rejected as possible replays — matching the default
 * Composio/Standard-Webhooks tolerance.
 */
const WEBHOOK_TOLERANCE_SECONDS = 300;

/** Bound the health/auth probe so a slow Composio can't hang the dashboard. */
const PING_TIMEOUT_MS = 8000;

/**
 * Backstop for the active-triggers pagination loop: a misbehaving API that
 * returns a stable `next_cursor` would otherwise spin forever. No real install
 * approaches this; hitting it means the cursor is broken, so we fail loudly.
 */
const MAX_TRIGGER_PAGES = 200;

/**
 * The only part of a trigger type the app consumes is its owning toolkit slug
 * (used to build canonical topics). Typed structurally so we don't couple to
 * the alpha `@composio/client`'s exact response export.
 */
export interface TriggerType {
  slug: string;
  toolkit: { slug: string };
}

/** Lightweight trigger-type row for discovery (connector_event_search). */
export interface TriggerTypeSummary {
  slug: string;
  name: string;
  description: string;
}

/**
 * Full trigger-type definition (connector_event_schema). `config` is the schema
 * of the `triggerConfig` a subscribe call must supply; `payload` is the schema
 * of the event a fired trigger delivers (used to author routine filters and map
 * fields into the routine's action). `requiresWebhookEndpointSetup` is true for
 * triggers (e.g. Slack, Notion) that won't deliver until a Composio-issued
 * webhook URL is registered with the upstream provider out-of-band.
 */
export interface TriggerSchema {
  slug: string;
  name: string;
  description: string;
  toolkitSlug: string;
  config: Record<string, unknown>;
  payload: Record<string, unknown>;
  requiresWebhookEndpointSetup: boolean;
}

/**
 * Composio accepts two credential kinds on different headers, and the dashboard
 * supports both onboarding paths:
 *   - a **project** API key (`ak_…`, pasted from dashboard.composio.dev) →
 *     authenticates as `x-api-key`.
 *   - a **user** API key (`uak_…`, what `composio login` persists) →
 *     authenticates as `x-user-api-key`.
 * The same `uak_`/`ak_` value is rejected on the wrong header (401), so the
 * header is chosen by prefix. The high-level `@composio/core` SDK hard-codes
 * `x-api-key`, so it can't carry a `uak_`; we drive the low-level
 * `@composio/client` instead and inject the right auth header ourselves.
 */
function authHeaderFor(apiKey: string): Record<string, string> {
  return apiKey.startsWith("uak_") ? { "x-user-api-key": apiKey } : { "x-api-key": apiKey };
}

class ComposioHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Recognizes credential rejection from both the SDK and direct Composio requests. */
export function isComposioAuthenticationError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 401;
}

/**
 * Module-scope dedup: `ensureAuthConfig` is a list-then-create flow
 * that races on double-click — two parallel calls for the same toolkit can
 * both see an empty list and both call `create`, leaving two managed configs
 * upstream. Coalesce concurrent calls per toolkit by sharing the in-flight
 * promise. Cleared once the call settles.
 */
const inFlightAuthConfigEnsures = new Map<string, Promise<string>>();

const AUTH_SCHEME_API_KEY = "API_KEY";

/**
 * Module-scope cache of trigger type lookups, keyed by lowercase slug.
 * `TriggerType` is the authoritative source of a trigger's toolkit
 * (`.toolkit.slug`) — replacing the brittle "split on first underscore"
 * heuristic that mis-classifies multi-word toolkits like `MICROSOFT_TEAMS`.
 * Definitions are stable; we hold the resolved promise so concurrent webhook
 * deliveries for the same slug share a single HTTP fetch.
 */
const triggerTypeCache = new Map<string, Promise<TriggerType>>();

const COMPOSIO_WEBHOOK_EVENT_TYPES = [
  "composio.trigger.message",
  "composio.trigger.disabled",
  "composio.connected_account.expired",
] as const;

export interface WebhookEndpointResult {
  id: string;
  secret: string;
}

export interface ComposioClientOptions {
  apiKey: string;
  baseURL?: string;
}

export interface ActiveTrigger {
  triggerInstanceId: string;
  triggerName: string;
  triggerConfig: Record<string, unknown>;
  updatedAt: string;
}

export interface ConnectedAccountSummary {
  id: string;
  toolkitSlug: string;
  status: string;
  /** Composio's per-account alias, or null. `ROME_MANAGED_ALIAS` marks the one
   *  connection the connect flow owns for a `(guardian, toolkit)` pair. */
  alias: string | null;
}

interface ExistingAuthConfigSummary {
  id: string;
  status: string;
  toolkit?: { slug?: string | null } | null;
  auth_scheme?: string;
  is_composio_managed?: boolean;
}

/**
 * A tool from Composio's catalog, normalized to the fields a Rome agent acts on
 * when wiring a workflow step: the `slug` to execute, a human label/description
 * to match intent against, the owning toolkit, and the JSON-schema of inputs so
 * the agent can shape the args. The alpha SDK's richer item type is deliberately
 * not leaked — same posture as `listConnectedAccounts`/`listActiveTriggers`.
 */
export interface SearchedTool {
  slug: string;
  name: string;
  description: string;
  toolkitSlug: string;
  inputParameters: Record<string, unknown>;
}

/**
 * One tool's full schema from `tools.retrieve`, normalized for app authors: the
 * tool's name/description plus Composio's raw `input_parameters` /
 * `output_parameters` JSON Schemas, renamed `input`/`output` and passed through
 * verbatim (the schemas are self-contained — no `$ref` resolution needed). The
 * catalog `searchTools` page carries only the input schema; this is the surface
 * that also exposes `output`. `output` is always present, but the granularity of
 * its `data` shape is upstream-dependent: some toolkits model it richly, others
 * leave `data` an opaque object — a thin `output.data` is a hint, not a
 * guaranteed shape. `toolkitSlug` is the authoritative owner, for cross-checking.
 */
export interface ToolSchema {
  slug: string;
  name: string;
  description: string;
  toolkitSlug: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}

/**
 * The result of a `tools.execute` call, normalized to Composio's success
 * envelope. `ok` is the tool-level success flag (`successful` upstream): a call
 * can round-trip and still report `ok: false` with `error` set (the tool ran and
 * refused) — distinct from the action-level errors a caller raises when the
 * toolkit isn't connected or the call throws. `data` is the tool-specific
 * payload, opaque at this boundary (see `ToolSchema.output`).
 */
export interface ExecutedTool {
  ok: boolean;
  data: Record<string, unknown>;
  error: string | null;
}

/**
 * The upstream API's response surfaced verbatim by a proxied call: the provider's
 * own HTTP status, parsed body, and headers. Unlike `ExecutedTool`, there is no
 * success flag — the HTTP `status` is the success signal, so the caller maps a
 * non-2xx status to an action-level error.
 */
export interface ProxiedResponse {
  status: number;
  data: unknown;
  headers: Record<string, string>;
}

/**
 * The alias stamped on every connection the connect flow mints. Composio scopes
 * alias uniqueness per `(user, toolkit)`, so a single constant is already unique
 * per toolkit — encoding the toolkit/user would only invite a normalization
 * mismatch between the link call and the lookup. It is the identity key the
 * reconcile loop matches on to find "our" row, and the value `link.create`
 * collides on to serialize concurrent connects.
 */
export const ROME_MANAGED_ALIAS = "rome-managed";

/**
 * Composio mints a connected-account row the instant `link.create` issues the
 * OAuth redirect — before the guardian has authorized anything. A denied or
 * abandoned authorization leaves that row behind in a pre-established state
 * (`INITIALIZING`/`INITIATED`) or `FAILED`. Those are the residue of a connect
 * attempt that never completed, not real connections: surfacing them makes a
 * failed connect read as "connected" (and removes the provider from the
 * connect-able list). Every other status — `ACTIVE`, or the once-active-now-
 * degraded `EXPIRED`/`INACTIVE`/`REVOKED` — means authorization succeeded at
 * least once, so the account is a real connection worth showing; the degraded
 * ones surface as "needs attention".
 */
const NON_ESTABLISHED_STATUSES = new Set(["INITIALIZING", "INITIATED", "FAILED"]);

export function isEstablishedConnection(status: string): boolean {
  return !NON_ESTABLISHED_STATUSES.has(status.toUpperCase());
}

/**
 * Normalize Composio's raw connected-account rows into the app's summary shape,
 * dropping never-established residue (see `isEstablishedConnection`). Pure over
 * the wire items so the surfacing rule can be exercised against fixtures.
 */
export function toEstablishedAccountSummaries(
  items: Array<{ id: string; toolkit: { slug: string }; status: string; alias?: string | null }>,
): ConnectedAccountSummary[] {
  return items
    .filter((item) => isEstablishedConnection(item.status))
    .map((item) => ({
      id: item.id,
      toolkitSlug: item.toolkit.slug,
      status: item.status,
      alias: item.alias ?? null,
    }));
}

/**
 * The `ROME_MANAGED_ALIAS` account is the only connection Rome owns for a given
 * toolkit, so it is the only one the app ever surfaces or acts on. Drop any
 * account the guardian linked outside Rome (different alias, or none) — those
 * are unmanaged duplicates that must not appear in the dashboard or be picked
 * by trigger resolution. Pure over the wire items for fixture testing.
 */
export function toManagedAccountSummaries(
  items: Array<{ id: string; toolkit: { slug: string }; status: string; alias?: string | null }>,
): ConnectedAccountSummary[] {
  return toEstablishedAccountSummaries(items).filter((a) => a.alias === ROME_MANAGED_ALIAS);
}

/** Thrown when `link.create` is rejected because the alias is already taken —
 *  the signal the reconcile loop retries on. */
export class AliasConflictError extends Error {
  constructor(message = "alias already in use") {
    super(message);
    this.name = "AliasConflictError";
  }
}

/**
 * Best-effort classification of a `link.create` rejection as an alias-uniqueness
 * conflict. Composio's docs don't pin down the error shape, so this matches on a
 * 409 status or conflict-ish wording. Tighten once the live behavior is
 * confirmed; over-matching only costs an extra reconcile round, never a dupe.
 */
export function isAliasConflict(err: unknown): boolean {
  if (err instanceof AliasConflictError) return true;
  const status = (err as { status?: unknown })?.status;
  if (status === 409) return true;
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /alias/i.test(text) && /(unique|exist|conflict|taken|duplicate)/i.test(text);
}

/**
 * Detect Composio SDK errors that wrap an HTTP 404 (target row already gone).
 * The SDK doesn't expose a typed error class for this, so we sniff the message
 * and any `status` / `statusCode` field. Used to keep deletes idempotent — a 404
 * means the row is already in the desired (absent) state.
 */
export function isComposioNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: unknown; statusCode?: unknown; message?: unknown };
  if (e.status === 404 || e.statusCode === 404) return true;
  return typeof e.message === "string" && /\b404\b|not[_ ]found/i.test(e.message);
}

export function selectReusableAuthConfig(
  items: ExistingAuthConfigSummary[],
  toolkit: string,
): string | null {
  const key = toolkit.toLowerCase();
  const enabledForToolkit = items.filter(
    (row) => row.toolkit?.slug?.toLowerCase() === key && row.status === "ENABLED",
  );
  const managed = enabledForToolkit.find((row) => row.is_composio_managed);
  if (managed) return managed.id;

  const apiKeyConfig = enabledForToolkit.find((row) => row.auth_scheme === AUTH_SCHEME_API_KEY);
  return apiKeyConfig?.id ?? null;
}

/** A connected-account row reduced to the fields the reconcile loop reasons on. */
export interface ConnectAccountRow {
  id: string;
  alias: string | null;
  status: string;
}

/**
 * The three Composio operations `reconcileManagedConnection` needs, named as an
 * explicit port so the loop runs against an in-memory fake in tests — no network,
 * no SDK error shapes. `createLink` must throw `AliasConflictError` (or anything
 * `isAliasConflict` recognizes) when the alias is contended.
 */
export interface ConnectPort {
  listByToolkit(userId: string, toolkit: string): Promise<ConnectAccountRow[]>;
  deleteAccount(id: string): Promise<void>;
  createLink(input: {
    userId: string;
    authConfigId: string;
    alias: string;
    callbackUrl: string;
  }): Promise<{ redirectUrl: string }>;
}

export type ConnectOutcome = { kind: "existing"; id: string } | { kind: "redirect"; url: string };

const RECONCILE_MAX_ATTEMPTS = 3;

/**
 * Converge `(guardian, toolkit)` to exactly one managed connection:
 *
 *  1. Find our row by `ROME_MANAGED_ALIAS`. If it's ACTIVE, we're connected —
 *     reuse it, mint nothing.
 *  2. Otherwise (stuck pre-OAuth residue, or a degraded once-active account)
 *     delete it so the alias is free and a fresh authorize can run.
 *  3. `link.create` with the alias. If that loses an alias race to a concurrent
 *     connect, re-list and retry (optimistic concurrency) up to a small cap.
 *
 * Pure over the injected port so the branching is exercised without a real
 * Composio. The alias is what lets step 3 detect the race at all — without a
 * server-side uniqueness collision the loop would have nothing to retry on.
 */
export async function reconcileManagedConnection(
  port: ConnectPort,
  params: { userId: string; toolkit: string; authConfigId: string; callbackUrl: string },
): Promise<ConnectOutcome> {
  for (let attempt = 0; attempt < RECONCILE_MAX_ATTEMPTS; attempt++) {
    const ours = (await port.listByToolkit(params.userId, params.toolkit)).find(
      (row) => row.alias === ROME_MANAGED_ALIAS,
    );
    if (ours) {
      if (ours.status.toUpperCase() === "ACTIVE") return { kind: "existing", id: ours.id };
      await port.deleteAccount(ours.id);
    }
    try {
      const link = await port.createLink({
        userId: params.userId,
        authConfigId: params.authConfigId,
        alias: ROME_MANAGED_ALIAS,
        callbackUrl: params.callbackUrl,
      });
      return { kind: "redirect", url: link.redirectUrl };
    } catch (err) {
      if (isAliasConflict(err)) continue;
      throw err;
    }
  }
  throw new Error(
    `could not establish a Composio connection for ${params.toolkit} after ${RECONCILE_MAX_ATTEMPTS} attempts (alias contention)`,
  );
}

/**
 * Tear down the managed connection(s) for `(guardian, toolkit)`, returning Rome
 * to the unconnected state. Only `ROME_MANAGED_ALIAS` rows are deleted — the same
 * scoping `reconcileManagedConnection` matches on — so a connection the guardian
 * linked outside Rome is never touched. Every managed row is removed, not just an
 * ACTIVE one, so a degraded/expired residue can't leave the toolkit showing as
 * half-connected after disconnect. Returns the count removed; `port.deleteAccount`
 * absorbs a 404 so a row already gone upstream still counts toward the desired
 * post-state. Pure over the port for the same reason as the reconcile loop.
 */
export async function disconnectManagedToolkit(
  port: Pick<ConnectPort, "listByToolkit" | "deleteAccount">,
  params: { userId: string; toolkit: string },
): Promise<{ deleted: number }> {
  const managed = (await port.listByToolkit(params.userId, params.toolkit)).filter(
    (row) => row.alias === ROME_MANAGED_ALIAS,
  );
  for (const row of managed) {
    await port.deleteAccount(row.id);
  }
  return { deleted: managed.length };
}

/** Constant-time compare of two base64 signature strings. */
function signaturesMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Reject a delivery whose timestamp is outside the freshness window. The HMAC
 * already binds the timestamp, so this only adds replay resistance; `Math.abs`
 * also rejects timestamps too far in the future.
 */
function assertWebhookTimestampFresh(timestamp: string): void {
  const seconds = Number.parseInt(timestamp, 10);
  if (Number.isNaN(seconds)) {
    throw new Error(`webhook timestamp is not a unix timestamp: ${timestamp}`);
  }
  if (Math.abs(Date.now() - seconds * 1000) > WEBHOOK_TOLERANCE_SECONDS * 1000) {
    throw new Error(`webhook timestamp is outside the ${WEBHOOK_TOLERANCE_SECONDS}s tolerance`);
  }
}

/**
 * Everything Composio-specific lives behind this seam — the rest of the app
 * deals only in the plain shapes returned here, never the SDK's wire types.
 * Networked calls go through the low-level `@composio/client` (so we control
 * the auth header). Webhook verification is local crypto and carries no key.
 */
export class ComposioClient {
  private readonly rest: ComposioRestClient;
  private readonly apiKey: string;
  private readonly baseURL: string;

  constructor(opts: ComposioClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseURL = opts.baseURL ?? DEFAULT_BASE_URL;
    this.rest = new ComposioRestClient({
      apiKey: null,
      baseURL: this.baseURL,
      defaultHeaders: authHeaderFor(this.apiKey),
    });
  }

  /**
   * Connect `userId` to `toolkit`, reusing the existing managed connection if it
   * is already ACTIVE and otherwise minting one — never accumulating duplicate
   * connected accounts for the pair. Returns `existing` when nothing to authorize
   * remains, or `redirect` with the URL the guardian authorizes at.
   *
   * The decision logic lives in `reconcileManagedConnection`; this wires the
   * Composio SDK calls behind the `ConnectPort` seam and maps a rejected
   * `link.create` to `AliasConflictError` so the loop can retry the race.
   */
  async ensureConnection(
    userId: string,
    authConfigId: string,
    toolkit: string,
    callbackUrl: string,
  ): Promise<ConnectOutcome> {
    return reconcileManagedConnection(this.connectPort(), {
      userId,
      toolkit,
      authConfigId,
      callbackUrl,
    });
  }

  /**
   * Disconnect `userId` from `toolkit` — delete the managed connection so the
   * toolkit returns to its unconnected state. The dashboard's "Disconnect" action
   * and any agent-initiated teardown share this single path. Idempotent: when no
   * managed connection exists (already disconnected, or a 404 racing a duplicate
   * request) it reports `{ deleted: 0 }` rather than failing.
   */
  async disconnectToolkit(userId: string, toolkit: string): Promise<{ deleted: number }> {
    return disconnectManagedToolkit(this.connectPort(), { userId, toolkit });
  }

  /**
   * The list/delete pair the connection reconcile and teardown share. Extracted
   * so the idempotent-delete posture (a 404 is the desired post-state, not an
   * error) lives in exactly one place and `connectPort` inherits it.
   */
  private managedAccountPort(): Pick<ConnectPort, "listByToolkit" | "deleteAccount"> {
    return {
      listByToolkit: async (uid, tk) => {
        const list = await this.rest.connectedAccounts.list({
          user_ids: [uid],
          toolkit_slugs: [tk],
        });
        return list.items.map((item) => ({
          id: item.id,
          alias: item.alias ?? null,
          status: item.status,
        }));
      },
      deleteAccount: async (id) => {
        // A concurrent connect (two tabs / double-click) or an out-of-band
        // disconnect can remove the same row first; a 404 here means it's already
        // gone, which is exactly the state both callers want.
        try {
          await this.rest.connectedAccounts.delete(id);
        } catch (err) {
          if (!isComposioNotFoundError(err)) throw err;
        }
      },
    };
  }

  private connectPort(): ConnectPort {
    return {
      ...this.managedAccountPort(),
      createLink: async ({ userId: uid, authConfigId: acId, alias, callbackUrl: cb }) => {
        try {
          const link = await this.rest.link.create({
            auth_config_id: acId,
            user_id: uid,
            alias,
            callback_url: cb,
          });
          return { redirectUrl: link.redirect_url };
        } catch (err) {
          if (isAliasConflict(err)) throw new AliasConflictError();
          throw err;
        }
      },
    };
  }

  /**
   * List a user's established connected accounts. Composio returns rows in every
   * lifecycle state, including the never-authorized residue of an abandoned/failed
   * connect; `toEstablishedAccountSummaries` drops those so a failed connect never
   * surfaces as a connection.
   */
  async listConnectedAccounts(userId: string): Promise<ConnectedAccountSummary[]> {
    const list = await this.rest.connectedAccounts.list({ user_ids: [userId] });
    return toManagedAccountSummaries(list.items);
  }

  /**
   * Full-text search Composio's tool catalog by capability ("create a github
   * issue"), optionally scoped to one toolkit. Returns the first page only —
   * `limit` bounds it — because the caller is an agent matching intent to a
   * slug, not paging an exhaustive list. `query` is the live search field; the
   * SDK's `search` param is deprecated.
   */
  async searchTools(opts: {
    query: string;
    toolkit?: string;
    limit?: number;
  }): Promise<SearchedTool[]> {
    const page = await this.rest.tools.list({
      query: opts.query,
      ...(opts.toolkit ? { toolkit_slug: opts.toolkit } : {}),
      ...(opts.limit != null ? { limit: opts.limit } : {}),
    });
    return page.items.map((item) => ({
      slug: item.slug,
      name: item.name,
      description: item.description,
      toolkitSlug: item.toolkit.slug,
      inputParameters: item.input_parameters,
    }));
  }

  /**
   * Retrieve one tool's full definition by slug — the input AND output JSON
   * Schemas Composio publishes. The catalog `searchTools` page omits the output
   * schema; a coding agent reads this at authoring time to shape the `arguments`
   * it will pass to `executeTool` and to know how to narrow the returned `data`.
   * Composio's schemas are self-contained, so they pass through verbatim.
   */
  async getToolSchema(slug: string): Promise<ToolSchema> {
    const tool = await this.rest.tools.retrieve(slug);
    return {
      slug: tool.slug,
      name: tool.name,
      description: tool.description,
      toolkitSlug: tool.toolkit.slug,
      input: tool.input_parameters,
      output: tool.output_parameters,
    };
  }

  /**
   * Execute one tool against its connected service, authenticating as the given
   * managed connected account. Composio holds the OAuth credential and proxies
   * the upstream API call. Returns Composio's success envelope unchanged
   * (`successful` → `ok`): a thrown error is an infra/transport failure the
   * caller maps to an action-level error, whereas `ok: false` is the tool itself
   * reporting refusal.
   */
  async executeTool(params: {
    userId: string;
    connectedAccountId: string;
    slug: string;
    args: Record<string, unknown>;
  }): Promise<ExecutedTool> {
    const res = await this.rest.tools.execute(params.slug, {
      // Composio requires the entity (`user_id`) ALONGSIDE `connected_account_id`
      // to identify whose account to act as; passing the account id alone 400s
      // with `ActionExecute_ConnectedAccountEntityIdRequired`.
      user_id: params.userId,
      connected_account_id: params.connectedAccountId,
      arguments: params.args,
    });
    return { ok: res.successful, data: res.data, error: res.error };
  }

  /**
   * Proxy a raw HTTP request to the toolkit's native provider API, authenticating
   * as the given managed connected account. Composio holds the OAuth credential
   * and injects it into the outbound call, so the caller writes against the
   * provider's own REST/GraphQL surface (full API, not Composio's curated tool
   * subset) without ever handling the token. Returns the upstream response
   * verbatim (`status`/`data`/`headers`); a thrown error is an infra/transport
   * failure (e.g. the account can't be resolved), whereas a non-2xx `status` is
   * the provider rejecting the request — both of which the caller fails closed on.
   */
  async proxyTool(params: {
    connectedAccountId: string;
    endpoint: string;
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD";
    body?: unknown;
    query?: Record<string, string | number>;
    headers?: Record<string, string>;
  }): Promise<ProxiedResponse> {
    // The public surface mirrors a common HTTP client (`query`/`headers` objects);
    // Composio's proxy takes a single flat `parameters` array tagged with a `type`
    // location and string values, so flatten both maps into it here.
    const parameters = [
      ...Object.entries(params.query ?? {}).map(([name, value]) => ({
        name,
        type: "query" as const,
        value: String(value),
      })),
      ...Object.entries(params.headers ?? {}).map(([name, value]) => ({
        name,
        type: "header" as const,
        value,
      })),
    ];
    const res = await this.rest.tools.proxy({
      endpoint: params.endpoint,
      method: params.method,
      connected_account_id: params.connectedAccountId,
      ...(params.body !== undefined ? { body: params.body } : {}),
      ...(parameters.length ? { parameters } : {}),
    });
    return { status: res.status, data: res.data, headers: res.headers ?? {} };
  }

  /**
   * Resolve the `ROME_MANAGED_ALIAS` connected account for a toolkit. Rome only
   * ever acts on the account it manages, so resolution is scoped to that alias —
   * unmanaged accounts the guardian linked elsewhere are invisible here. Because
   * the alias is unique per `(user, toolkit)`, the managed account is at most one;
   * `ambiguous` is a fail-closed guard for a Composio invariant violation (two
   * ACTIVE rows sharing the alias), which the API surfaces rather than guesses
   * past. Also backs the connect callback's "did it land" check via `kind`.
   */
  async findActiveConnectedAccount(
    userId: string,
    toolkit: string,
  ): Promise<{ kind: "ok"; id: string } | { kind: "none" } | { kind: "ambiguous"; ids: string[] }> {
    const list = await this.rest.connectedAccounts.list({
      user_ids: [userId],
      toolkit_slugs: [toolkit],
      statuses: ["ACTIVE"],
    });
    const ids = list.items
      .filter((item) => item.alias === ROME_MANAGED_ALIAS)
      .map((item) => item.id);
    if (ids.length === 0) return { kind: "none" };
    if (ids.length > 1) return { kind: "ambiguous", ids };
    return { kind: "ok", id: ids[0] };
  }

  /**
   * Resolve a usable Auth Config id for `toolkit`. Reuses an existing enabled
   * config when possible. For OAuth-style providers with Composio-managed auth
   * (Gmail, GitHub, Supabase, etc.) it keeps the one-click managed path. For
   * API-key-only providers (Neon, etc.) it creates a custom API_KEY config so the
   * Composio connect link can collect the user's account credential.
   *
   * Note: BYO OAuth providers still require dashboard-side credential setup; if
   * a toolkit has neither managed auth nor API_KEY auth, this surfaces a clear
   * unsupported-auth error instead of trying the wrong auth mode.
   */
  async ensureAuthConfig(toolkit: string): Promise<string> {
    const key = toolkit.toLowerCase();
    const inFlight = inFlightAuthConfigEnsures.get(key);
    if (inFlight) return inFlight;

    const work = (async () => {
      const existing = await this.rest.authConfigs.list({
        toolkit_slug: toolkit,
      });
      const reusable = selectReusableAuthConfig(existing.items, toolkit);
      if (reusable) return reusable;

      const toolkitInfo = await this.rest.toolkits.retrieve(toolkit);
      const managedScheme = toolkitInfo.composio_managed_auth_schemes?.[0];
      if (managedScheme) {
        const created = await this.rest.authConfigs.create({
          toolkit: { slug: toolkit },
          auth_config: { type: "use_composio_managed_auth" },
        });
        return created.auth_config.id;
      }

      const supportsApiKey = toolkitInfo.auth_config_details?.some(
        (detail) => detail.mode.toUpperCase() === "API_KEY",
      );
      if (!supportsApiKey) {
        throw new Error(
          `Composio toolkit "${toolkit}" does not expose managed auth or API key auth; create an auth config in Composio first.`,
        );
      }

      const created = await this.rest.authConfigs.create({
        toolkit: { slug: toolkit },
        auth_config: {
          type: "use_custom_auth",
          authScheme: AUTH_SCHEME_API_KEY,
          name: `Rome ${toolkitInfo.name} API key`,
        },
      });
      return created.auth_config.id;
    })();
    inFlightAuthConfigEnsures.set(key, work);
    try {
      return await work;
    } finally {
      inFlightAuthConfigEnsures.delete(key);
    }
  }

  /** Create a trigger instance for `userId`, returning the new instance id. */
  async createTrigger(
    userId: string,
    triggerSlug: string,
    opts: { connectedAccountId: string; triggerConfig: Record<string, unknown> },
  ): Promise<{ triggerInstanceId: string }> {
    const created = await this.rest.triggerInstances.upsert(triggerSlug, {
      connected_account_id: opts.connectedAccountId,
      trigger_config: opts.triggerConfig,
    });
    return { triggerInstanceId: created.trigger_id };
  }

  /** Page through every active trigger instance, normalized to plain shapes. */
  async listActiveTriggers(): Promise<ActiveTrigger[]> {
    const out: ActiveTrigger[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await this.rest.triggerInstances.listActive(cursor ? { cursor } : {});
      for (const row of page.items) {
        out.push({
          triggerInstanceId: row.id,
          triggerName: row.trigger_name,
          triggerConfig: (row.trigger_config ?? {}) as Record<string, unknown>,
          updatedAt: row.updated_at,
        });
      }
      cursor = page.next_cursor ?? undefined;
      if (cursor && ++pages >= MAX_TRIGGER_PAGES) {
        throw new Error(
          `listActiveTriggers exceeded ${MAX_TRIGGER_PAGES} pages — aborting a suspected pagination loop`,
        );
      }
    } while (cursor);
    return out;
  }

  /** Delete a trigger instance by id. */
  async deleteTrigger(triggerInstanceId: string): Promise<void> {
    await this.rest.triggerInstances.manage.delete(triggerInstanceId);
  }

  /**
   * Verify an inbound webhook and parse its body. Composio signs deliveries with
   * the Standard Webhooks (Svix) scheme: HMAC-SHA256 over
   * `${id}.${timestamp}.${payload}` keyed by the project signing secret, emitted
   * as one or more space-separated `v1,<base64>` tokens in the `webhook-signature`
   * header. We recompute the HMAC and constant-time-compare. This is purely local
   * crypto over `params.secret` — no API key and no network — so the verify path
   * holds no credential at all. Throws on any mismatch; the caller maps that to a
   * 401. (Static, since it depends on nothing instance-specific.)
   */
  static verifyWebhook(params: {
    id: string;
    payload: string;
    secret: string;
    signature: string;
    timestamp: string;
  }): { rawPayload: unknown } {
    const { id, payload, secret, signature, timestamp } = params;
    if (!id || !payload || !secret || !signature || !timestamp) {
      throw new Error("webhook verification is missing id/timestamp/payload/signature/secret");
    }
    assertWebhookTimestampFresh(timestamp);

    const expected = createHmac("sha256", secret)
      .update(`${id}.${timestamp}.${payload}`, "utf8")
      .digest("base64");
    const provided = signature
      .split(" ")
      .map((token) => {
        const [version, value] = token.split(",");
        return version === "v1" ? value : undefined;
      })
      .filter((value): value is string => Boolean(value));
    if (provided.length === 0) {
      throw new Error("webhook signature header has no v1 signature");
    }
    if (!provided.some((sig) => signaturesMatch(sig, expected))) {
      throw new Error("webhook signature does not match");
    }

    return { rawPayload: JSON.parse(payload) };
  }

  /**
   * Point the guardian's Composio project at `webhookUrl` and return the HMAC
   * signing secret + endpoint id. Composio models the webhook destination as a
   * single project-level config: its API names the resource
   * `webhook_subscriptions`, but there is at most one per project — it is the
   * URL every trigger fire is POSTed to, not a per-trigger entity (those are
   * trigger instances via `createTrigger`).
   *
   * Idempotent and non-destructive: LIST first, then PATCH the existing
   * endpoint or POST a new one. Both return the secret. We never DELETE-to-
   * recreate, so a project's webhook config — possibly shared with other tools
   * on the same API key — is repointed, never dropped.
   */
  async setWebhookUrl(webhookUrl: string): Promise<WebhookEndpointResult> {
    const existing = await this.listWebhookEndpointIds();
    return existing.length === 0
      ? this.writeWebhookEndpoint("POST", webhookUrl)
      : this.writeWebhookEndpoint("PATCH", webhookUrl, existing[0]);
  }

  /** Whether this key can still see a previously stored project endpoint. */
  async webhookSubscriptionExists(id: string): Promise<boolean> {
    return (await this.listWebhookEndpointIds()).includes(id);
  }

  private async writeWebhookEndpoint(
    method: "POST" | "PATCH",
    webhookUrl: string,
    id?: string,
  ): Promise<WebhookEndpointResult> {
    const response = await fetch(this.webhookEndpointsUrl(id), {
      method,
      headers: { "content-type": "application/json", ...authHeaderFor(this.apiKey) },
      body: JSON.stringify({
        webhook_url: webhookUrl,
        version: "V3",
        enabled_events: COMPOSIO_WEBHOOK_EVENT_TYPES,
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new ComposioHttpError(
        `Composio webhook_subscriptions ${method} returned ${response.status}: ${text || response.statusText}`,
        response.status,
      );
    }
    const body = (await response.json()) as { id?: string; secret?: string };
    if (!body.id || !body.secret) {
      throw new Error("Composio webhook_subscriptions response missing id or signing secret");
    }
    return { id: body.id, secret: body.secret };
  }

  private async listWebhookEndpointIds(): Promise<string[]> {
    const response = await fetch(this.webhookEndpointsUrl(), {
      method: "GET",
      headers: { ...authHeaderFor(this.apiKey) },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new ComposioHttpError(
        `Composio webhook_subscriptions list returned ${response.status}: ${text || response.statusText}`,
        response.status,
      );
    }
    const body = (await response.json()) as { items?: Array<{ id?: string }> };
    return (body.items ?? [])
      .map((row) => row.id)
      .filter((v): v is string => typeof v === "string" && v.length > 0);
  }

  async deleteWebhookEndpoint(id: string): Promise<void> {
    const response = await fetch(this.webhookEndpointsUrl(id), {
      method: "DELETE",
      headers: { ...authHeaderFor(this.apiKey) },
    });
    if (!response.ok && response.status !== 404) {
      const text = await response.text();
      throw new ComposioHttpError(
        `Composio webhook_subscriptions DELETE ${id} returned ${response.status}: ${text || response.statusText}`,
        response.status,
      );
    }
  }

  private webhookEndpointsUrl(id?: string): string {
    const base = `${this.baseURL.replace(/\/$/, "")}/api/v3.1/webhook_subscriptions`;
    return id ? `${base}/${encodeURIComponent(id)}` : base;
  }

  /**
   * Resolve a trigger slug's authoritative definition (incl. `toolkit.slug`).
   * Successful results are cached at module scope so concurrent webhook
   * deliveries for the same slug share one HTTP fetch; failures are evicted so
   * a transient error doesn't poison the cache.
   */
  async getTriggerType(slug: string): Promise<TriggerType> {
    const key = slug.toLowerCase();
    const cached = triggerTypeCache.get(key);
    if (cached) return cached;
    const work = this.rest.triggersTypes.retrieve(slug).catch((err) => {
      triggerTypeCache.delete(key);
      throw err;
    });
    triggerTypeCache.set(key, work);
    return work;
  }

  /**
   * List every trigger type a toolkit can emit (slug + name + description), for
   * event discovery. `triggers_types.list` is paginated and large toolkits carry
   * dozens of triggers (GitHub has ~46), so walk `next_cursor` to completion —
   * truncating at the first page would silently hide subscribable events.
   */
  async listTriggerTypes(toolkit: string): Promise<TriggerTypeSummary[]> {
    const out: TriggerTypeSummary[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await this.rest.triggersTypes.list({
        toolkit_slugs: [toolkit],
        ...(cursor ? { cursor } : {}),
      });
      for (const item of page.items) {
        out.push({ slug: item.slug, name: item.name, description: item.description });
      }
      cursor = page.next_cursor ?? undefined;
      if (cursor && ++pages >= MAX_TRIGGER_PAGES) {
        throw new Error(
          `listTriggerTypes exceeded ${MAX_TRIGGER_PAGES} pages — aborting a suspected pagination loop`,
        );
      }
    } while (cursor);
    return out;
  }

  /** Fetch one trigger type's full config + payload schemas by slug. */
  async getTriggerSchema(slug: string): Promise<TriggerSchema> {
    const t = await this.rest.triggersTypes.retrieve(slug);
    return {
      slug: t.slug,
      name: t.name,
      description: t.description,
      toolkitSlug: t.toolkit.slug,
      config: t.config,
      payload: t.payload,
      requiresWebhookEndpointSetup: t.requires_webhook_endpoint_setup ?? false,
    };
  }

  /**
   * Validate the credential by issuing a low-cost authenticated request.
   * Returns the underlying error text on failure so the dashboard can surface
   * "your key looks wrong" without leaking implementation detail. Uses the
   * prefix-selected auth header, so it validates both `ak_` and `uak_` keys.
   */
  async ping(): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
    const url = `${this.baseURL.replace(/\/$/, "")}/api/v3/connected_accounts?limit=1`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { ...authHeaderFor(this.apiKey) },
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
    } catch (err) {
      return {
        ok: false,
        status: 0,
        message: err instanceof Error ? err.message : "network error",
      };
    }
    if (response.ok) return { ok: true };
    const text = await response.text();
    return { ok: false, status: response.status, message: text || response.statusText };
  }
}
