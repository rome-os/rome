# Channels

A channel is the layer in core that carries the messages of one of Rome's [accounts](../domains/chats.md#account). The word belongs to the code: the guardian meets accounts, not channels. This page covers the channel ports, the server-owned setup protocol every adapter goes through, and the rules that keep the connect flow generic across services.

## Channel ports

A channel is its name plus four ports: `send`, `inbound`, `accounts` and `messages` ([`Channel`](../../packages/core/src/channels/channel.ts)). Inside core, a channel also has a `directory` of the chats it can see. A Connection is not a channel. A service's Talk may back a channel's `send`, `inbound`, `messages` and `directory`, and Rome's own synced tables may back its `accounts` and `messages`, but what backs a port is incidental to the channel ([decision record](../adrs/channels-and-connectors-are-one-connection.md#amendment-2026-09-28-a-channel-is-not-a-connection)).

### Invariants

- The name is the identity. Every stored row, link and message spells the channel by it.
- Every port may be null, and callers read null as the answer. A present port is what the channel can do, not a promise that it is doing it now: a send nothing currently backs rejects, and an inbound subscription taken before anything backs it hears the first event once something does.
- A channel's lifecycle is not part of the channel. Connecting, disconnecting and degradation belong to whatever backs a port.
- Inbound runs the channel's admission before any subscriber hears an event. Admission delivers every sender ([Unknown senders](#unknown-senders)), and the subscriber decides what a stranger gets. An admission that has not decided within fifteen seconds fails closed: that message is not delivered, and the chat's next message is admitted in order.
- Inbound delivers only what a subscriber may answer. Rome's own sends, the guardian's messages from another device, reactions, edits and frames with no text or attachments stay out of it. The complete record is `messages`.
- The `send` port reaches one account directly through `direct`, where the channel offers it. While no Connection exists for the channel, that lookup rejects as a send does, which is how People tells an unconnected channel from one that cannot be written to. A Connection that exists but has no live talker reads as a channel that cannot be written to, as it did before.
- The `send` port shows a typing indicator through `activity`, where the channel offers it. It is cosmetic, and nothing waits on it.
- An inbound event carries its chat's `ChatRef`, the address that chat settings and stop take, so a subscriber does not track what backs the channel.
- An inbound event's message is a `ChannelMessage`, the record `messages` answers: it names the channel and says it came inbound.
- Inbound is live and at most once. Nothing is acknowledged or replayed, and a subscriber catches up by reading `messages`.
- `messages` answers one `query` for what was said on the channel: every chat or one, since a moment or not, newest first. It answers the record `inbound` delivers, plus the channel and the direction, whether a copy Rome keeps or the platform holds the data, and a caller cannot tell which. Neither kind is complete: a copy holds what was synced, and a live read what the platform returns.
- Only a copy Rome keeps answers the per-person reads a People timeline makes (`messages.byAccount`). A channel without one leaves them null, and People reads it from Rome's own transcript instead.
- A channel with no store of its own, such as a Telegram user account, Discord, email or webchat, answers `query` through its Connection's history read. Without a `since`, that read covers the last day, and a caller wanting more names one. While no Connection exists for the channel, the read rejects as a send does.
- That read is a live platform call, and one over every chat is costly. So a read is shared for thirty seconds with later queries over the same whole-hour window, for the same chat or for all of them. A wider read does not answer a narrower query, since a Connection cuts what it answers within its window (Discord keeps the oldest hundred lines of each channel). A failed read is not kept. A shared read answers what a fresh one would, older by at most thirty seconds.
- That read goes to the Connection backing the channel. A service may hold several Connections, but each backs exactly one channel, so a channel has one to read. A second presence of a service is a second channel with its own name, never a second backer of the first ([ADR](../adrs/channels-and-connectors-are-one-connection.md#amendment-2026-10-15-several-connections-per-service)).
- Every subscriber hears every event. A subscriber hears one chat's events one at a time, in arrival order. Different chats and different subscribers never wait on each other, so one slow or failing handler holds up only its own chat for its own subscriber. A handler that never settles stops that chat for that subscriber for good, so a subscriber settles every event it takes. A handler still running after ten minutes is logged, and so is a chat with twenty events waiting. A chat holds at most a hundred waiting events per subscriber. Past that, the oldest is dropped and logged. Events still waiting when a subscription ends are dropped, and a handler already running keeps running.
- An inbound subscription outlives a reconnect of whatever backs it.
- Inbound hears a channel only while Rome listens to its account ([An account's agent](#an-accounts-agent)). While Rome does not, the channel keeps its subscribers, but nothing it receives reaches them, and admission does not run.
- `directory` lists the chats a channel can see, each with its `ChatRef`, so chat settings reach a channel's chats without reaching a Connection. A listing that fails is logged and answers no chats.

### Channels for app actions

App actions reach channels through one service, `deps.channelsService` ([`ChannelsService`](../../packages/core/src/channels/channels-service.ts)). It lists the channels and whether each can send, sends, and reads `messages`, all by channel name. In a worker the same calls cross to the main process over RPC.

- It is the only path an action sends or reads history by. The main process and a worker answer the same call identically, which a worker's direct Connection lookup could not.
- It sends through the Connection backing the channel. A channel has one Connection behind it, so an action names the channel and never a Connection.
- `query` is the one read, `fetch_channel_history` included.
- An address book is not on the service, since it is the guardian's contacts. To message an agent by name, the system app alone receives `deps.agentNames` ([`channels/agent-names.ts`](../../packages/core/src/channels/agent-names.ts)), which resolves a name given as `to` on `agents` against Cloud's listing of the agents this Rome can message. Only the `main` agent, a name only core may define, sends by name. Any other caller, an installed app's `runAction` included, passes the agent's id. A bare name reaches only the guardian's own agent, and the agent of an account linked to the guardian is named by its whole label. A name two agents share is refused with each one's label and id. The worker RPC behind the lookup does not identify its caller, so app code running in a worker could still send it directly, a gap it shares with `feedback.send` and the lifecycle RPCs.
- Admission stays in the channel's inbound port, which runs them once per message on the Connection it arrived through, whether or not anything subscribes yet ([`channels/admission.ts`](../../packages/core/src/channels/admission.ts)). An account directory stays on the Connection. The service adds no path around either.
- A Connection's talker and its features (history, inbound media, typing, the directory, direct messaging, reply delivery) are internal to core ([`connections/types.ts`](../../packages/core/src/connections/types.ts)). Only the channel ports reach a talker, through `Connection.withTalker`, which also reports a rejected credential to the registry. No app receives them. An app reaches a channel through this service or a hook's `channels`.

## Reply streaming

A reply can reach a chat as the agent writes it, rather than whole after the run. The host decides for each reply, and an app only asks.

### Invariants

- Reply streaming is off until it is switched on under Experimental features in Advanced settings. Off, the app that ran a reply sends it whole, and no send waits on a write budget. The host reads the setting for each reply, and for each send on a Connection that can stream, so a change applies to the next one.
- An app asks for streaming and the host decides. The reply streams only when the setting is on and the channel can stream. Otherwise the run reports no delivery, and the app sends the reply itself.
- Only a guardian's direct chat asks. Every other sender's reply passes Envoy whole before anything is sent.
- A reply the host streamed is not sent again by its caller, unless the stream wrote nothing. Any other outcome may already show on the platform, so a reply that failed partway stays unfinished.
- A Connection's streamed replies and ordinary sends share one write budget, and only a Connection that can stream has one. A write that hangs cannot stall the Connection's other writes, and it is not cut off.
- A stop reaches the reply before the provider, so nothing new is written after it. When the worker that asked for the reply goes away, the reply stops the same way, even after the run has ended. A reply whose worker went away before it opened writes nothing.
- A streamed reply is its turn's one answer in the chat's history, and holds the text the user was shown or may have been shown.
- A message is edited no more often than its platform allows. Its last edit ends it at a readable break, and the reply goes on streaming in a new message. Feishu allows a message 20 edits. A message the platform refuses to edit again anyway keeps what it shows, and the rest of the reply goes out as new messages.
- On Feishu, code that runs past the end of a message is closed there and opened again in the next, so each message shows it as code.
- A streamed reply lands where a whole one would. Where a chat puts replies in a thread, every message of the reply goes into that thread.
- A fault in the reply stream never ends the run. The result still reaches its caller. A reply that certainly wrote nothing is reported as failed, so the caller sends it. A reply that cannot settle is reported as unknown.

## An account's agent

An [agent](../concepts/agents.md) can be linked to one of Rome's accounts, which the code stores on the account's channel ([ADR](../adrs/channels-and-connectors-are-one-connection.md#amendment-2026-10-16-an-agent-linked-to-a-channel)). `GET /api/channels/accounts` lists each account with its agent, and `PUT /api/channels/accounts/:id/agent` links one, switches it, or unlinks it with `null` ([`channel-accounts.ts`](../../packages/api-types/src/channel-accounts.ts)). The account's agent answers in the chats on its channel.

### Invariants

- An account has at most one agent, stored on its channel by its canonical id. Main is linked like any other agent, as `core:main`.
- Only a Feishu, Telegram, Discord, or Slack account made for an agent, or the signed-in Telegram user, takes an agent ([`account-agents.ts`](../../packages/api-types/src/account-agents.ts)). A channel that carries Rome's own traffic, such as the Cloud `agents` channel, takes no link.
- An agent can be linked to any number of channels, several on one platform included ([ADR](../adrs/channels-and-connectors-are-one-connection.md#amendment-2026-10-20-an-agent-linked-to-any-number-of-channels)). A link changes only the channel it names. Linking an agent to a second Telegram account leaves it linked to the first. Main follows the same rule.
- Rome never picks an account's agent. A linkable service's newly connected account has no agent, so it is silent until the guardian links one ([ADR](../adrs/channels-and-connectors-are-one-connection.md#amendment-2026-10-21-rome-never-picks-an-accounts-agent)). On upgrade, every backed channel of a linkable service is linked to main, since those accounts answered as main before.
- A linkable service's account that connects starts fresh. It never takes over a released channel, its own earlier one included, so it inherits no history. Any other service's next account takes back the service's released channel, since apps address that service's one channel by its name.
- A channel whose Connection is removed loses its link, and a channel no Connection backs cannot be linked.
- A chat's own agent choice, set for a group or channel before account agents existed, still answers there and wins over the link. A private chat on a linked channel follows the link. Every other chat on a linked channel is answered by the account's agent. It stores no agent, so switching the agent takes effect on the next message, and the channel's link, not the stored agent, names who answers. Per-chat choices are legacy and move to links in a later phase. The sessions explorer labels, filters, searches and counts these chats by the agent that answers. A channel whose link is silent keeps the stored agent there. Agent sessions are kept per agent, so the newly linked agent starts its own session in the chat rather than taking over the previous agent's.
- Rome listens to an account that takes an agent only while it has one. Linking an agent starts the channel's inbound subscription, and unlinking it stops it. At boot and at each reconnect the channel reads its account's agent again. A message to an account with no agent reaches no subscriber and no admission: no chat, and nothing recorded. Nothing falls back to main. The account stays connected, so Rome still sends as it.
- An account whose agent is not loaded is still listened to, and answers nothing, overrides included. Rome logs a warning once per channel and agent. Unlinking does not end a turn already running, and a `/stop` sent after the unlink does not reach it.
- An account of a service that takes no agent, such as email, webchat or WhatsApp, is always listened to.
- Known issue: an app leaves the agent catalog while it reinstalls, so a channel linked to one of its agents answers nothing for that window. Messages that arrive then are dropped without being stored.
- The Feishu group settings card starts on the group's own agent choice, or on the agent that answers when the group has none. A Save that keeps the agent the card showed leaves the group's choice as it is. So the card cannot pin a group to the account's current agent, and the group keeps following the link.
- A channel of a service that takes no link, such as webchat, email or the Cloud `agents` channel, keeps its chats' agent choice, and main answers by default.
- An agent's shell commands act as the Discord account of the channel the agent's chat came in on. A chat on another service's channel, such as webchat, acts as the first Discord account that can act. The channel is the agent's own claim, so any agent can act as any of Rome's Discord accounts. Agents are trusted with every one of them, and a second account is not a boundary between the agents linked to each.
- People keys an account by its [connection kind](../domains/connections.md#connection-kind), not by its channel. Feishu and Lark apps are two connection kinds but share the key `feishu` until links are keyed by platform. An address on a connection kind's second channel resolves to the same person as on its first when the platform gives that person one address across Rome's accounts. Telegram and Discord do. Slack does within one workspace: its member ids are issued per workspace, so a Slack address carries its workspace, and the same person in two workspaces is two accounts. Feishu does not: its sender id is issued per app, so a guardian is linked again on a second Feishu account. A link keyed by a connection kind reaches that kind's channel only while Rome holds exactly one, for sending and for the person's timeline. Rome never picks among its accounts of one kind ([outbox](../concepts/people.md#outbox)).

## Connection setup

Every channel is connected through **one server-owned setup protocol** ([decision record](../adrs/server-owned-ceremonies-with-terminal-conferral.md)) — not a per-service connect flow. Per-service knowledge (which credentials a channel needs, how it probes them, what the guardian must do) lives in the integration descriptor the server drives. The client only pumps generic setup states and renders them.

### Invariants

- **Setup is uniform.** Enabling any channel drives the same generic surface (a conferral setup addressed by connection + grant). Setup proves provider credentials, while a link in People says who a sender is. A connected account hears strangers before any account is linked to the guardian.
- **The dashboard renders setups generically.** The connect UI is a single standard renderer plus a small set of registered custom components for the few steps that need bespoke presentation (e.g. rendering a QR image). Adding a channel adds neither a connect route nor a per-service connect card.
- **An account exists only while it is connected.** Adding another account of a service runs that service's setup for a new account, and the account and its channel come into being only when the setup connects it, so an abandoned add leaves nothing behind. Disconnecting the last grant of an account whose service names its accounts (Telegram, Discord, Feishu, Slack bots, the signed-in Telegram user) removes the account and releases its channel. Any other Connection stays after its last grant goes.
- **Post-connection configuration is not setup.** Config and feature surfaces that operate *after* a channel is linked — Discord per-channel agent routing, the Telegram personal-account dialog list — live under their own named routes, separate from the setup protocol and never part of connecting.

## Slack bots

A Slack bot is one of Rome's accounts with one agent ([`slack-bot.ts`](../../packages/core/src/connections/integrations/slack-bot.ts)). Slack gives an app exactly one bot in a workspace, so each bot is its own Slack app, and two agents in one workspace are two apps. It is a separate service from `slack`, the Rome Cloud connection that acts in a workspace for the guardian.

### Invariants

- The guardian creates each app from a link that carries its manifest, installs it, and pastes its bot token and app-level token back. Rome never creates or configures a Slack app, and holds no configuration token. A manifest carries no picture, so the guardian uploads one on the app's settings page.
- Rome opens its own Socket Mode connection to Slack, so an instance needs no public address and no Cloud relay for Slack's events.
- Rome hears direct messages to the bot and mentions of it in a channel. It never asks for permission to read a channel's history, so other lines in a channel never reach it.
- A direct message is one chat, and a Slack channel is one chat. A [thread](../domains/chats.md#thread) lives inside its channel's chat: a mention in a thread is a message of the channel's chat that names the thread it was said in. The reply goes into that thread, and a mention in the channel itself starts a thread under it. A direct message is answered in place.
- A message's id names the thread it was said in, so a reply finds the thread from the id alone, after a restart too. This holds for the agent's own messages, so a reply to one of them stays in its thread.
- Reconnecting an account asks for fresh tokens from its own app. A new app is a different bot, so it is a different account and cannot renew this one.
- Members of the workspace reach the agent as strangers until the guardian links them, the guardian's own account included ([Unknown senders](#unknown-senders)).

## LinkedIn replies

LinkedIn replies use the shared [People outbox](../concepts/people.md#outbox) and the browser session that reads the inbox.

### Invariants

- A reply addresses an existing direct chat. Missing, incomplete, group, or ambiguous membership cannot authorize a send.
- Before sending, LinkedIn must confirm both the recipient and the sending account by member id. A display name cannot establish either identity.
- A send receipt and a history read identify the same provider message. A successful click or a matching message body cannot establish acceptance.
- Once LinkedIn accepts a reply, a local mirror failure cannot turn it into a failed send. Unknown send outcomes require an explicit retry.
- A retry keeps the original chat. A changed destination requires a new reply.

## Unknown senders

Every channel delivers every sender. Rome never asks a sender to pair or to do anything else to be heard ([Stranger](../domains/people.md#stranger)). A sender with no link reaches the inbox as a stranger, and the reply rule and the sentinel decide what it gets.

### Invariants

- No admission blocks a sender for having no link, and no channel replies with guidance to a stranger.
- The guardian links their own account on a platform the way they link anyone's: in People, from the stranger account that appears after they write to Rome's account.
- On any platform, the guardian's link code is the shortcut. People shows one code at a time, valid for ten minutes and used once. A direct message carrying it, to any of Rome's accounts, links the sender to the guardian and never reaches a subscriber. The code in a group never links anyone and voids the code, since everyone in the chat has seen it. Five wrong codes void it too. A code never moves an account linked to someone else.
- Only the guardian, on the dashboard's own origin, can ask for a code, since redeeming one makes its sender the guardian.
- Pairing requests stored before this rule are history. Activity shows them as expired, and none can be approved.
- Provider-owned device linking, such as WhatsApp's, keeps its provider-specific proof of control.

## WeChat personal account

WeChat has two connections. The `wechat` service is Tencent's official bot service: it sends and receives as an account made for the agent. The `wechat_user` service is the guardian's own account, read through the official desktop client Rome runs in its own container, on the desktop it serves at `/desktop`.

The account's history is encrypted at rest with a key the client derives only at login and only ever holds in memory. Recovering it needs ptrace on the client as it signs in. The container carries the capability the debugger needs (`SYS_ADMIN`, AppArmor unconfined) and gdb traces a child it launched, so the runtime runs wechat-bridge's `init` inside the container: it launches the client under gdb, catches the key the first login derives, and stores only the per-database keys. No host-root script or namespace crossing is involved. The client, debugger, and reader run as `rome` in the default `multi` mode. Enabling the connection does not change the Rome service user. The client, the store, and the reads are all local to the container.

### Invariants

- The personal account is read-only. Rome answers what a chat contains and has no way to post to the account. A surface that could post would be a different connection.
- A personal account's history is never delivered as inbound turns. An archive of every chat the guardian has ever had is something to consult, not something to answer.
- Recovering the store key is the only privileged step, and it produces database keys, not standing access. The ledger records where the authority lives, never the key itself.
- Recovery launches the client under gdb rather than attaching to a running one. The key is derived once, at the first login, so owning the client from its first instruction lets a single login both sign the guardian in and yield the key — attaching after it is up would miss that derivation and demand a second login.
- A signed-out account and a client that is merely not running are different answers. Only the first invalidates the connection.
- A connect ceremony asks for the confirmations the client demands and no more. Retrying a login the client has already remembered invalidates it, which costs the guardian the whole ceremony again.
