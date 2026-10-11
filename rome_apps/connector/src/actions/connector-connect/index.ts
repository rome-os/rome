import {
  createAppLogger,
  defineAction,
  z,
  type Action,
  type ActionConfig,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";

import {
  composioActionError,
  isRomeManagedToolkit,
  isSupportedToolkit,
  loadConnectorClient,
  romeManagedConnectHint,
  unsupportedToolkitHint,
  ROME_USER_ID,
} from "../../shared.js";
import { ensureComposioWebhookRegistered } from "../../api/composio-webhook.js";
import { SettingsStore } from "../../api/settings-store.js";

const log = createAppLogger("connector_connect");

const inputSchema = z.object({
  toolkit: z
    .string()
    .min(1)
    .describe("Toolkit slug to connect, e.g. 'github', 'gmail', 'slack', 'supabase', 'neon'"),
});

export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps): Action {
  return defineAction({
    config,
    schema: inputSchema,
    execute: async ({ toolkit }) => {
      // Rome-brokered toolkits (e.g. GitHub) are connected via Rome's own
      // integration (Rome Cloud OAuth), not Composio. Never start a Composio OAuth
      // here — that would create a second, unmanaged connection, breaking the
      // single-integration rule. GitHub has an inline connect surface, so render
      // it: the card drives the same Rome Cloud OAuth the dashboard uses and resumes
      // the agent once GitHub reports connected. The OAuth round-trip and the
      // authoritative status check both reach core's /api/integrations directly —
      // the connector server can't see Rome Cloud's connection state, so they must
      // live in the browser component. A non-webchat surface that can't mount the
      // card falls back to `promptText` (the Settings → Connections hint). Once
      // connected, GitHub is driven through gh/git or connector_proxy — never
      // connector_tool_execute, which is Composio-only.
      if (isRomeManagedToolkit(toolkit)) {
        if (toolkit.toLowerCase() === "github") {
          // The unified connect card selects the Rome-managed (Rome Cloud OAuth)
          // adapter for github from the toolkit prop — same componentId the
          // Composio branch renders below, so there's one card for both brokers.
          return {
            status: "pending_interaction",
            interaction: {
              appId: "connector",
              promptText: romeManagedConnectHint(toolkit),
              render: { kind: "inline", componentId: "connect-card", props: { toolkit } },
            },
          };
        }
        return { status: "error", error: romeManagedConnectHint(toolkit) };
      }
      // Rome can only broker toolkits in its supported catalog — those are the
      // ones with a Composio managed auth config. connector_search exposes
      // Composio's full catalog, so reject an out-of-catalog slug here rather
      // than render an inline connect card that has no name/scope and would fail
      // at ensureAuthConfig. Runs before the sign-in check so an unsupported
      // toolkit fails the same way signed-in or out.
      if (!isSupportedToolkit(toolkit)) {
        return { status: "error", error: unsupportedToolkitHint(toolkit) };
      }
      const client = await loadConnectorClient();
      if (!client) {
        // Not signed in to Composio yet. Sign-in is account-wide (not
        // per-toolkit), so this action does NOT render its own sign-in card:
        // when an agent connects several toolkits in one turn, each call would
        // stack an identical login card. Instead point the agent at the single
        // connector_login action, which owns the one sign-in surface. The agent
        // re-runs connector_connect per toolkit after signing in.
        return {
          status: "error",
          error: `Not signed in to Composio. Call connector_login once to sign in, then re-run connector_connect with toolkit "${toolkit}" to authorize it.`,
        };
      }
      try {
        const existing = await client.findActiveConnectedAccount(ROME_USER_ID, toolkit);
        if (existing.kind === "ok") {
          try {
            await ensureComposioWebhookRegistered({
              client,
              appSettings: new SettingsStore(deps.appContext.db),
              settings: deps.appContext.repositories.settings,
            });
          } catch (err) {
            // Trigger delivery needs a registered webhook, but an existing
            // connection remains usable for Composio tool calls without one.
            log.warn("webhook registration failed; returning connected", {
              toolkit,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return { status: "ok", data: { toolkit, status: "connected" } };
        }
        if (existing.kind === "ambiguous") {
          // Two ACTIVE managed rows for one (guardian, toolkit) is a Composio
          // invariant violation the connect flow guards against — fail loud
          // rather than guess which connection to act on.
          return {
            status: "error",
            error: `Toolkit "${toolkit}" has ${existing.ids.length} active managed connections — resolve the duplicate in the Connector dashboard before reconnecting.`,
          };
        }
        // Not connected: render the inline connect card. It drives the OAuth
        // round-trip from the browser (provisioning the managed auth config and
        // opening the authorize tab via the `connectors` endpoint), then resumes
        // the agent once the toolkit reports ACTIVE. The round-trip is
        // request-host-coupled, so it must originate in the component, not here.
        return {
          status: "pending_interaction",
          interaction: {
            appId: "connector",
            promptText: `To connect ${toolkit}, open the Connector dashboard and click Connect for "${toolkit}" to authorize.`,
            render: { kind: "inline", componentId: "connect-card", props: { toolkit } },
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("connector add failed", { toolkit, error: message });
        return {
          status: "error",
          error: await composioActionError(
            client,
            err,
            `Could not prepare "${toolkit}" for connection`,
            `connector_connect with toolkit "${toolkit}"`,
          ),
        };
      }
    },
  });
}
