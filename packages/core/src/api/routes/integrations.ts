import { Hono } from "hono";
import { isSameOriginMutationRequest } from "../../lib/mutation-origin.js";
import { isEnabledOAuthProvider } from "../../lib/oauth-providers.js";
import { getComposioStatus, logoutComposio, startComposioLogin } from "../../lib/composio-cli.js";
import {
  RELAY_SETTING_KEY,
  buildRelayStatus,
  deriveDepositUrl,
  resolveRelayDrains,
  sanitizeDrainUrl,
  type RelayDrainSetting,
} from "../../relay/settings.js";
import type { ApiDeps } from "../deps.js";

// The instance-level integration surfaces that are NOT connections: the Watch
// relay ingress and the Composio account broker, plus the OAuth provider-token
// gate. Connection state itself lives on `/api/connections`, and OAuth
// connect/reconnect run through the setup surface.
export function integrationsRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  // Relay status alone — pollable by the dashboard health widget.
  app.get("/integrations/relay", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      relay: await buildRelayStatus(deps.settingsRepo, deps.relayDrainer, deps.appCatalog),
    });
  });

  // A bounded local delivery retry leaves the lowest un-acked event blocked
  // rather than churning the WebSocket forever. The guardian can re-arm that
  // event after fixing the local receiver; the relay never loses the payload.
  app.post("/integrations/relay/resume", async (c) => {
    if (!isSameOriginMutationRequest(c.req.raw)) {
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    }

    const resumed = deps.relayDrainer.resumeBlocked();
    c.header("Cache-Control", "no-store");
    return c.json({
      ok: true,
      resumed,
      relay: await buildRelayStatus(deps.settingsRepo, deps.relayDrainer, deps.appCatalog),
    });
  });

  // Webhook relay drainer config. The guardian provides the mailbox connect URL
  // + drain key (via Rome Cloud provisioning, or a manual paste where provisioning
  // isn't available). The delivery target is NOT set here — core resolves it
  // from whichever installed app declares `api.relayWebhook` (resolveRelayTarget),
  // so the relay stays app-neutral. Saving hot-reloads the live WS connection —
  // `reloaded:false` signals a restart is needed, mirroring the channels flow.
  app.put("/integrations/relay", async (c) => {
    if (!isSameOriginMutationRequest(c.req.raw)) {
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    }

    const body = await c.req
      .json<{ drainUrl?: string; drainKey?: string }>()
      .catch(() => ({}) as { drainUrl?: string; drainKey?: string });
    const drainUrl = body.drainUrl?.trim();
    const drainKey = body.drainKey?.trim();
    if (!drainUrl || !drainKey) {
      return c.json({ error: "Both the relay connect URL and drain key are required." }, 400);
    }
    if (!/^wss?:\/\//i.test(drainUrl)) {
      return c.json({ error: "Relay connect URL must be a ws:// or wss:// URL." }, 400);
    }

    // The deposit face is the same mailbox at /h/{id}; derive it from the drain
    // URL so the manual-paste path still only asks for the two drain fields. A
    // URL whose path can't be mapped to a deposit face is a bad paste — 400, not 500.
    let depositUrl: string;
    try {
      depositUrl = deriveDepositUrl(drainUrl);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    // Persist the bare drain URL — the credential lives in `drainKey` (the
    // drainer presents it as a bearer header), so a pasted `?t=secret` must not
    // be stored.
    const setting: RelayDrainSetting = {
      drainUrl: sanitizeDrainUrl(drainUrl),
      drainKey,
      depositUrl,
    };
    await deps.settingsRepo.set(RELAY_SETTING_KEY, setting);

    // `reloaded` reflects the live connection actually being rebuilt.
    let reloaded = false;
    let reloadError: string | undefined;
    try {
      await deps.relayDrainer.reload(await resolveRelayDrains(deps.settingsRepo, deps.appCatalog));
      reloaded = true;
    } catch (err) {
      reloadError = err instanceof Error ? err.message : String(err);
    }

    c.header("Cache-Control", "no-store");
    return c.json({
      ok: true,
      relay: await buildRelayStatus(deps.settingsRepo, deps.relayDrainer, deps.appCatalog),
      reloaded,
      reloadError,
    });
  });

  app.post("/integrations/relay/disconnect", async (c) => {
    if (!isSameOriginMutationRequest(c.req.raw)) {
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    }

    await deps.settingsRepo.delete(RELAY_SETTING_KEY);
    try {
      await deps.relayDrainer.reload([]);
    } catch {
      // The stored setting is already cleared; the stale connection drops on
      // its own when the socket next closes.
    }

    c.header("Cache-Control", "no-store");
    return c.json({
      ok: true,
      relay: await buildRelayStatus(deps.settingsRepo, deps.relayDrainer, deps.appCatalog),
    });
  });

  app.get("/integrations/composio/status", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ composio: await getComposioStatus() });
  });

  app.post("/integrations/composio/login", async (c) => {
    if (!isSameOriginMutationRequest(c.req.raw)) {
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    }

    try {
      const { loginUrl, status } = await startComposioLogin();
      c.header("Cache-Control", "no-store");
      return c.json({ loginUrl, composio: status });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start Composio login.";
      return c.json({ error: message }, 500);
    }
  });

  app.post("/integrations/composio/logout", async (c) => {
    if (!isSameOriginMutationRequest(c.req.raw)) {
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    }

    try {
      c.header("Cache-Control", "no-store");
      return c.json({ composio: await logoutComposio() });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to log out of Composio.";
      return c.json({ error: message }, 500);
    }
  });

  app.get("/integrations/:provider/tokens", async (c) => {
    const provider = c.req.param("provider");
    if (!isEnabledOAuthProvider(provider)) {
      return c.json({ error: "Unsupported provider." }, 404);
    }

    c.header("Cache-Control", "no-store, private");
    return c.json({ error: "Provider tokens are only available to server-side code." }, 403);
  });

  // OAuth reconnect on a degraded grant is just re-running the grant
  // setup (its begin-redirect always forces fresh consent) — the dashboard
  // drives it through the generic setup surface, not a route here.

  return app;
}
