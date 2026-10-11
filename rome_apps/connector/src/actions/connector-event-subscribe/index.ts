import {
  createAppLogger,
  defineAction,
  z,
  type Action,
  type ActionConfig,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";

import { composioActionError, loadConnectorClient, subscribeTriggerFeed } from "../../shared.js";
import { ensureComposioWebhookRegistered } from "../../api/composio-webhook.js";
import { SettingsStore } from "../../api/settings-store.js";

const log = createAppLogger("connector_event_subscribe");

const inputSchema = z.object({
  toolkit: z
    .string()
    .min(1)
    .describe("Owning toolkit slug of the trigger, e.g. 'gmail', 'github', 'slack'"),
  slug: z
    .string()
    .min(1)
    .describe(
      "Trigger slug to subscribe to, e.g. 'GMAIL_NEW_GMAIL_MESSAGE' (from connector_event_search)",
    ),
  config: z
    .record(z.string(), z.unknown())
    .describe(
      "Trigger configuration matching the `config` schema from connector_event_schema; pass {} when none is required",
    ),
});

export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps): Action {
  return defineAction({
    config,
    schema: inputSchema,
    execute: async ({ toolkit, slug, config: triggerConfig }) => {
      // GitHub events don't run through Composio — Rome registers its own webhook.
      // Redirect to the dedicated action rather than attempting a Composio trigger
      // that has no connected account to arm.
      if (toolkit.toLowerCase() === "github") {
        return {
          status: "error",
          error:
            "GitHub events don't run through Composio. Use connector_github_subscribe with a repo ('owner/name') or org and the events you want — it registers Rome's own GitHub webhook.",
        };
      }
      const client = await loadConnectorClient();
      if (!client) {
        return {
          status: "error",
          error: `Not signed in to Composio. Call connector_login once to sign in, then re-run connector_event_subscribe for "${slug}".`,
        };
      }
      try {
        await ensureComposioWebhookRegistered({
          client,
          appSettings: new SettingsStore(deps.appContext.db),
          settings: deps.appContext.repositories.settings,
        });
        const result = await subscribeTriggerFeed(client, {
          slug,
          config: triggerConfig,
          expectedToolkit: toolkit,
        });
        if (!result.ok) {
          return { status: "error", error: result.message };
        }
        return {
          status: "ok",
          data: { eventName: result.eventName, triggerInstanceId: result.triggerInstanceId },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("event subscribe failed", { slug, toolkit, error: message });
        return {
          status: "error",
          error: await composioActionError(
            client,
            err,
            "Composio trigger subscribe failed",
            `connector_event_subscribe for "${slug}"`,
          ),
        };
      }
    },
  });
}
