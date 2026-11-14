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
import { connectWidget } from "../../connect-widget.js";

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
      // Rome-brokered toolkits (GitHub, Slack, Shopify) are connected by Rome
      // itself, through core's own connect_account tool and card. Never start a
      // Composio OAuth here: that would create a second, unmanaged connection.
      if (isRomeManagedToolkit(toolkit)) {
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
      const client = await loadConnectorClient(deps.appContext.db);
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
            error: `Toolkit "${toolkit}" has ${existing.ids.length} active managed connections — resolve the duplicate in Settings › Connections before reconnecting.`,
          };
        }
        // Not connected: show the connect card. Its presses go to this app's
        // API through core, which starts the OAuth and checks the connection;
        // the app's reply answers the agent once the toolkit is connected.
        return { status: "show_widget", widget: connectWidget(toolkit) };
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
