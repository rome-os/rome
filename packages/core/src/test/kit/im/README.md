# IM platform peers

A **peer** is a loopback HTTP server, with a WebSocket where the platform has a gateway, that answers a chat platform's API. A test points the production adapter and its real SDK at the peer, so request serialization, response parsing and error handling run the code that ships. Unlike `FakeTelegramApi`, which answers inside grammy's transformer chain, a peer sits behind the HTTP client, so a test also covers the bytes on the wire.

Run the suite with `pnpm --filter @rome/core test src/test/kit/im`. The peer tests use `.integration.test.ts`, so `pnpm test:integration` and its CI job include them.

## Captures

Every response shape a peer returns comes from a **capture**: a reviewed, sanitized recording of real exchanges with the platform, in `captures/*.capture.json`. A peer writes only state by hand: which ids exist, what a message says after an edit, which message a reply points at. The shape around that state is the recorded one.

| Field | Meaning |
|---|---|
| `client` | The SDK or adapter that made the requests, with its version |
| `volatile` | Keys whose values differ on every run, such as timestamps. They are ignored when a peer's answer is compared with the recording |
| `exchanges[].label` | The case a peer answers with this response, such as `send` or `edit-missing` |
| `exchanges[].request` | Method, path and body as sent. A Telegram path spells the token `{token}` |
| `exchanges[].response` | HTTP status and body as received. `status` is absent where only the SDK's parsed result was recorded |

Sanitized ids follow the peer's own allocation, in order of appearance, so the peer answers a recorded request sequence with the recorded ids. Each peer's test replays its capture and requires `comparable()` of the peer's answer to equal `comparable()` of the recording. It checks the status only where one was recorded, and ignores the value of a `volatile` key unless it is `null`, so an unedited message still differs from an edited one. `captures.test.ts` checks every capture's format and fails on any string shaped like a credential.

A case no capture covers yet answers with `source: "synthetic"`, and the peer's exchange log records that source. Replace a synthetic answer with a recorded one when a capture covers it.

| Peer | Client | Recorded | Synthetic |
|---|---|---|---|
| `TelegramPeer` | grammy 1.40.0 | send, edit, reply, edit of a missing message | `getMe`, `getUpdates`, `deleteWebhook`, `sendChatAction`; empty or too-long text; reply to a missing message; edit with unchanged text; edit of a user's message |
| `WechatPeer` | Rome's iLink adapter | send, send with a substituted context token, send to an unknown recipient | `getupdates` |
| `DiscordPeer` | discord.js 14.26.2 | create, read, edit, reply, read of a missing message, all in a guild text channel | gateway frames; `GET /gateway/bot`, `/users/@me`, command registration, channel lookup, DM creation; empty or too-long content; reply to a message elsewhere; edit of a user's message |

## Strictness

A peer is stricter than the platform, never looser, so a wrong id or reference fails the test instead of passing silently.

- A request no route models is answered 500 and recorded in `server.errors`. `server.assertClean()` throws on it.
- A reply must point at a message in the same conversation. An edit must name an existing message.
- `DiscordPeer` opens a DM only with the one user it models. A DM with anyone else is unmodeled, so a wrong recipient fails the test.
- `PeerServer.fetch` reaches only the peer's own origin. `WechatPeer.fetch` maps the iLink origin to the peer and refuses every other origin.

## Faults

`server.once(fault)` scripts the next request that matches a method and path:

- `respond` answers with the given status and body without running the route.
- `dropAfterAccept` runs the route and then cuts the socket. The platform shows the message, but the client cannot know it.
- `before` holds the request until a promise resolves. Pair it with `requestBarrier()` to order a race without sleeping.

A response the platform sends, such as iLink's `ret: -3`, belongs in a capture, and a test passes it to `respond` through `exemplar(capture, label)`. A transport failure, such as a dropped socket or a delay, is a fault and needs no capture.

## What a test reads

- `server.exchanges` lists every request in arrival order with its response, its `source`, and whether it changed what the platform shows (`accepted`).
- `peer.visible(conversation)` lists the messages a person in that conversation sees, with their current text and edit count.

## Add a platform

1. Record a capture with a dedicated test account, sanitize it, and commit it to `captures/`.
2. Write the peer: a `PeerServer` whose routes build responses from the capture's exemplars and keep state in a `MessageStore`.
3. Replay the capture against the peer in the peer's test, then test the adapter through it.
