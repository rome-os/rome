# IM API fixtures

Real-platform API capture: [IM API tracing](../../../../../../docs/observability/im-api-tracing.md). Use reviewed, synthetic captures to extend these modeled contracts.

These fixtures run local HTTP and WebSocket peers behind the production SDKs. They test serialization, message identity, edits, polling, gateway events and delivery failures without platform accounts. Rome adapters and SDK clients remain real.

Run from the repository root:

```sh
pnpm test:im
```

The files use `.integration.test.ts`, so `pnpm test:integration` and its CI job include them. Fast unit tests remain in the unit suite.

## Supported contracts

| Fixture | Real client | Modeled protocol |
| --- | --- | --- |
| `DiscordApiFixture` | discord.js 14.26.2 | Gateway discovery, HELLO/IDENTIFY/READY, heartbeat ACK, basic RESUME, MESSAGE_CREATE, bot identity, DM/channel lookup, create/read/edit messages, multipart uploads, command registration |
| `LarkApiFixture` | @larksuiteoapi/node-sdk 1.68.0 | Tenant token, bot identity, WebSocket discovery, binary pbbp2 events/ACK/ping/pong, create/reply/read/update messages, reactions |
| `TelegramApiFixture` | grammy 1.40.0 | Bot identity, webhook deletion, HTTP long polling, create/edit messages, multipart media sends, typing/callback acknowledgments |
| `WechatApiFixture` | Rome's ilink HTTP adapter | Polling, context-bound text/media sends, typing tickets, encrypted uploads, API-level and HTTP failures |

Payload builders live next to each route implementation. They contain synthetic identities and wire fields taken from the installed SDKs and the production adapter. This keeps executable samples and modeled responses together. Upgrading an SDK requires rerunning this suite and reviewing new or changed requests.

Protocol references: [Discord Gateway](https://discord.com/developers/docs/topics/gateway), [Discord messages](https://discord.com/developers/docs/resources/message), [Lark messages](https://open.larksuite.com/document/server-docs/im-v1/message/create), [Lark SDK](https://github.com/larksuite/node-sdk), and [Telegram Bot API](https://core.telegram.org/bots/api). WeChat fixtures follow the request and response shapes in `src/channels/wechat.ts`, without assuming Telegram-style message receipts.

## Recorded Feishu text responses

`feishu-text.capture.json` contains reviewed responses from a real Feishu bot private chat recorded on 2026-09-18 with SDK 1.68.0. The capture uses `traceLarkHttp` in the local Rome container and credentials from its connection ledger. The five operations create, read, update, read and reply to a test message. Identifiers, tenant keys, timestamps and message positions use synthetic values. Message text is a dedicated test payload. Authentication exchanges and headers are excluded.

`feishu-capture.integration.test.ts` runs the sequence through the real SDK against both recorded responses and the modeled routes. It checks sender fields, message identity, edited content and reply ancestry. Times and message positions vary between runs, so the comparison checks their numeric-string shape. This capture does not cover inbound WebSocket frames, cards, reactions or failures.

## Feishu conversation coverage

`feishu-conversation.integration.test.ts` connects `createLarkServerStub()` to the production SDK, connection registry, pairing admission, inbox hook, action engine, agent runner and SQLite repositories. Only the remote model and Feishu endpoints are replaced. It covers final-only rich-text replies, provider message ids and reply ancestry, consecutive turns, backend continuation, chat isolation, empty/error model results and rejected sends. Tests wait for persisted action completion before asserting delivery and history.

The inbox tests exercise the final-send fallback and assert that drafts are not sent or edited. Backend continuation uses `textDelivery`. The IPC streaming tests below cover incremental output, cancellation and model failure. Pairing approval remains covered by `scenarios.integration.test.ts`.

## Recorded Feishu rich text and threads

`feishu-post.capture.json` contains seventeen SDK exchanges recorded on 2026-09-18: private-chat and test-group rich text create/read/thread-reply/read, two group-message updates with reads, a group Markdown create/read/thread-reply/read sequence, and an HTTP 400 invalid-message response. The source is the same test bot connection ledger. Only dedicated test content is retained. IDs, tenant keys, timestamps, positions and error trace metadata are sanitized. Successful status values describe resolved SDK calls, while the error status comes from the HTTP response.

The capture suite checks recorded responses and stateful routes for successful calls, including request bodies, rich text normalization, thread ancestry and successive updates. Markdown responses and the invalid-message response are replayed through the real SDK to verify normalized content and the rejection shape. It does not replace the model's generic missing-message error or represent permission failures.

The rich text model covers the captured `zh_cn` text/link payload and the SDK's `en_us` locale. Other rich text tags remain synthetic in the stateful model. Locale selection, cards, thread pagination and reconnect behavior require separate captures before claiming parity. These SDK edit tests do not establish Rome Feishu streaming delivery support.

## Recorded Discord text responses

`discord-text.capture.json` contains nine discord.js 14.26.2 REST exchanges recorded in a dedicated test server on 2026-09-18: create/read, two edits with reads, reply/read, and an HTTP 404 unknown-message error. IDs, bot identity and timestamps use synthetic values. Request bodies contain dedicated test content and disable mentions. Authentication data is excluded. Successful calls store the SDK response without claiming a captured HTTP status.

`discord-capture.integration.test.ts` checks full recorded responses in replay mode and modeled message fields in stateful mode. Stateful comparison checks author ID and bot status, excludes cosmetic author profile fields, and normalizes timestamps after checking that they parse. Reply type, message references, referenced content and the SDK error shape remain checked. Gateway events, permissions, rate limits and uploads are not covered by this capture.

## Recorded Telegram text responses

`telegram-text.capture.json` contains five grammy 1.40.0 HTTP exchanges recorded on 2026-09-18: private-chat send, two edits, reply, and an invalid-message edit. IDs, profile fields and dates use synthetic values. Authentication data is excluded. Replay checks complete SDK results and errors. Stateful comparison checks bot identity, chat ID/type, edited content, edit dates and the reply snapshot, excluding recipient profile fields.

The sequence uses returned message objects from send/edit and the reply snapshot. It does not claim an independent message-history read. The [Telegram Bot API](https://core.telegram.org/bots/api#editmessagetext) defines the edit result. Inbound updates, media and native draft streaming are outside this capture.

## Recorded WeChat text responses

`wechat-text.capture.json` contains three HTTP exchanges from the production ilink adapter recorded on 2026-09-18: a context-bound text send, a send with a substituted context token, and a send to an invalid recipient. The first two returned HTTP 200 with a numeric `message_id`. The invalid recipient returned HTTP 200 with `ret: -3` and `errmsg: "invalid arguments"`. API acceptance does not prove recipient delivery. Context validation cannot be inferred from these samples.

`wechat-capture.integration.test.ts` replays successful responses through the real adapter and the API error at the HTTP boundary. It checks serialized requests. `wechat-delivery-capture.integration.test.ts` runs the captured HTTP 200 business error through the registry, router, scheduler and SQLite delivery repository. The test requires a failed attempt with no accepted receipt and no automatic retry. The captures replace recipients, context tokens, client IDs and message IDs with synthetic values and exclude authentication headers. The adapter discards the returned message ID. The local model's context rejection is a synthetic fault, not a verified provider rule. This capture does not cover inbound polling, read/edit operations, media or end-user delivery receipts.

## Script a scenario

### Stateful Lark server

`createLarkServerStub()` starts an isolated `LarkApiFixture` on a random loopback port. Each call owns its message store and fault queue.

```ts
import { createLarkServerStub, LARK_CHAT } from "./lark.js";

const stub = await createLarkServerStub();
const channel = stub.createChannel();
try {
  await channel.connect();
  const sent = await channel.send(LARK_CHAT, { text: "preview" });
  await channel.rawClient.im.message.update({
    path: { message_id: sent.messageId },
    data: { msg_type: "text", content: JSON.stringify({ text: "final" }) },
  });
  const stored = stub.messages.get(sent.messageId);
  expect(stored?.body.content).toBe(JSON.stringify({ text: "final" }));
  stub.server.assertClean();
} finally {
  await channel.disconnect();
  await stub.close();
}
```

Use `createAdapter()` for the Rome adapter, `emitMessage()` for inbound events and `server.once()` for fault injection. `server.url` exposes the HTTP address. SDK clients must use the guarded transport from `createChannel()` rather than setting that address as their domain.

### Fault barriers

```ts
const fixture = await new DiscordApiFixture().start();
const adapter = fixture.createAdapter();
const barrier = requestBarrier();
try {
  await adapter.start();
  fixture.server.once({
    method: "POST",
    path: `/api/v10/channels/${DISCORD_DM}/messages`,
    before: barrier.wait,
  });
  const pending = adapter.sendMessage(DISCORD_DM, DISCORD_DM, { text: "hello" });
  await barrier.entered;
  // Assert the pending request before releasing it.
  barrier.release();
  const receipt = await pending;
  expect(fixture.messages.get(receipt.messageId)?.content).toBe("hello");
  fixture.server.assertClean();
} finally {
  barrier.release();
  await adapter.stop();
  await fixture.close();
}
```

`server.once` consumes one matching request. `response` refuses or rate-limits it without applying the normal route. `dropAfterAccept: true` applies the route and closes the socket before returning a response. This models a message that exists remotely while Rome can only record an unknown result. Combine `before` with either outcome to control races.

`waitForCall` waits for a matching recorded request with a bounded timeout. Include `call.completedAt` when waiting for the route to finish. A recorded request is not by itself delivery success. `accepted` means the fixture applied a mutation. It does not imply that the SDK received the response or that a person saw the message.

Use barriers and recorded operations to order tests. Do not sleep to guess when a create or edit has reached the provider. Native SDK timing checks, such as Retry-After, run on the real clock. The existing unit fixtures cover virtual-clock scheduling.

## Isolation and cleanup

Each peer binds a random port on `127.0.0.1`. Injected HTTP clients reject foreign origins and redirects. Unmodeled routes produce an error, and `assertClean()` fails on unexpected routes or unused fault scripts. Authentication headers are omitted from logs. Secret/token fields and Telegram token paths are redacted.

Use local files for attachment inputs. Arbitrary remote attachment downloads are outside this fixture contract. In particular, discord.js can fetch an attachment URL independently of its REST client. These helpers are not a process-wide network sandbox.

Stop the adapter or registry before closing the peer. Close aborts held HTTP requests, terminates WebSocket peers, and rejects pending request waiters. Release barriers in `finally`. Keep WeChat state in a disposable directory. Its injected transport preserves the production URL validation and maps only its expected API origin to the local peer.

Lark uses real Feishu/Lark domains when constructing SDK requests, then rewrites them at the guarded HTTP boundary. The SDK path-parameter interpolator treats a port in a custom domain as a parameter, so supplying a loopback URL directly as its domain is not equivalent. The protobuf codec implements only the fields used by these scenarios and is checked against the real SDK's encoder and decoder through network tests.

Telegram's HTTP fixture exercises grammy's multipart serialization, unlike the faster existing `FakeTelegramApi` transformer fixture. Its fetch bridge adapts grammy's Node AbortSignal and streaming bodies to native fetch.

## Agent streaming acceptance

`streaming-conversation.integration.test.ts` drives the real AgentSession manager through the IPC bridge, registry, scheduler and local Discord, Telegram, Feishu and WeChat peers. Only the model and worker process boundary are scripted. Every platform/configuration row receives the same five deltas, message size limit and event barriers. Handwritten stage expectations distinguish edits across three physical messages, append-only blocks and final-only delivery. The matrix checks completion, cancellation, model failure and duplicate follow-up admission during generation. It asserts intermediate content, stable message IDs, physical create/edit counts, persisted receipts and completed conversation replies. Platform-specific branches only wire peers and normalize their protocol responses. WeChat records acceptance without inventing a provider message ID.

Physical acceptance and generation completion are separate facts. A cancelled or failed turn can retain accepted receipts, including settled append-only parts. Those receipts do not establish successful generation or a completed conversation reply.

`delivery-config.integration.test.ts` covers Feishu and WeChat mode selection, global and connection overrides, coalescing, create spacing and immediate final flush. It checks Unicode and code content around Rome's configured transport bounds, Feishu edits to existing parts and explicit WeChat corrections. Fault scenarios verify Retry-After, replacement of pending snapshots, rejected parts and accepted parts whose responses are lost. These length checks establish Rome's splitting behavior, not the remote platforms' maximum accepted payload sizes.

`delivery-recovery.integration.test.ts` kills a sender process after its second physical send is accepted but before the receipt is committed. Reopening SQLite and recovering interrupted attempts twice preserves the first receipt, marks the second attempt unknown and does not replay either send. This checks process loss and durable delivery evidence, not a full daemon restart. Delivery unit tests cover memory and queue bounds, burst budgets, runtime editing fallback and corrections whose final boundaries change.

## Acceptance and limits

The suite covers SDK serialization, polling, gateway input, message identity, edits, multipart uploads, fault barriers, API trace redaction and Feishu capture replay. Discord, Telegram and Lark tests apply multiple incremental edits through the real SDK and verify stable message identity and current content. The peers support streaming sends and edits independently of Rome’s delivery scheduler. `scenarios.integration.test.ts` covers Rome delivery scheduling, pairing admission and receipt persistence. `delivery-apis.integration.test.ts` checks adapter delivery outcomes through these peers.

This is a protocol subset, not an emulator for every platform feature. Unknown APIs must be added explicitly. Full gateway resume replay, complete card schemas, arbitrary CDN downloads, and vendor-wide quota policies are not modeled. Feishu streaming uses plain-text create/reply/update calls so the scheduler owns splitting and retries; ordinary sends retain SDK-rendered Markdown posts. Live-account checks remain necessary to verify real permissions and platform behavior.
