# Access Control

How a Rome instance decides who is on the other end of a request and what that request may reach. The surface has four components: the edge proxy, the verify probe behind it, the policies the probe reads, and the app-API dispatch. The callers themselves are concepts vocabulary — the [guardian](../concepts/people.md#guardian) and the [visitor](../concepts/people.md#visitor) — and the [single HTTP listener](api.md#http-surface) behind the edge is owned by `api.md`.

## Policies

Two policies decide reach, each held as its own setting:

- **App access** — per app: private (the default), link-public, or restricted to an email allow-list of visitors.
- **Dashboard access** — one email allow-list that grants approved visitors the full dashboard.

### Invariants

- Guardian and visitor credentials are never interchangeable: neither satisfies the other's check.
- A guardian seat bound to cloud sign-in has no local password, and password login fails closed for it.
- Making an app public never exposes the dashboard. The two policies are separate, and the public edge serves only the allow-listed app surfaces.
- An app manifest's no-auth declaration opens only that app's public webhook paths. The dashboard-side app surface stays gated regardless.

## Request flow

```
browser ──every request──► edge proxy ──consults──► verify probe ──reads──► in-memory policy state
                              │ allow                                            ▲ refresh
                              ▼                                          policy write handlers
                       backend route ──app-API dispatch──► app handler (caller re-derived)
```

The edge consults the probe on every proxied request and forwards or rejects on its answer. For a gated path, the probe passes a guardian session or an allow-listed [visitor](../concepts/people.md#visitor) and rejects everything else.

### Invariants

- The edge is fail-closed: every API path is private unless an explicit allow-list entry opens it. A newly added API route inherits the private default.
- The probe reads only in-memory policy state. Policy writes refresh that state, so no request-time database read exists and a policy change takes effect immediately.
- The static surface — the SPA shell and its assets — is public and carries no gated data. Everything gated lives behind the API.
- The app-API dispatch derives the [caller](../concepts/apps.md#caller-identity) from primary session material and strips inbound identity headers before a handler runs. An external caller cannot forge an identity.

## Visitor sign-in

A visitor gets their credential by signing in to their [Rome Cloud](../concepts/rome-cloud.md) account through a PKCE-bound authorization round trip. The instance never sees a password — only a one-time code it exchanges with Rome Cloud for the verified account identity. The dashboard arm normally starts by dispatch. When Rome Cloud refuses a guardian sign-in because the account does not own the instance ([ownership enforcement](../concepts/rome-cloud.md#instance-sign-in)), the instance re-routes the refusal into this flow. Without a dashboard allow-list, the refusal surfaces as a not-owner error instead.

### Invariants

- Sign-in starts only for an access-gated target: a link-public or email-restricted app, or the dashboard when its allow-list is non-empty.
- The PKCE verifier and the pending sign-in record stay server-side, single-use, and short-lived. The browser carries only the state echo and the returned code.
- The callback re-checks the allow-list after a successful Rome Cloud sign-in. Sign-in success alone never grants reach.
- The instance normalizes the post-sign-in redirect: an app-scoped sign-in returns only into that app, and a dashboard sign-in never lands on an API path.
- An account that does not own the instance can never leave the flow holding a guardian credential. The refusal downgrades to a visitor credential or an error, never upgrades.
