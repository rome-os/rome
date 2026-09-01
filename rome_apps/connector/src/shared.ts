import { SUPPORTED_CONNECTORS } from "@rome-os/app-runtime";

import { ComposioClient, isComposioNotFoundError } from "./api/composio-client.js";
import { readSessionApiKey } from "./api/composio-login.js";
import { buildTopic } from "./api/topic.js";

/**
 * The single Composio user id every managed connection is scoped to. Rome acts
 * as one guardian-owned identity upstream, so connections, lookups, and the
 * connect flow all key on this constant.
 */
export const ROME_USER_ID = "rome-guardian";

/**
 * Toolkits brokered by Rome's own integration (Rome Cloud OAuth), with zero
 * Composio involvement. The agent must never start a Composio connect for
 * these — they're connected/disconnected in Settings → Connections. This is
 * the server-side twin of the web catalog's `romeManaged` flag, so the gate
 * holds at the agent entry point too, not just the UI. Rome-managed toolkits are
 * acted on via `connector_proxy` (direct REST/GraphQL with Rome's OAuth token),
 * never `connector_tool_execute` (Composio-only). GitHub also exposes
 * `gh`/`git` in the shell, and its events arrive via Rome's own GitHub webhook,
 * never a Composio trigger.
 */
export const ROME_MANAGED_TOOLKITS = new Set(["github", "slack"]);

export function isRomeManagedToolkit(toolkit: string): boolean {
  return ROME_MANAGED_TOOLKITS.has(toolkit.toLowerCase());
}

/**
 * The toolkits Rome exposes and can broker an OAuth connection for — the
 * server-side twin of the curated web catalog's slugs (`web/lib/connections.ts`).
 * Composio's tool search ranks across its *entire* catalog, including toolkits
 * with no OAuth path the owner could never authorize, so this set is the single
 * gate every entry point applies: `connector_search` filters its results to it,
 * and `connector_connect` / the dashboard connect route reject anything outside
 * it (rather than render a connect card that would dead-end at `ensureAuthConfig`).
 * A drift guard in `shared.test.ts` keeps this set equal to the catalog slugs.
 * Derived from the SDK's `SUPPORTED_CONNECTORS` so adding a connectable toolkit
 * in one place updates the gate, the web catalog, and the prompt injection at once.
 */
export const SUPPORTED_TOOLKITS = new Set(SUPPORTED_CONNECTORS.map((c) => c.toolkit));

export function isSupportedToolkit(toolkit: string): boolean {
  return SUPPORTED_TOOLKITS.has(toolkit.toLowerCase());
}

/**
 * The default provider API host per toolkit, derived from the SDK catalog's
 * `apiHost`. When a `connector_proxy` call omits `host`, Rome fills it from here
 * so the agent supplies only a relative `path` for the common single-host
 * toolkits — it never has to know or repeat the host. A toolkit whose host is
 * per-connection (Supabase's `<ref>.supabase.co`, which omits `apiHost` in the
 * catalog) has no entry here: those calls MUST pass `host` explicitly. The
 * optional `host` arg also overrides this default to reach a provider's secondary
 * host (Dropbox content `content.dropboxapi.com`, GitHub release uploads
 * `uploads.github.com`). Every value here is within its toolkit's
 * `TOOLKIT_API_HOSTS` allowlist, so a default-routed endpoint always clears
 * `validateProxyEndpoint` — `shared.test.ts` pins that invariant.
 */
export const TOOLKIT_DEFAULT_API_HOST: Record<string, string> = Object.fromEntries(
  SUPPORTED_CONNECTORS.filter((c) => c.apiHost).map((c) => [c.toolkit, c.apiHost as string]),
);

/**
 * The provider API domains each toolkit's credential may be sent to, keyed by
 * toolkit slug. `connector_proxy` injects the connection's live OAuth credential
 * into a request to a caller-supplied endpoint, so an unconstrained endpoint is a
 * credential-exfiltration vector: point it at an attacker host and the token
 * leaks. This allowlist is the gate — the resolved token is only ever forwarded
 * to one of its toolkit's own API domains (the URL host must equal a listed
 * domain or be a subdomain of one). Entries are registrable domains so a
 * provider's multiple API hosts (`gmail.googleapis.com`, `www.googleapis.com`, a
 * per-project `<ref>.supabase.co`) all resolve, while `googleapis.com.evil.com`
 * does not. Every SUPPORTED_TOOLKITS slug MUST have an entry — a drift guard in
 * `shared.test.ts` keeps the two in lockstep so a new toolkit can't ship a proxy
 * that fails open.
 */
export const TOOLKIT_API_HOSTS: Record<string, string[]> = {
  gmail: ["googleapis.com"],
  outlook: ["graph.microsoft.com"],
  googlecalendar: ["googleapis.com"],
  github: ["github.com"],
  slack: ["slack.com"],
  notion: ["notion.com"],
  googledrive: ["googleapis.com"],
  googlesheets: ["googleapis.com"],
  googledocs: ["googleapis.com"],
  googleslides: ["googleapis.com"],
  googleads: ["googleapis.com"],
  dropbox: ["dropboxapi.com", "dropbox.com"],
  linear: ["linear.app"],
  discord: ["discord.com"],
  linkedin: ["linkedin.com"],
  metaads: ["facebook.com"],
  supabase: ["supabase.co", "supabase.com"],
  neon: ["neon.tech"],
  hubspot: ["hubapi.com"],
  stripe: ["stripe.com"],
};

export type ProxyEndpointRejection =
  | { code: "invalid_url"; message: string }
  | { code: "insecure_scheme"; message: string }
  | { code: "unsupported_toolkit"; message: string }
  | { code: "host_not_allowed"; message: string };

/**
 * Fail-closed validation for a `connector_proxy` endpoint. Returns a rejection
 * (never throws) when the endpoint is anything other than an `https` URL whose
 * host belongs to the toolkit's allowlisted provider domains, so the connection's
 * credential can never be forwarded to an off-provider (attacker-controlled) host.
 * `null` means the endpoint is safe to call. Host matching is exact-or-subdomain
 * against a registrable domain, and uses the parsed `hostname` (not the raw
 * string), so userinfo tricks (`https://api.linear.app@evil.com`) resolve to the
 * real host (`evil.com`) and are rejected.
 */
export function validateProxyEndpoint(
  toolkit: string,
  endpoint: string,
): ProxyEndpointRejection | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return {
      code: "invalid_url",
      message: `endpoint "${endpoint}" is not a valid absolute URL.`,
    };
  }
  if (url.protocol !== "https:") {
    return {
      code: "insecure_scheme",
      message: `endpoint must use https; "${url.protocol.replace(/:$/, "")}" is not allowed.`,
    };
  }
  const allowed = TOOLKIT_API_HOSTS[toolkit.toLowerCase()];
  if (!allowed) {
    return {
      code: "unsupported_toolkit",
      message: `Rome can't proxy "${toolkit}" — no API host is allowlisted for it.`,
    };
  }
  const host = url.hostname.toLowerCase();
  const onProvider = allowed.some((domain) => host === domain || host.endsWith(`.${domain}`));
  if (!onProvider) {
    return {
      code: "host_not_allowed",
      message: `endpoint host "${host}" is not an API host for toolkit "${toolkit}". The connection's credential is only sent to: ${allowed.join(", ")}.`,
    };
  }
  return null;
}

export type BuildProxyEndpointResult =
  | { ok: true; endpoint: string }
  | { ok: false; message: string };

/**
 * Assemble a `connector_proxy` call's absolute endpoint from a relative `path`
 * and an optional `host`. Host precedence: the explicit `host` arg, else the
 * toolkit's default API host (`TOOLKIT_DEFAULT_API_HOST`). Fails (never throws,
 * mirroring `validateProxyEndpoint`) when `path` is a full URL rather than a
 * path, when `path` doesn't begin with "/", or when `host` is omitted for a
 * toolkit with no default (a per-connection host). The scheme is always forced to
 * `https` and any scheme/trailing slash the caller put on `host` is stripped. The
 * assembled URL is NOT the security gate — the caller still runs it through
 * `validateProxyEndpoint`, so a caller-supplied `host` is allowlist-checked like
 * any other endpoint host.
 */
export function buildProxyEndpoint(
  toolkit: string,
  path: string,
  host?: string,
): BuildProxyEndpointResult {
  const trimmedPath = path.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmedPath)) {
    return {
      ok: false,
      message: `path "${trimmedPath}" looks like a full URL — pass only the path (e.g. "/v1/messages") and, when the toolkit needs it, the host in the "host" arg.`,
    };
  }
  if (!trimmedPath.startsWith("/")) {
    return {
      ok: false,
      message: `path must be a relative path beginning with "/", e.g. "/v1/messages"; got "${trimmedPath}".`,
    };
  }
  const suppliedHost = host
    ?.trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  const resolvedHost = suppliedHost || TOOLKIT_DEFAULT_API_HOST[toolkit.toLowerCase()];
  if (!resolvedHost) {
    return {
      ok: false,
      message: `"${toolkit}" has no default API host (its host is per-connection) — supply the "host" arg, e.g. "<project-ref>.supabase.co".`,
    };
  }
  return { ok: true, endpoint: `https://${resolvedHost}${trimmedPath}` };
}

/** Guidance when the agent tries to connect a toolkit Rome can't broker — names
 *  it explicitly so the agent stops retrying a connect that can't succeed. */
export function unsupportedToolkitHint(toolkit: string): string {
  return `Rome can't connect "${toolkit}" — it isn't one of Rome's supported integrations. Pick a supported toolkit (e.g. gmail, slack, notion, linear, github) or ask the guardian to add it.`;
}

/** Guidance shown when the agent tries to connect a Rome-managed toolkit, or
 *  acts on one that isn't connected yet — points to the one place that owns it. */
export function romeManagedConnectHint(toolkit: string): string {
  return `${toolkit} is managed by Rome — it can't be connected from here. Ask the guardian to connect ${toolkit} in Settings → Connections.`;
}

/** Guidance for an agent that reached `connector_tool_execute` (Composio-only)
 *  for a Rome-managed toolkit. These have no Composio tools — they're driven by
 *  `connector_proxy` against the provider's native API with Rome's OAuth token. */
export function romeManagedToolExecuteHint(toolkit: string): string {
  return `${toolkit} is managed by Rome and has no Composio tools. Call the provider's native API with connector_proxy (toolkit "${toolkit}") instead. If it isn't connected yet, ask the guardian to connect ${toolkit} in Settings → Connections.`;
}

/** Guidance for an agent that reached a Composio surface for GitHub. GitHub has
 *  no Composio connection at all — it runs through Rome's own integration. */
export function githubViaRomeHint(): string {
  return 'GitHub does not run through Composio. Use the `gh` CLI or `git` in the shell, or `connector_proxy` with toolkit "github" for direct GitHub REST/GraphQL calls. If `gh`/`git` reports it is not authenticated, ask the guardian to connect GitHub at Settings → Connections.';
}

/**
 * Build a ComposioClient from the live CLI session key
 * (`~/.composio/user_data.json`) — the single source of truth for the Composio
 * credential. Returns null when the CLI isn't logged in so callers can surface a
 * "log in to Composio first" message instead of throwing on a missing
 * credential.
 */
export async function loadConnectorClient(): Promise<ComposioClient | null> {
  const apiKey = await readSessionApiKey();
  if (!apiKey) return null;
  return new ComposioClient({ apiKey });
}

export type SubscribeFeedErrorCode =
  | "unknown_trigger_slug"
  | "toolkit_mismatch"
  | "no_connected_account"
  | "ambiguous_connected_account";

export type SubscribeFeedResult =
  | { ok: true; eventName: string; triggerInstanceId: string }
  | { ok: false; code: SubscribeFeedErrorCode; message: string };

/**
 * Arm a Composio trigger so its events flow onto Rome's event bus, returning the
 * canonical `eventName` (topic) a routine binds to. This is the single
 * subscribe path shared by the `connector_event_subscribe` action and the
 * dashboard's `POST /feeds` route, so both enforce the same fail-closed checks.
 *
 * `expectedToolkit`, when given, is cross-checked against the trigger's
 * authoritative toolkit and a mismatch is rejected — the agent declares the
 * toolkit, so a slug that belongs elsewhere is a caller error, not something to
 * silently honor. `connectedAccountId` is auto-resolved from the toolkit when
 * omitted (one managed account per toolkit today); `none`/`ambiguous` fail loudly
 * rather than guessing which account to subscribe.
 */
export async function subscribeTriggerFeed(
  client: ComposioClient,
  input: {
    slug: string;
    config: Record<string, unknown>;
    expectedToolkit?: string;
    connectedAccountId?: string;
  },
): Promise<SubscribeFeedResult> {
  let triggerType;
  try {
    triggerType = await client.getTriggerType(input.slug);
  } catch (err) {
    if (isComposioNotFoundError(err)) {
      return {
        ok: false,
        code: "unknown_trigger_slug",
        message: `Composio does not recognize trigger slug "${input.slug}".`,
      };
    }
    throw err;
  }

  const provider = triggerType.toolkit.slug.toLowerCase();
  if (input.expectedToolkit && provider !== input.expectedToolkit.toLowerCase()) {
    return {
      ok: false,
      code: "toolkit_mismatch",
      message: `Trigger "${input.slug}" belongs to toolkit "${provider}", not "${input.expectedToolkit}". Re-run with the correct toolkit.`,
    };
  }

  let connectedAccountId = input.connectedAccountId;
  if (!connectedAccountId) {
    const resolved = await client.findActiveConnectedAccount(ROME_USER_ID, provider);
    if (resolved.kind === "none") {
      return {
        ok: false,
        code: "no_connected_account",
        message: isRomeManagedToolkit(provider)
          ? romeManagedConnectHint(provider)
          : `No active connected account for "${provider}" — run connector_connect for this toolkit first.`,
      };
    }
    if (resolved.kind === "ambiguous") {
      return {
        ok: false,
        code: "ambiguous_connected_account",
        message: `Multiple active connected accounts for "${provider}" (${resolved.ids.join(", ")}).`,
      };
    }
    connectedAccountId = resolved.id;
  }

  const created = await client.createTrigger(ROME_USER_ID, input.slug, {
    connectedAccountId,
    triggerConfig: input.config,
  });
  return {
    ok: true,
    eventName: buildTopic(provider, input.slug.toLowerCase()),
    triggerInstanceId: created.triggerInstanceId,
  };
}
