# Rome Cloud

Rome Cloud is the operator-run service that complements Rome instances. Where each Rome instance serves a single [guardian](people.md#guardian), Rome Cloud is the shared piece of infrastructure that sits in front of all of them.

It plays four roles:

- **Tenant provisioner** — provisions a Rome instance per paying user, manages domains and certificates.
- **Identity provider for instances** — authenticates a guardian against their Rome Cloud account when an instance signs in, and issues the durable instance credential ([Instance sign-in](#instance-sign-in)).
- **Third-party OAuth broker** — runs the start/callback flow for providers like Google or GitHub, then hands the access token to the requesting Rome instance via a PKCE-bound handoff ([OAuth handoff](#oauth-handoff)).
- **App store backend** — hosts the publicly available [app](apps.md#rome-apps) listings (see [App store](apps.md#app-store)).

**Contracts:**

- A Rome instance degrades gracefully without Rome Cloud: only centralized provisioning, third-party OAuth, and app-store installs are lost. Everything local keeps working.
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
