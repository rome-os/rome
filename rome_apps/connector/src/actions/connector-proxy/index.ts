import {
  createAppLogger,
  defineAction,
  z,
  type Action,
  type ActionConfig,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";

import type { ProxiedResponse } from "../../api/composio-client.js";
import { githubProxyCall, readGithubOAuthToken } from "../../api/github-proxy.js";
import { readSlackOAuthTokens, slackProxyCall } from "../../api/slack-proxy.js";
import {
  buildProxyEndpoint,
  composioActionError,
  isRomeManagedToolkit,
  loadConnectorClient,
  romeManagedConnectHint,
  ROME_USER_ID,
  validateProxyEndpoint,
} from "../../shared.js";

const log = createAppLogger("connector_proxy");

const GITHUB_TOOLKIT = "github";
const SLACK_TOOLKIT = "slack";

/**
 * Map a verbatim upstream response to an ActionResult, fail-closed. The proxy
 * (Composio or Rome's own GitHub path) returns the provider's HTTP status, so a
 * non-2xx is the provider refusing the request (auth, validation, not-found).
 * Surfacing that as `status: "ok"` would let callers (and generated workflow code)
 * read `.data` and march on as if it worked, since the runAction contract treats
 * `status !== "ok"` as the only failure signal. Only a genuine 2xx returns `ok`,
 * carrying the provider's status, body, and headers as `data`.
 */
function mapProxyResponse(toolkit: string, method: string, endpoint: string, res: ProxiedResponse) {
  if (res.status < 200 || res.status >= 300) {
    return {
      status: "error" as const,
      error: `${toolkit} API returned ${res.status} for ${method} ${endpoint}: ${JSON.stringify(res.data)}`,
    };
  }
  return {
    status: "ok" as const,
    data: { status: res.status, data: res.data, headers: res.headers },
  };
}

const inputSchema = z.object({
  toolkit: z
    .string()
    .min(1)
    .describe(
      "Owning toolkit slug whose connected account authenticates the call, e.g. 'gmail', 'slack', 'linear'",
    ),
  path: z
    .string()
    .min(1)
    .describe(
      "Relative path of the provider's native API endpoint, beginning with '/', e.g. '/gmail/v1/users/me/messages', '/graphql', '/api/chat.postMessage'. Do NOT include the scheme or host — Rome prepends the toolkit's host (see `host`).",
    ),
  host: z
    .string()
    .optional()
    .describe(
      "Provider API host. Omit it for single-host toolkits — Rome fills in the toolkit's default host. Supply it only when the toolkit has no fixed host (Supabase's '<project-ref>.supabase.co') or to target a non-default host (Dropbox content 'content.dropboxapi.com', GitHub uploads 'uploads.github.com').",
    ),
  method: z
    .enum(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"])
    .describe("HTTP method for the request"),
  body: z
    .unknown()
    .optional()
    .describe(
      "JSON request body for POST/PUT/PATCH (a GraphQL { query } object, a REST payload, …)",
    ),
  query: z
    .record(z.string(), z.union([z.string(), z.number()]))
    .optional()
    .describe(
      "Query-string parameters as { name: value }, e.g. { profile: handle, limit: 10 }. Pass dynamic or step-sourced values HERE — never string-build them into the path (query-param injection).",
    ),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe("Extra request headers as { name: value }, e.g. { 'Notion-Version': '2022-06-28' }."),
});

export function createAction(config: ActionConfig, _deps: AppActionRuntimeDeps): Action {
  return defineAction({
    config,
    schema: inputSchema,
    execute: async ({ toolkit, path, host, method, body, query, headers }) => {
      // Assemble the absolute endpoint from the relative `path` + (optional)
      // `host`. For single-host toolkits Rome fills the host from its catalog; a
      // per-connection host (Supabase) must pass `host`. Done before any network
      // call or credential use, so a malformed path/host can't reach the token.
      const built = buildProxyEndpoint(toolkit, path, host);
      if (!built.ok) {
        return { status: "error", error: `Refusing to proxy: ${built.message}` };
      }
      const endpoint = built.endpoint;
      // Validate the assembled endpoint BEFORE any network call or credential use.
      // The proxy forwards the connection's live OAuth credential to `endpoint`, so
      // an off-provider host would exfiltrate the token — reject anything that
      // isn't an https URL on one of the toolkit's own API domains. This is the
      // gate even for a caller-supplied `host`. Fail-closed and ahead of the
      // sign-in check, so a malicious host can never reach the credential
      // regardless of session state.
      const rejection = validateProxyEndpoint(toolkit, endpoint);
      if (rejection) {
        return { status: "error", error: `Refusing to proxy: ${rejection.message}` };
      }

      // GitHub is brokered by Rome's own integration (Rome Cloud OAuth), not
      // Composio, so it proxies directly with the guardian's OAuth token instead
      // of going through a Composio managed connection. The endpoint has already
      // cleared the host allowlist above, so the token is only ever sent to a
      // github.com host.
      if (toolkit.toLowerCase() === GITHUB_TOOLKIT) {
        const token = await readGithubOAuthToken();
        if (!token) {
          return { status: "error", error: romeManagedConnectHint(toolkit) };
        }
        try {
          const res = await githubProxyCall({ token, endpoint, method, body, query, headers });
          return mapProxyResponse(toolkit, method, endpoint, res);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error("github proxy call failed", { endpoint, method, error: message });
          return { status: "error", error: `GitHub proxy call failed: ${message}` };
        }
      }

      // Slack is likewise brokered by Rome's own integration (Rome Cloud OAuth),
      // not Composio: core writes the credential to a token file on connect and
      // the connector proxies directly with the guardian's Slack OAuth token. The
      // endpoint has already cleared the host allowlist above, so the token is
      // only ever sent to a slack.com host.
      if (toolkit.toLowerCase() === SLACK_TOOLKIT) {
        const tokens = await readSlackOAuthTokens();
        if (!tokens) {
          return { status: "error", error: romeManagedConnectHint(toolkit) };
        }
        try {
          const res = await slackProxyCall({ tokens, endpoint, method, body, query, headers });
          // Slack returns HTTP 200 even on a logical failure — `ok: false` in the
          // body is the real signal. Fail closed on it (mirroring the non-2xx
          // mapping) so a refusal can't be read as success via `.data`.
          if (res.status >= 200 && res.status < 300) {
            const okFlag = (res.data as { ok?: unknown } | null)?.ok;
            if (okFlag === false) {
              const slackError = (res.data as { error?: unknown } | null)?.error;
              return {
                status: "error",
                error: `slack API returned ok:false for ${method} ${endpoint}: ${
                  typeof slackError === "string" ? slackError : JSON.stringify(res.data)
                }`,
              };
            }
          }
          return mapProxyResponse(toolkit, method, endpoint, res);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error("slack proxy call failed", { endpoint, method, error: message });
          return { status: "error", error: `Slack proxy call failed: ${message}` };
        }
      }

      const client = await loadConnectorClient();
      if (!client) {
        return {
          status: "error",
          error: `Not signed in to Composio. Call connector_login once to sign in, then re-run connector_proxy for "${endpoint}".`,
        };
      }
      try {
        // The proxy authenticates as the guardian's managed connected account, so
        // an unconnected toolkit can't call its API. Resolve it explicitly and
        // surface a clear "connect first" error rather than letting Composio
        // reject with an opaque message — and fail loud on the duplicate-connection
        // invariant violation, mirroring connector_tool_execute.
        const account = await client.findActiveConnectedAccount(ROME_USER_ID, toolkit);
        if (account.kind === "none") {
          return {
            status: "error",
            error: isRomeManagedToolkit(toolkit)
              ? romeManagedConnectHint(toolkit)
              : `Toolkit "${toolkit}" is not connected. Call connector_connect with toolkit "${toolkit}" first, then re-run connector_proxy.`,
          };
        }
        if (account.kind === "ambiguous") {
          return {
            status: "error",
            error: `Toolkit "${toolkit}" has ${account.ids.length} active managed connections — resolve the duplicate in the Connector dashboard before proxying calls.`,
          };
        }
        const res = await client.proxyTool({
          connectedAccountId: account.id,
          endpoint,
          method,
          body,
          query,
          headers,
        });
        return mapProxyResponse(toolkit, method, endpoint, res);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("proxy call failed", { toolkit, endpoint, method, error: message });
        return {
          status: "error",
          error: await composioActionError(
            client,
            err,
            "Composio proxy call failed",
            `connector_proxy for "${endpoint}"`,
          ),
        };
      }
    },
  });
}
