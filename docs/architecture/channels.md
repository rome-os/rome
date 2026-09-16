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

## WeChat personal account

WeChat has two connections. The `wechat` service is Tencent's official bot channel: it sends and receives, scoped to a bot. The `wechat_user` service is the guardian's own account, read through the official desktop client Rome runs in its own container, on the desktop it serves at `/desktop`.

The account's history is encrypted at rest with a key the client derives only at login and only ever holds in memory. Recovering it needs ptrace on the client as it signs in, which the container itself cannot do, so that one step runs as a root script on the hosting VM: host root enters the container's namespaces and launches the client under gdb, catches the key the first login derives, and hands back only the passphrase. Everything else — the client, the store, the reads — is unprivileged and local to the container.

### Invariants

- The personal account is read-only. Rome answers what a chat contains and has no way to post to the account. A surface that could post would be a different connection.
- A personal account's history is never delivered as inbound turns. An archive of every conversation the guardian has ever had is something to consult, not something to answer.
- Recovering the store key is the only privileged step, and it produces a passphrase, not standing access. The ledger records where the authority lives, never the key itself.
- Recovery launches the client under gdb rather than attaching to a running one. The key is derived once, at the first login, so owning the client from its first instruction lets a single login both sign the guardian in and yield the key — attaching after it is up would miss that derivation and demand a second login.
- A signed-out account and a client that is merely not running are different answers. Only the first invalidates the connection.
- A connect ceremony asks for the confirmations the client demands and no more. Retrying a login the client has already remembered invalidates it, which costs the guardian the whole ceremony again.
