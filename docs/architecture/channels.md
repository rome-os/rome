# Channels

How a [channel](../concepts/messaging.md#channels) is connected: the server-owned setup protocol every adapter goes through, and the rules that keep the connect flow generic across services.

## Connection setup

Every channel is connected through **one server-owned setup protocol** ([decision record](../adrs/server-owned-ceremonies-with-terminal-conferral.md)) — not a per-service connect flow. Per-service knowledge (which credentials a channel needs, how it probes them, what the guardian must do) lives in the integration descriptor the server drives. The client only pumps generic setup states and renders them.

### Invariants

- **Setup is uniform.** Enabling any channel drives the same generic surface (a conferral setup addressed by connection + grant). There is no bespoke per-service connect, pairing, or `verify-status` route — a channel that reads connected was guardian-linked during the setup's terminal write, so nothing polls a separate status endpoint afterward.
- **The dashboard renders setups generically.** The connect UI is a single standard renderer plus a small set of registered custom components for the few steps that need bespoke presentation (e.g. rendering a QR image). Adding a channel adds neither a connect route nor a per-service connect card.
- **Post-connection configuration is not setup.** Config and feature surfaces that operate *after* a channel is linked — Discord per-channel agent routing, the Telegram personal-account dialog list — live under their own named routes, separate from the setup protocol and never part of connecting.

## LinkedIn replies

LinkedIn replies use the shared [People outbox](../concepts/people.md#outbox) and the browser session that reads the inbox.

### Invariants

- A reply addresses an existing direct conversation. Missing, incomplete, group, or ambiguous membership cannot authorize a send.
- Before sending, LinkedIn must confirm both the recipient and the sending account by member id. A display name cannot establish either identity.
- A send receipt and a history read identify the same provider message. A successful click or a matching message body cannot establish acceptance.
- Once LinkedIn accepts a reply, a local mirror failure cannot turn it into a failed send. Unknown send outcomes require an explicit retry.
- A retry keeps the original conversation. A changed destination requires a new reply.
