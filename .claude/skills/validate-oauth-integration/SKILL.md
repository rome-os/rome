---
name: validate-oauth-integration
description: Validate a Rome-managed OAuth integration end-to-end — prove a user can click Connect and Rome ends up holding a delegated token it can use to call the provider's API. Use when asked to "validate / test the <service> OAuth connector", "check that a user can connect <service>", or "verify the OAuth round-trip". This is the validation half of the GitHub/Slack model (brokered by Pantheon, NOT Composio). For *building* a new integration, run the add-oauth-integration skill first; this skill assumes the code already exists. NOT for Composio-managed toolkits and NOT for inbound webhook events.
---

# Validate an OAuth integration

Goal end-state proven: a user opens **Settings → Connections**, clicks **Connect <Service>**, approves on the provider's consent screen, and Rome holds a delegated token it can call the provider's API with. The recipe is **provider-agnostic** — only the creds and the registered redirect URL change per provider. Slack (PR #1225) is the worked example throughout.

Validate in three escalating layers. Run them in order; each is cheaper to debug than the next. Report honestly which layers actually ran — Layer 2 needs a registered app, creds, and a human at the consent screen, so it is often where the human takes over.

The cross-service round-trip Layer 2 exercises:

```
dashboard ──▶ core /api/oauth/<provider>/start ──▶ Pantheon /start
  ──▶ provider authorize (real consent) ──▶ Pantheon /oauth/<provider>/callback
  ──▶ exchangeCode + fetchProfile (verified-email gate) ──▶ broker handoff
  ──▶ dashboard /callback ──▶ core /oauth/redeem ──▶ token persisted + token file
```

---

## Layer 0 — Static + unit (host, fast)

- `pnpm typecheck` (all workspaces).
- Touched suites: the Pantheon adapter (`pnpm --filter rome-pantheon exec vitest run src/lib/oauth`), the core provider lists (`pnpm --filter @rome/core exec vitest run src/connections/oauth/oauth-providers.test.ts`), and the connector (`pnpm --filter @rome/app-connector exec vitest run`) if the token-consumer half exists.
- **Update the drift guards** the new provider trips: the enabled-provider lists in `packages/core/src/connections/oauth/oauth-providers.test.ts` and the Rome-managed lists in `rome_apps/connector/src/web/lib/connections.test.ts`. Any test that used the service as a stand-in *Composio* toolkit must switch to a still-Composio one (e.g. `notion`).

## Layer 1 — Token usage, no OAuth dance (fast confidence in the consumer code)

Mint a token out-of-band and prove Rome can *use* it, decoupled from the consent flow:

- In the provider's developer console, "Install to Workspace" (or equivalent) to mint a token without the redirect flow.
- Write it into the rome container by hand at `/run/rome/<provider>-oauth-token` (single string, or JSON for multi-token services like Slack's `{botToken,userToken,teamId}`).
- Ask the agent to run `connector_proxy` against a read endpoint (an `auth.test`-equivalent) and a write endpoint.

This isolates the proxy/token-selection code from the broker, so a failure here is unambiguously in the consumer half.

## Layer 2 — The real delegation round-trip (proves Rome can *obtain* a token)

### The one hard constraint: https redirect

Most providers (Slack among them) **only accept `https` redirect URLs** — no `http`, not even `localhost`. The dev stack's local Pantheon is served over `http://pantheon.<slug>.rome.localhost:3000`, which the provider rejects. Front it with an https tunnel for the test. (GitHub is the exception — it allows `http` redirects, so its leg works in plain `dev:all`.)

### Prerequisites

- The provider app registered, with **client id/secret** and a redirect URL you can point at the tunnel.
- A tunnel that yields an https URL: `cloudflared` (free quick tunnels, no account) or `ngrok`.
- Docker + the `dev:all` stack (see root `CLAUDE.md` dev-loop).

### Steps

1. **Put the provider creds in the Pantheon env** — `packages/pantheon/.env`:
   ```
   <PROVIDER>_OAUTH_CLIENT_ID=...
   <PROVIDER>_OAUTH_CLIENT_SECRET=...
   ```
   `pantheon-web` reads this file at (re)start. The `env_file` is baked at container *create* — a `restart` won't pick up edits; re-run `dev:all` to recreate.

2. **Open an https tunnel to this stack's Pantheon.** Find your slug (`docker ps --format '{{.Names}}' | grep pantheon` → `<slug>-pantheon-web-1`), then forward to Traefik with the Pantheon host header so routing still resolves:
   ```bash
   cloudflared tunnel --url http://localhost:3000 \
     --http-host-header pantheon.<slug>.rome.localhost
   ```
   Note the printed `https://<random>.trycloudflare.com` — that's `<tunnel-host>`. (A named tunnel / reserved domain gives a stable host so you don't re-edit the redirect URL every session.)

3. **Register the tunnel callback** in the provider app's redirect URLs: `https://<tunnel-host>/oauth/<provider>/callback`. Providers allow several — keep the prod one too. Remove the trycloudflare entry when you're done.

4. **Boot the stack pointed at the tunnel:**
   ```bash
   ROME_DEV_PANTHEON_PUBLIC_ORIGIN=https://<tunnel-host> pnpm dev:all
   ```
   Wait for the rome container to log `Rome started`. This keeps the per-stack local Pantheon (and its in-cluster redeem) but advertises the tunnel as the browser-facing origin, so the `redirect_uri` Pantheon emits is the https URL the provider accepts.

5. **Connect.** Open the dashboard (`http://<slug>.rome.localhost:3000`) → **Settings → Connections → Connect <Service>** (or ask the agent). Approve on the consent screen.

### Two local-only blockers the happy path hides

- **`/start` needs a Pantheon session.** Local Pantheon has no Google login, and the seeded-dev-owner fallback covers only enrollment (`/instance/authorize`), NOT the OAuth broker `/start`. Enable the password form (`PANTHEON_LEGACY_LOGIN_CODE` env → `/login?legacy=<code>`) and sign in as the seeded dev owner **at the tunnel origin** (the session cookie is per-origin) before clicking Connect — otherwise `/start` bounces you to `/login` and the dance never begins.
- **The token write fails *after* the email gate passes if `/run/rome` is read-only.** The daemon runs uid 501; the `/run/rome` tmpfs must be world-writable (`mode=1777` in `compose.dev.yml`) or redeem throws `EACCES` once it reaches the file write — a confusing "everything worked then died at the very end" symptom. Runtime unblock without recreate: `docker exec -u 0 <rome> chmod 1777 /run/rome`.

### Verifying success

- **UI / API:** the Connect card flips to "<Service> connected"; `GET /api/integrations` lists the provider with `connected: true` **and the connected account's email is the human who consented** — not a bot/service identity. (If it shows an empty or service email, `fetchProfile` is resolving the wrong identity — see the add-oauth-integration skill's installer-identity trap.)
- **Token persisted to the instance** (the file the connector reads):
  ```bash
  ROME=$(docker ps --format '{{.Names}}' | grep rome-1)
  docker exec "$ROME" cat /run/rome/<provider>-oauth-token
  ```
- **Round-trip works:** in chat, have the agent call `connector_proxy` against a read endpoint (e.g. Slack `path: "/api/auth.test", method: "POST"`) → expect the provider's success signal (`ok: true`). For multi-token services, also exercise an endpoint that needs the *secondary* token (Slack: `search.messages` needs the user token, not the bot token).
- **Scopes actually granted:** the `auth.test`-equivalent (or the token-introspection endpoint) shows the scopes the token really carries. This is the only proof that a scope you added to the adapter was also offered by the registered app and granted at consent — code-side scope lists are not self-proving.

---

## Cleanup

Leave no test residue: remove the tunnel redirect URL from the provider app, bring the stack down, kill the tunnel, and delete any temporary browser profile copy used to drive the consent screen.
