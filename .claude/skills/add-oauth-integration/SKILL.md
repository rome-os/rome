---
name: add-oauth-integration
description: Add a new Rome-managed OAuth integration for a third-party service so a user can delegate access by clicking Connect, and Rome can act on the service with the delegated token (the GitHub/Slack model — brokered by Pantheon, NOT Composio). Use when asked to "add an integration / connector for <service>", "let users connect their <service>", or "delegate <service> access to Rome". NOT for Composio-managed toolkits (those are a declarative catalog entry only — see rome_apps/connector), and NOT for inbound real-time events (that needs a central webhook broker; this skill is OAuth/API-only). Worked example to diff against: the Slack connector (PR #1225) and the GitHub connector already in-tree.
---

# Add an OAuth integration

Goal end-state: a user opens **Settings → Connections**, clicks **Connect <Service>**, approves on the provider's consent screen, and Rome ends up holding a delegated token it can use to call the provider's API on the user's behalf. This mirrors the existing **GitHub** and **Slack** integrations — "Rome-managed" providers brokered by Rome's own Pantheon OAuth, with **zero Composio involvement**.

Work the five phases in order. Don't skip Phase 1 (scoping) — the answers decide how much of Phases 4–5 you build.

The two reference implementations to read and mirror throughout:
- **GitHub** — the original Rome-managed provider (single token, has a CLI consumer).
- **Slack** — the most recent, closest template for a fresh service (two tokens, pure API consumer). PR #1225.

---

## Phase 1 — Scope the integration (convey the goal, lock the decisions)

Two things are fixed for this skill and need no confirmation: the integration is **OAuth-only** (act on the service via its API — real-time inbound events need a central webhook broker and are out of scope) and **Rome-managed** (our own Pantheon OAuth, direct API, with **no Composio connection** — never mix the two). State the goal back to the user in one sentence, then resolve the two gates that actually change the build **with the human**:

1. **How many tokens?** Some providers return one access token; some return more, each for different methods. Find out — it drives token storage and the proxy's token selection.
2. **Token rotation?** Default **off**. Rotation is often irreversible once enabled and adds refresh machinery; only opt in deliberately.

Capture the answers — they are the spec for everything below.

---

## Phase 2 — Learn the provider's delegation mechanism (read the docs)

Read the provider's OAuth documentation and produce a short "build guide" (a scratch doc is fine). Extract exactly these, because the adapter in Phase 4 needs every one:

- **Authorization endpoint** + params: scope format (space vs comma), `state`, `redirect_uri`, and **whether it uses PKCE** (many confidential-client flows don't — confirm, don't assume).
- **Token exchange**: endpoint, request encoding, and the **response shape** — where the access token is, refresh token, expiry, and any *extra* tokens the response carries beyond the primary one.
- **Connecting account's identity** — resolve two things for the consenting human: an opaque, stable **`subject`** that keys and dedups the connection (the machine identity), and a **human-readable handle** so a person can recognize which account is wired up (it's the label in Settings → Connections). The handle can come from an **OIDC `email` / `email_verified` claim** or a **provider-specific profile API** — find whichever the provider exposes (Google has the OIDC claim; GitHub uses `/user/emails`; Slack uses `users.info`). **Rome broker invariant:** the callback (`packages/pantheon/src/app/oauth/[provider]/callback/route.ts`) currently requires that handle to be a **verified email** specifically and rejects the handoff without one, so the adapter must *produce* `{email, emailVerified}` by whatever means fits — real claim, provider API, or a justified synthesis (Slack treats any returned email as verified, since it only admits verified members). **If the provider exposes no email at all** (handle-only services), that's a genuine blocker to raise, not a detail — the fix is a broker change (key on `subject` alone), not something the adapter can paper over. **Trap:** if the grant mints a service/bot/app identity distinct from the human who clicked Connect, the "whoami" call on the primary token returns the *service* identity (no email) — resolve the human instead (read the installing user's id from the token response held in `bundle.raw`, then call the user-profile endpoint) and use the human for `subject` too.
- **Scopes** needed for the capabilities you want, and which are sensitive.
- **Quirks**: e.g. an API that signals errors in the response body rather than the HTTP status; rate-limit headers; a required `https` redirect.

---

## Phase 3 — Tell the human what to register (and where it plugs in)

You can't register the provider app for them (their account, their consent). Produce a precise checklist — and, if the provider's console supports app manifests (many do), a manifest file the human imports; otherwise step-by-step console instructions. The human needs:

- **Create the app** in the provider's developer console.
- **Redirect URL** — a single, central Pantheon callback: `https://<PANTHEON_DOMAIN>/oauth/<provider>/callback`. It is **not** per-tenant and has **no wildcard** — Pantheon brokers all tenants through one origin (`getPantheonOrigin` + `/oauth/<provider>/callback` in `packages/pantheon/src/app/start/route.ts`). Register the prod origin; for local testing add the tunnel origin too (Phase 5).
- **Scopes** from Phase 2.
- **Client ID + Secret** → set in Pantheon env as `<PROVIDER>_OAUTH_CLIENT_ID` / `<PROVIDER>_OAUTH_CLIENT_SECRET` (read automatically by `packages/pantheon/src/lib/oauth/providers.ts`).
- **Public distribution** toggle if users beyond the dev workspace will install it.

---

## Phase 4 — Build it

Two halves: (a) obtain consent + exchange the token (the broker, in Pantheon + core), and (b) consume the token for API calls (the connector). Mirror GitHub/Slack file-for-file.

### 4a. Obtain consent & exchange the token

- **Pantheon adapter** — `packages/pantheon/src/lib/oauth/<provider>.ts` implementing `OAuthProviderAdapter` (`createAuthorizationUrl`, `exchangeCode`, `fetchProfile`). Copy `oauth/slack.ts` (two-token, no PKCE) or `oauth/google.ts` (PKCE, refresh) as the closer match. Map the primary token to `bundle.accessToken`; stash the full provider response (any extra tokens, team/workspace id) in `bundle.raw` — it survives the broker→instance handoff. `fetchProfile` must return a verified email.
- **Register the provider**: add `"<provider>"` to `OAUTH_PROVIDERS` in `packages/pantheon/src/lib/oauth-providers.ts`, to `PROVIDER_ADAPTERS` in `packages/pantheon/src/lib/oauth/providers.ts`, and document the env vars in `packages/pantheon/.env.example`.
- **Core provider list**: add `"<provider>"` + a descriptor to `packages/core/src/connections/oauth/oauth-providers.ts`. The broker, token storage, `/api/integrations`, connect/disconnect, and the per-tenant handoff are all provider-agnostic and light up automatically.
- **Deliver the token to the runtime** (only if the connector/agent needs it): `packages/core/src/lib/<provider>-shell-integration.ts` writes the token(s) to `/run/rome/<provider>-oauth-token` on connect and clears on disconnect (single string like GitHub, or JSON for multiple tokens like Slack). Wire `sync…ForProvider` into `packages/core/src/api/routes/oauth.ts` (redeem) and `clear…ForProvider` into `packages/core/src/api/routes/integrations.ts` (disconnect). Reference `slack-shell-integration.ts` / `github-shell-integration.ts`.

### 4b. Consume the token for API calls

- **Mark it Rome-managed**: add `"<provider>"` to `ROME_MANAGED_TOOLKITS` in `rome_apps/connector/src/shared.ts`, set `romeManaged: true` in `rome_apps/connector/src/web/lib/connections.ts`, and ensure the toolkit exists in the SDK `SUPPORTED_CONNECTORS` (`packages/app-runtime-sdk`) with a `TOOLKIT_API_HOSTS` entry (`shared.ts`).
- **Direct proxy**: `rome_apps/connector/src/api/<provider>-proxy.ts` reads the token file and exposes a `<provider>ProxyCall` (auth header, default API host). Add a branch in `rome_apps/connector/src/actions/connector-proxy/index.ts` that, for this toolkit, reads the token and calls the proxy — bypassing Composio. For multi-token services, select the token by endpoint (Slack: `search.*` → user token). Reference `slack-proxy.ts` / `github-proxy.ts`.
- **Connect card**: `rome_apps/connector/src/web/<provider>-connect-card.tsx` (drives core's `/api/integrations` OAuth inline), side-effect-imported in `rome_apps/connector/src/web/App.tsx`, listed under `components:` in `rome_apps/connector/app.yaml`, and rendered from a branch in `rome_apps/connector/src/actions/connector-connect/index.ts`. The card is currently copy-pasted per provider — **if you're adding the 3rd one, generalize it** into one `<RomeManagedConnectCard provider>` instead.
- `connector_tool_execute` already short-circuits any Rome-managed toolkit to a "use connector_proxy" hint — no change needed.

### File checklist (mirror of the Slack change set)

```
packages/pantheon/src/lib/oauth/<provider>.ts            NEW  adapter
packages/pantheon/src/lib/oauth-providers.ts             +    OAUTH_PROVIDERS
packages/pantheon/src/lib/oauth/providers.ts             +    adapter map
packages/pantheon/.env.example                           +    <PROVIDER>_OAUTH_CLIENT_ID/SECRET
packages/core/src/connections/oauth/oauth-providers.ts                 +    provider + descriptor
packages/core/src/lib/<provider>-shell-integration.ts    NEW  token-file write/clear (if runtime needs the token)
packages/core/src/api/routes/oauth.ts                    +    sync…ForProvider on redeem
packages/core/src/api/routes/integrations.ts             +    clear…ForProvider on disconnect
rome_apps/connector/src/shared.ts                        +    ROME_MANAGED_TOOLKITS (+ TOOLKIT_API_HOSTS if missing)
rome_apps/connector/src/api/<provider>-proxy.ts          NEW  token read + proxy call
rome_apps/connector/src/actions/connector-proxy/index.ts +    provider branch
rome_apps/connector/src/actions/connector-connect/index.ts +  provider branch → connect card
rome_apps/connector/src/web/<provider>-connect-card.tsx  NEW  inline connect card
rome_apps/connector/src/web/App.tsx                      +    import the card
rome_apps/connector/src/web/lib/connections.ts           +    romeManaged: true
rome_apps/connector/app.yaml                             +    component + version bump
```

---

## Phase 5 — Validate end-to-end

Run the **validate-oauth-integration** skill — it owns the full recipe (static + unit → a token-only smoke that proves Rome can *use* a token → the real consent round-trip that proves Rome can *obtain* one) and the local-only blockers. Report honestly which layers actually ran; the real round-trip needs a registered app, creds, and a human at the consent screen, so it's often where the human takes over.

One build-coupled heads-up before you hand off: adding the provider trips drift guards — the enabled-provider lists in `packages/core/src/connections/oauth/oauth-providers.test.ts` and the Rome-managed lists in `rome_apps/connector/src/web/lib/connections.test.ts`. Update both, and switch any test that used the service as a stand-in *Composio* toolkit to a still-Composio one (e.g. `notion`).

---

## Gotchas (these generalize to every provider — platform invariants + universal OAuth facts)

Service-specific quirks are deliberately NOT listed here — Phase 2 tells you to hunt for them per provider, and Phase 4 says where they land. Two we hit with Slack are examples of that category, not standing gotchas: an API that signals errors in the body rather than the HTTP status (Slack's `ok:false` at 200), and a provider that returns more than one token (stash extras in `bundle.raw`). These below are the ones that bite on *every* integration:

- **The verified-email gate** in the Pantheon callback silently fails the handoff if `fetchProfile` returns no verified email. This is a Rome broker invariant, not an OAuth2/OIDC guarantee — most providers can satisfy it (OIDC claim, provider API, or justified synthesis), but a handle-only provider with no email can't without a broker change. Confirm the provider has a usable email *before* building (Phase 2).
- **Resolve the *human's* email, not the app's** — the single most likely bug (it broke Slack's whole round-trip): when the grant produces a service/bot identity alongside the human, calling the provider's "whoami" on the primary token returns the bot, whose empty email trips the gate on *every* connect. Read the consenting human's profile instead, and distrust comments that *say* installer while the code reads the app identity (contract > impl).
- **A scope is a multi-surface contract, not just an adapter constant** — adding a scope to the adapter's list grants nothing on its own; the *registered provider app* (and its manifest) must also offer it, or the consent screen never asks for it. Change all three in one diff: the adapter scope list, the manifest artifact, and the live app in the provider console (the human-only step). Auditing the granted token (`auth.test`-equivalent shows the scopes it actually has) is the only proof the contract closed.
- **One central redirect URL**, not per-tenant — Pantheon routes all tenants through `https://<PANTHEON_DOMAIN>/oauth/<provider>/callback`. (Rome architecture.)
- **Redirect-scheme strictness varies and breaks local testing** — providers differ on whether they allow `http`/`localhost` redirects. The strict ones require `https`, which is why local Layer-2 testing fronts Pantheon with a tunnel (`ROME_DEV_PANTHEON_PUBLIC_ORIGIN`). Check each provider's policy before assuming the dev `http` origin works.
- **Don't assume PKCE** — it varies per provider (Google uses `code_challenge`, others don't). Copy the closest adapter, but verify rather than inherit it.
- **Generalize at the 3rd provider** — the connect card and the per-provider proxy/connect branches are copy-paste today; fold them into one generic Rome-managed path instead of a fourth copy. (Codebase, not service.)
