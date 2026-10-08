# Channels

How a [channel](../concepts/messaging.md#channels) is connected: the server-owned setup protocol every adapter goes through, and the rules that keep the connect flow generic across services.

## Channel ports

A channel is its name plus four ports: `send`, `inbound`, `accounts` and `messages` ([`Channel`](../../packages/core/src/channels/channel.ts)). Inside core, a channel also has a `directory` of the conversations it can see. A Connection is not a channel. A service's Talk may back a channel's `send`, `inbound`, `messages` and `directory`, and Rome's own synced tables may back its `accounts` and `messages`, but what backs a port is incidental to the channel ([decision record](../adrs/channels-and-connectors-are-one-connection.md#amendment-2026-09-28-a-channel-is-not-a-connection)).

### Invariants

- The name is the identity. Every stored row, link and message spells the channel by it.
- Every port may be null, and callers read null as the answer. A present port is what the channel can do, not a promise that it is doing it now: a send nothing currently backs rejects, and an inbound subscription taken before anything backs it hears the first event once something does.
- A channel's lifecycle is not part of the channel. Connecting, disconnecting and degradation belong to whatever backs a port.
- Inbound runs the channel's admission before any subscriber hears an event. On a channel that pairs accounts ([Account pairing](#account-pairing)), pairing codes and messages from accounts the guardian has not approved never reach a subscriber. Any other channel delivers every sender, and the subscriber decides what a stranger gets. An admission that has not decided within fifteen seconds fails closed: that message is not delivered, and the conversation's next message is admitted in order.
- Inbound delivers only what a subscriber may answer. Rome's own sends, the guardian's messages from another device, reactions, edits and frames with no text or attachments stay out of it. The complete record is `messages`.
- The `send` port reaches one account directly through `direct`, where the channel offers it. While no Connection exists for the channel, that lookup rejects as a send does, which is how People tells an unconnected channel from one that cannot be written to. A Connection that exists but has no live Talk reads as a channel that cannot be written to, as it did before.
- The `send` port shows a typing indicator through `activity`, where the channel offers it. It is cosmetic, and nothing waits on it.
- An inbound event carries its conversation's `ConversationRef`, the address that conversation settings and stop take, so a subscriber does not track what backs the channel.
- An inbound event's message is a `ChannelMessage`, the record `messages` answers: it names the channel and says it came inbound.
- Inbound is live and at most once. Nothing is acknowledged or replayed, and a subscriber catches up by reading `messages`.
- `messages` answers one `query` for what was said on the channel: every conversation or one, since a moment or not, newest first. It answers the record `inbound` delivers, plus the channel and the direction, whether a copy Rome keeps or the platform holds the data, and a caller cannot tell which. Neither kind is complete: a copy holds what was synced, and a live read what the platform returns.
- Only a copy Rome keeps answers the per-person reads a People timeline makes (`messages.byAccount`). A channel without one leaves them null, and People reads it from Rome's own transcript instead.
- A channel with no store of its own, such as a Telegram user account, Discord, email or webchat, answers `query` through its Connection's history read. Without a `since`, that read covers the last day, and a caller wanting more names one. While no Connection exists for the channel, the read rejects as a send does.
- That read is a live platform call, and one over every conversation is costly. So a read is shared for thirty seconds with later queries over the same whole-hour window, for the same conversation or for all of them. A wider read does not answer a narrower query, since a Connection cuts what it answers within its window (Discord keeps the oldest hundred lines of each channel). A failed read is not kept. A shared read answers what a fresh one would, older by at most thirty seconds.
- That read goes to the first Connection backing the channel. A channel two Connections back (two Telegram accounts) reads one of them through `query`. A caller that means a particular one names it to the channels service below.
- Every subscriber hears every event. A subscriber hears one conversation's events one at a time, in arrival order. Different conversations and different subscribers never wait on each other, so one slow or failing handler holds up only its own conversation for its own subscriber. A handler that never settles stops that conversation for that subscriber for good, so a subscriber settles every event it takes. A handler still running after ten minutes is logged, and so is a conversation with twenty events waiting. A conversation holds at most a hundred waiting events per subscriber. Past that, the oldest is dropped and logged. Events still waiting when a subscription ends are dropped, and a handler already running keeps running.
- An inbound subscription outlives a reconnect of whatever backs it.
- `directory` lists the conversations a channel can see, each with its `ConversationRef`, so conversation settings reach a channel's conversations without holding a Talk. A Connection whose listing fails is logged and left out, and the others still answer.

### Channels for app actions

App actions reach channels through one service, `deps.channelsService` ([`ChannelsService`](../../packages/core/src/channels/channels-service.ts)). It lists the channels with the Connections that back each, sends, and reads `messages`, all by channel name. In a worker the same calls cross to the main process over RPC.

- It is the only path an action sends or reads history by. The main process and a worker answer the same call identically, which a worker's direct Connection lookup could not.
- It chooses the Connection: the one an action names, which must back the channel, or else the channel's only one. With several and none named, it refuses rather than guessing.
- `query` is the general read. `history` is the read `fetch_channel_history` has always made, with the windows and pages the retired per-channel reads cut, oldest first. It is kept only so the tool's output does not change.
- Admission and pairing stay in the channel's inbound port, which runs them once per message on the Connection it arrived through, whether or not anything subscribes yet ([`channels/admission.ts`](../../packages/core/src/channels/admission.ts)). An account directory stays on the Connection. The service adds no path around either.
- A Connection's Talk and its features (history, inbound media, typing, the directory, direct messaging) are internal to core ([`connections/types.ts`](../../packages/core/src/connections/types.ts)). No app receives them. An app reaches a channel through this service or a hook's `channels`.

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
- The bot confirms pairing and tells the approved account it can start chatting, through the Connection the request arrived on. No blocked message is automatically replayed.
- Approval records retain creation and resolution. Web decisions record the verified guardian identity, and code decisions record the provider-authenticated account and completion method.
- Codes are absent from approval history and logs. Guidance and failed verification logs are best-effort telemetry, not the durable approval record.
- Provider-owned pairing, including WhatsApp device linking, retains its provider-specific proof of control.

Pairing admission creates requests for private messages, messages directed at the bot (mentions, replies, or bot-owned threads), and code attempts. Ambient group messages and Telegram channel identities create no pairing requests. Existing account mappings retain their normal routing.

Each connection permits at most 20 pending pairing requests and 100 new requests in a rolling 24-hour window. Repeated messages can still reuse an existing request at either limit. Deleting a connection or revoking a Talk grant supersedes its pending requests and invalidates their codes. Revoking an unrelated grant preserves pending requests. A guardian rejection retains its original cooldown.

Approval listing includes pending requests and the latest 100 resolved pairing records by default. Earlier pairing history is paged with `pairingHistoryOffset`. Activity provides the full history. Connections shows only active pending requests and links to Activity. Pagination preserves all stored audit records.

## WeChat personal account

WeChat has two connections. The `wechat` service is Tencent's official bot channel: it sends and receives, scoped to a bot. The `wechat_user` service is the guardian's own account, read through the official desktop client Rome runs in its own container, on the desktop it serves at `/desktop`.

The account's history is encrypted at rest with a key the client derives only at login and only ever holds in memory. Recovering it needs ptrace on the client as it signs in. The container carries the capability the debugger needs (`SYS_ADMIN`, AppArmor unconfined) and gdb traces a child it launched, so the runtime runs wechat-bridge's `init` inside the container: it launches the client under gdb, catches the key the first login derives, and stores only the per-database keys. No host-root script or namespace crossing is involved. The client, debugger, and reader run as `rome` in the default `multi` mode. Enabling the connection does not change the Rome service user. The client, the store, and the reads are all local to the container.

### Invariants

- The personal account is read-only. Rome answers what a chat contains and has no way to post to the account. A surface that could post would be a different connection.
- A personal account's history is never delivered as inbound turns. An archive of every conversation the guardian has ever had is something to consult, not something to answer.
- Recovering the store key is the only privileged step, and it produces database keys, not standing access. The ledger records where the authority lives, never the key itself.
- Recovery launches the client under gdb rather than attaching to a running one. The key is derived once, at the first login, so owning the client from its first instruction lets a single login both sign the guardian in and yield the key — attaching after it is up would miss that derivation and demand a second login.
- A signed-out account and a client that is merely not running are different answers. Only the first invalidates the connection.
- A connect ceremony asks for the confirmations the client demands and no more. Retrying a login the client has already remembered invalidates it, which costs the guardian the whole ceremony again.
