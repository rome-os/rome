# Channels

How a [channel](../concepts/messaging.md#channels) is connected: the server-owned setup protocol every adapter goes through, and the rules that keep the connect flow generic across services.

## Connection setup

Every channel is connected through **one server-owned setup protocol** ([decision record](../adrs/server-owned-ceremonies-with-terminal-conferral.md)) — not a per-service connect flow. Per-service knowledge (which credentials a channel needs, how it probes them, what the guardian must do) lives in the integration descriptor the server drives. The client only pumps generic setup states and renders them.

### Invariants

- **Setup is uniform.** Enabling any channel drives the same generic surface (a conferral setup addressed by connection + grant). Setup proves provider credentials, while account pairing grants human authority. A connected bot can receive pairing requests before any account is linked to the guardian.
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

## Account pairing

An unknown Telegram, Discord, or Feishu account creates one expiring [approval](../concepts/messaging.md#approvals). The guardian resolves it in the authenticated Web UI, or the requesting account returns the displayed code in a private message.

### Invariants

- Unknown accounts cannot reach app handlers, automatic person matching, or agents before approval, even when reply settings include strangers. Eligible messages receive pairing guidance instead of entering conversation history. Existing linked accounts retain their permissions.
- Activity and Connections show the same approval record. Connections filters channel pairing approvals, and both surfaces share the confirmation and resolution behavior.
- Approval links the exact requesting account to the guardian and resolves the request in one transaction. A conflicting account link prevents approval rather than transferring ownership.
- Codes belong to one request, connection, channel, and sender. Verification messages never reach agents, including invalid or replayed codes from linked senders.
- Group messages cannot redeem a code. Group guidance points to a private bot conversation or authenticated Web approval without exposing the code.
- Requests expire after ten minutes without extending on repeated messages. Five wrong codes disable code verification while leaving Web approval available until expiry.
- The bot confirms pairing and tells the approved account it can start chatting. No blocked message is automatically replayed.
- Approval records retain creation and resolution. Web decisions record the verified guardian identity, and code decisions record the provider-authenticated account and completion method.
- Codes are absent from approval history and logs. Guidance and failed verification logs are best-effort telemetry, not the durable approval record.
- Provider-owned pairing, including WhatsApp device linking, retains its provider-specific proof of control.

Pairing admission creates requests for private messages, messages directed at the bot (mentions, replies, or bot-owned threads), and code attempts. Ambient group messages and Telegram channel identities create no pairing requests. Existing account mappings retain their normal routing.

Each connection permits at most 20 pending pairing requests and 100 new requests in a rolling 24-hour window. Repeated messages can still reuse an existing request at either limit. Deleting a connection or revoking a Talk grant supersedes its pending requests and invalidates their codes. Revoking an unrelated grant preserves pending requests. A guardian rejection retains its original cooldown.

Approval listing includes pending requests and the latest 100 resolved pairing records by default. Earlier pairing history is paged with `pairingHistoryOffset`. Activity provides the full history; Connections shows only active pending requests and links to Activity. Pagination preserves all stored audit records.
