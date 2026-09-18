import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { COOKIE_NAME, issueGuardianSession, verifySession } from "../../lib/auth.js";
import { getGuardianAuthState } from "../../lib/guardian-auth-state.js";
import {
  getEnabledOAuthProviders,
  isEnabledOAuthProvider,
  OAUTH_PROVIDER_DESCRIPTORS,
} from "../../lib/oauth-providers.js";
import {
  createRomeCloudOAuthStartRedirect,
  createRomeCloudOAuthStartUrl,
  redeemRomeCloudOAuthHandoff,
} from "../../lib/rome-cloud-oauth.js";
import { importProviderBundle } from "../../connections/providers-import.js";
import type { ApiDeps } from "../deps.js";

export function oauthRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get("/oauth/providers", async (c) => {
    const providers = getEnabledOAuthProviders().map((provider) => {
      const descriptor = OAUTH_PROVIDER_DESCRIPTORS[provider];
      const romeCloudLink = createRomeCloudOAuthStartUrl(provider);

      return {
        provider,
        label: descriptor.label,
        description: descriptor.description,
        connectUrl: romeCloudLink.connectUrl,
        available: romeCloudLink.available,
        unavailableReason: romeCloudLink.unavailableReason,
      };
    });

    c.header("Cache-Control", "no-store");
    return c.json({
      providers,
      // Back-compat with older dashboard clients: this field always reports `true`.
      encryptionConfigured: true,
    });
  });

  app.get("/oauth/:provider/start", async (c) => {
    const provider = c.req.param("provider");
    if (!isEnabledOAuthProvider(provider)) {
      return c.json({ error: "Unsupported provider." }, 404);
    }

    try {
      const reconnect = c.req.query("reconnect") === "1";
      const redirectUrl = await createRomeCloudOAuthStartRedirect(deps.db, provider, { reconnect });
      return c.redirect(redirectUrl, 303);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start OAuth flow.";
      return c.json({ error: message }, 503);
    }
  });

  app.post("/oauth/:provider/start", async (c) => {
    const provider = c.req.param("provider");
    if (!isEnabledOAuthProvider(provider)) {
      return c.json({ error: "Unsupported provider." }, 404);
    }

    try {
      const reconnect = c.req.query("reconnect") === "1";
      const redirectUrl = await createRomeCloudOAuthStartRedirect(deps.db, provider, { reconnect });
      c.header("Cache-Control", "no-store");
      return c.json({ redirectUrl });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start OAuth flow.";
      return c.json({ error: message }, 503);
    }
  });

  app.post("/oauth/redeem", async (c) => {
    const body = await c.req.json<{ handoff?: unknown; state?: unknown }>().catch(() => null);
    if (!body) {
      return c.json({ error: "Invalid request body." }, 400);
    }

    const handoff = typeof body.handoff === "string" ? body.handoff.trim() : "";
    const state = typeof body.state === "string" ? body.state.trim() : "";
    if (!handoff) {
      return c.json({ error: "handoff is required." }, 400);
    }
    if (!state) {
      return c.json({ error: "state is required." }, 400);
    }

    const guardian = await getGuardianAuthState(deps.db);
    if (!guardian.exists || !guardian.userId) {
      return c.json({ error: "Guardian account has not been created yet." }, 412);
    }

    try {
      const redeemed = await redeemRomeCloudOAuthHandoff(deps.db, handoff, state);

      // The grant ledger is the sole OAuth store: import the provider's bundle
      // into the grant so it holds both the connection state and the non-secret
      // conferral outcome (login, display name, email, avatar, scopes, Slack's
      // `teamId`) alongside the credential in one write. The grant transition
      // drives the registry's custody hook, which materializes the tmpfs token
      // file and gh/git shell auth fire-and-forget; the route never touches
      // those artifacts. Re-importing the same bundle is a no-op.
      //
      // Fail-closed: the ledger is the only place the credential lives, so an
      // import that doesn't land must fail the redeem — otherwise the response
      // would report connected while nothing holds the credential.
      //
      // A failed redeem fails the whole OAuth flow: `redeemRomeCloudOAuthHandoff`
      // has already spent the one-time handoff, so recovery is to re-initiate
      // Connect, not retry this call. We don't stage the bundle to make the
      // spent handoff replayable — the realistic failure (a bundle with no
      // usable token) needs a fresh authorization anyway.
      if (!deps.connectionRegistry) {
        throw new Error("Connection registry is unavailable; cannot record the conferral.");
      }
      // Default to an empty profile when the provider returned no identity, so the
      // grant still records a conferral outcome — scopes and Slack's teamId come
      // from the token bundle even when the identity fields are sparse.
      const imported = await importProviderBundle(
        deps.connectionRegistry,
        redeemed.provider,
        redeemed.tokens,
        redeemed.profile ?? {},
      );
      if (!imported) {
        throw new Error("OAuth redemption produced no usable credential for the grant ledger.");
      }

      // An already-signed-in guardian redeeming here is connecting a provider
      // (a sign-in redeem has no session yet), so land them on that connection's
      // own page — the surface that shows the grant it just conferred.
      const existingSession = verifySession(getCookie(c, COOKIE_NAME) ?? "");
      const nextPath = existingSession
        ? `/settings/connections/${encodeURIComponent(redeemed.provider)}`
        : guardian.onboardingComplete
          ? "/"
          : "/onboard";

      issueGuardianSession(c, guardian.userId);

      c.header("Cache-Control", "no-store");
      return c.json({
        ok: true,
        provider: redeemed.provider,
        nextPath,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "OAuth handoff redemption failed.";
      return c.json({ error: message }, 502);
    }
  });

  return app;
}
