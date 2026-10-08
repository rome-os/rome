# Rome Cloud

Rome Cloud is the operator-run service that complements Rome instances. Where each Rome instance serves a single [guardian](people.md#guardian), Rome Cloud is the shared piece of infrastructure that sits in front of all of them.

It plays six roles:

- **Tenant provisioner** — provisions a Rome instance per paying user, manages domains and certificates.
- **Identity provider for instances** — authenticates a guardian against their Rome Cloud account when an instance signs in, and issues the durable instance credential ([Instance sign-in](#instance-sign-in)).
- **Third-party OAuth broker** — runs the start/callback flow for providers like Google or GitHub, then hands the access token to the requesting Rome instance via a PKCE-bound handoff ([OAuth handoff](#oauth-handoff)).
- **App store backend** — hosts the publicly available [app](apps.md#rome-apps) listings (see [App store](apps.md#app-store)).
- **Rome credits provider** — serves Codex through an inference gateway that bills the instance's Rome credits while the guardian's ChatGPT login is disconnected ([Rome credits](#rome-credits)).
- **Usage collector** — receives the usage a signed-in instance reports about its own turns, action runs, and guardian sign-ins ([Usage reporting](#usage-reporting)).

**Contracts:**

- A Rome instance degrades gracefully without Rome Cloud: only centralized provisioning, third-party OAuth, app-store installs, and usage delivery are lost. Everything local keeps working.
- The identity-provider role and the third-party OAuth broker role are distinct trust roots: the former authenticates *who owns this instance*, and never brokers a third-party provider token.
- App-store listings and versions obey the store contracts (immutability, monotonic SemVer, full retention) stated in [`apps.md`](apps.md#app-store).

**Not to be confused with:**

- **[Instance](deployment.md#instances)** — an instance is one deployment serving one guardian. Rome Cloud is the shared service in front of all of them.
- **[App store](apps.md#app-store)** — the store is one Rome Cloud-hosted surface, not the service itself.

## Instance sign-in

An instance authenticates its guardian to Rome Cloud over a standard OAuth 2.0 / OIDC surface: one front-channel `/oauth2/authorize` and one back-channel `/oauth2/token`. Sign-in yields a signed identity assertion, and an enrolling instance also receives its durable instance credential.

**Contracts:**

- Two endpoints, with the grant selected by scope — never one endpoint per flow variant. Scope `openid` returns the login assertion. Scope `openid instance:enroll` also mints the durable instance credential.
- A code minted for one scope can never be redeemed for another.
- Identity is a verifiable token. The assertion is asymmetrically signed, and the instance verifies it against the published JWKS, selecting the key by `kid` — so key rotation is additive, with no client change. The issuer is validated ([RFC 9207](https://www.rfc-editor.org/rfc/rfc9207) mix-up protection), and the subject is the authenticated account. No separate unsigned identity body exists to reconcile against a second lookup.
- Ownership is enforced at authorization. Rome Cloud issues a code only to the account that owns the instance, so a verified assertion names the confirmed owner and the instance performs no cross-account reconciliation.
- PKCE S256 is mandatory on every authorization, and codes are single-use.
- On an instance with no [guardian](people.md#guardian) seat, sign-in completes setup. The instance creates the seat, names the guardian from the assertion's `name` claim (falling back to the local part of its email), gives the agent a preset name and purpose, and marks setup complete. The guardian lands in the welcome conversation, which confirms both names and connects an AI provider.
- The durable instance credential is presented only to Rome Cloud, never to a service edge. Possession of it is the only way to act as the instance, and revoke is terminal ([decision](../adrs/no-rebind-from-public-instance-id.md)).

**Not to be confused with:**

- **Rome Cloud dashboard login** — the password or Google login with its own session cookie. Instance sign-in consumes that session at authorization and never replaces it.
- **[OAuth handoff](#oauth-handoff)** — the broker trust root. Sign-in asserts who owns the instance and never carries a provider token.

## OAuth handoff

The handoff is the last leg of brokered third-party OAuth: a short-lived, single-use code that the guardian's browser carries from Rome Cloud's consent flow to the requesting instance, which redeems it for the provider token on the back channel.

**Contracts:**

- The handoff is PKCE-bound. The instance holds the code verifier server-side, Rome Cloud stores only the challenge, and the browser carries only the code and `state`.
- Redemption is back-channel and authenticated by the instance credential, on the brokering endpoint — never on the identity endpoints ([decision](../adrs/separate-brokering-sts-over-shared-token-endpoint.md)).
- Rome Cloud releases the token only when the verifier hashes to the stored challenge, the redeeming instance belongs to the account the handoff was issued to, and the handoff is unexpired and unconsumed.
- No shared bearer service token exists: a leaked handoff URL is not sufficient to redeem a provider token.
- Every redemption rejection is `invalid_grant` on the wire, with a description naming the failed precondition.
- Provider tokens delivered by the handoff never leave the instance's backend ([why Rome Cloud holds the grant](../adrs/rome-cloud-held-delegated-grant-over-service-account-key.md)).
- Disconnecting a provider is instance-local: the instance deletes its token material, and the account-level grant Rome Cloud holds persists.

**Not to be confused with:**

- **[Instance sign-in](#instance-sign-in)** — the identity trust root. The handoff delivers a provider token and never asserts who owns the instance.
- **Sign-in links** — Rome Cloud-side records of which external account signs a user in. They hold no token and are independent of provider connections ([decision](../adrs/sign-in-links-separate-from-provider-connections.md)).

## Rome credits

Rome credits are an account-wide allowance that Rome Cloud serves through its inference gateway. An instance that has a Rome Cloud origin and an instance credential can run Codex on them.

**Contracts:**

- Codex has one payer for the whole instance, chosen from the guardian's ChatGPT login alone. A connected login pays. While it is disconnected, Rome credits pay when the instance has a Rome Cloud origin and a credential. A login whose token was revoked counts as disconnected, so credits pay until the guardian signs in to ChatGPT again. Usage limits and quota probes never change the payer.
- A payer change restarts Codex, which fails the turns running at that moment. A credential change restarts Codex only while Rome credits pay.
- A Codex turn waiting to start fails if Codex restarts under another payer first.
- Rome credits and a ChatGPT plan are two ways to pay for the same Codex models. A tier, a custom tier mapping, and a [model pin](sessions.md#model-pin) resolve to the same model under either payer, and credits run Sol and Luna without a plan entitlement. A tier prefers a connected Claude login over Rome credits.
- The gateway answers a used-up balance with `402 insufficient_credits`. The turn fails with `credits_used_up`. The instance does not check the balance before a turn.

## Usage reporting

A signed-in instance reports one usage event per [turn](sessions.md#turn), one per app or [routine](data.md#routines) action run, and one per guardian sign-in to Rome Cloud. A turn event carries its token counts, the model, who paid the provider, where the work came from, and what set it off. Rome Cloud joins turn events to the Rome credit charges its inference gateway recorded. The two sources stay separate ([decision](../adrs/instance-reported-usage-beside-credits-ledger.md)).

**Contracts:**

- Every turn the instance runs while signed in yields one turn event keyed by the turn id, failed and interrupted turns included. Subagent and fork turns are their own events.
- A turn event's kind is `chat`, `channel`, `app`, `routine`, or `other`. A subagent or fork turn takes the kind of its root session, read from session lineage when the event is recorded.
- An action run event covers a finished top-level action execution that a routine fired, that an app called itself, or that a webhook sent to an app's action. An agent's tool calls are not action runs. Turn events count their model work.
- Turn and action run events carry a trigger, which records what set the work off:
  - `user`: a person did. This covers a chat or channel message, an app call from a signed-in guardian or visitor session, and a routine's **Run now**.
  - `schedule`: a schedule or poll trigger fired a routine.
  - `event`: an event or webhook trigger fired a routine, or a webhook reached an app's action.
  - `background`: an app's own code ran with no person behind it. A guardian call over loopback (the agent or a CLI in the container) counts here, including a **Run now**. So does a sessionless call to an app, which may be a machine webhook or a person on a public page.
  - `unknown`: none of the above can be told.

  A turn takes the trigger of its root session's chain. A routine run records what fired it. A run recorded before runs stored that takes its routine's current trigger. A retried fire has no run of its own, so it takes the trigger shared by the routines with its name, or `unknown` when they differ.
- A login event records each time the guardian signs in to the instance. Its kind is the sign-in method: `password`, `onboard`, `oauth`, `handoff`, `rome_cloud`, or `rome_cloud_native` for the desktop and mobile apps. An OAuth redeem by a guardian who is already signed in connects a provider and is not a login.
- Funding is `rome_credits`, `byok`, `subscription`, or `unknown`, decided by the provider that served the turn.
- A Codex turn event carries Codex's own turn id. Codex sends the same id on every gateway request, which is the join key for credit charges.
- Events carry no prompt, output, contact, or routine name. An app appears as its App Store listing id or `first-party:<app id>`. Any other app appears as `local`.
- Events queue in the instance database and are delivered at least once. Rome Cloud stores each at most once. A turn, action run, or login that happens while the instance is signed out of Rome Cloud is not recorded, and neither is an action run that ends in the first minute after signing in. Signing in again makes the instance a new one in Rome Cloud, so events still queued from the earlier sign-in are dropped rather than reported under the new one. A queued event older than 30 days is dropped.
- Usage events never move money. Rome credit charges come only from the gateway's own ledger.
- The guardian cannot turn reporting off.

**Not to be confused with:**

- **Telemetry** — the OTEL traces and metrics in [observability](../architecture/observability.md) are aggregated operational signals with no delivery guarantee. Usage events are per-turn records that are delivered and deduplicated.
- **Rome credits usage** — the credits balance and recent gateway requests an instance reads from Rome Cloud. That ledger covers only gateway traffic, and usage events cover every funding source.
