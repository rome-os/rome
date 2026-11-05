// The live WatchEnv: this app's runtime, its relay mailbox, and Composio
// signed in as Rome. Every adapter reaches the outside through it, so tests
// pass a fake one and need no service.

import type { AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { composioWebhookTarget, ensureComposioWebhookRegistered } from "../api/composio-webhook.js";
import { keptActiveTriggers } from "../api/active-triggers.js";
import { resolveRelayDepositUrl } from "../api/relay-webhook.js";
import { SettingsStore } from "../api/settings-store.js";
import { loadConnectorClient, ROME_USER_ID, subscribeTriggerFeed } from "../shared.js";
import { armsWatch } from "./shared/composio.js";
import type { ComposioEnv, ComposioToolkit, WatchEnv } from "./types.js";

type ComposioClient = NonNullable<Awaited<ReturnType<typeof loadConnectorClient>>>;

async function connectedAccount(
  service: ComposioToolkit,
): Promise<{ client: ComposioClient; id: string }> {
  const client = await loadConnectorClient();
  if (!client) throw new Error("Rome is not signed in to Composio.");
  const resolved = await client.findActiveConnectedAccount(ROME_USER_ID, service.toolkit);
  if (resolved.kind !== "ok") throw new Error(`No ${service.label} account is connected.`);
  return { client, id: resolved.id };
}

function composioEnv(deps: AppActionRuntimeDeps): ComposioEnv {
  return {
    signedIn: async () => (await loadConnectorClient()) !== null,
    accounts: async () => {
      const client = await loadConnectorClient();
      if (!client) return [];
      return (await client.listConnectedAccounts(ROME_USER_ID)).map((account) => ({
        toolkit: account.toolkitSlug.toLowerCase(),
        status: account.status.toUpperCase(),
      }));
    },
    accountId: async (service) => (await connectedAccount(service)).id,
    async read(service, request) {
      const { client, id } = await connectedAccount(service);
      const res = await client.proxyTool({
        connectedAccountId: id,
        endpoint: request.endpoint,
        method: request.method ?? "GET",
        ...(request.body !== undefined ? { body: request.body } : {}),
        ...(request.headers ? { headers: request.headers } : {}),
        ...(request.query ? { query: request.query } : {}),
      });
      if (res.status < 200 || res.status >= 300 || !res.data || typeof res.data !== "object") {
        throw new Error(`${service.label} answered ${res.status}`);
      }
      return res.data as Record<string, unknown>;
    },
    activeTriggers: async () => {
      const client = await loadConnectorClient();
      if (!client) throw new Error("Rome is not signed in to Composio.");
      return keptActiveTriggers(client);
    },
    webhookTarget: async () =>
      composioWebhookTarget({
        client: await loadConnectorClient().catch(() => null),
        settings: deps.appContext.repositories.settings,
      }),
    // Arming also points Composio's webhook at this Rome's relay mailbox. A
    // check answers `active` only when every trigger is armed; arming answers
    // `created` when it armed any.
    async ensureTriggers(service, specs, dryRun) {
      let account: Awaited<ReturnType<typeof connectedAccount>>;
      try {
        account = await connectedAccount(service);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (!(await resolveRelayDepositUrl(deps.appContext.repositories.settings))) {
        return {
          ok: false,
          error: `This Rome has no relay mailbox, so ${service.label} events cannot reach it.`,
        };
      }
      const active = await account.client.listActiveTriggers();
      const missing = specs.filter(
        (spec) => !active.some((trigger) => armsWatch(trigger, spec, account.id)),
      );
      if (dryRun) return { ok: true, subscription: missing.length === 0 ? "active" : "inactive" };
      await ensureComposioWebhookRegistered({
        client: account.client,
        appSettings: new SettingsStore(deps.appContext.db),
        settings: deps.appContext.repositories.settings,
      });
      for (const spec of missing) {
        const result = await subscribeTriggerFeed(account.client, {
          slug: spec.slug,
          config: spec.config,
          expectedToolkit: service.toolkit,
          connectedAccountId: account.id,
        });
        if (!result.ok) return { ok: false, error: result.message };
      }
      return { ok: true, subscription: missing.length > 0 ? "created" : "existing" };
    },
  };
}

export function liveWatchEnv(deps: AppActionRuntimeDeps): WatchEnv {
  return {
    app: deps,
    relayDepositUrl: () => resolveRelayDepositUrl(deps.appContext.repositories.settings),
    composio: composioEnv(deps),
  };
}
