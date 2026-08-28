# @rome-os/app-runtime

## [0.6.1](https://github.com/rome-os/rome/compare/app-runtime-v0.6.0...app-runtime-v0.6.1) (2026-08-28)


### Features

* add app keys for guardian-entered app credentials ([#91](https://github.com/rome-os/rome/issues/91)) ([3576f96](https://github.com/rome-os/rome/commit/3576f9689b04279bb938647c07be1c093d7267be))

## [0.6.0](https://github.com/amantru/rome-internal/compare/app-runtime-v0.5.10...app-runtime-v0.6.0) (2026-08-15)


### ⚠ BREAKING CHANGES

* **app-runtime:** close the approval lifecycle union across the SDK, core and the dashboard ([#2159](https://github.com/amantru/rome-internal/issues/2159))

### Features

* **app-runtime:** close the approval lifecycle union across the SDK, core and the dashboard ([#2159](https://github.com/amantru/rome-internal/issues/2159)) ([a9bf641](https://github.com/amantru/rome-internal/commit/a9bf641c8d8c44a543d4cdb777f34c2fc4190910))

## [0.5.10](https://github.com/amantru/rome-internal/compare/app-runtime-v0.5.9...app-runtime-v0.5.10) (2026-07-29)


### Features

* **system:** generate_image action via a provider-neutral image generation capability (Codex first) ([#1697](https://github.com/amantru/rome-internal/issues/1697)) ([e63901b](https://github.com/amantru/rome-internal/commit/e63901b5d1b99bdc00072818915cc88b3fd200c4))

## [0.5.9](https://github.com/amantru/rome-internal/compare/app-runtime-v0.5.8...app-runtime-v0.5.9) (2026-07-20)


### Features

* **agents:** support configurable reasoning effort ([#1746](https://github.com/amantru/rome-internal/issues/1746)) ([146f7b6](https://github.com/amantru/rome-internal/commit/146f7b658bbb3bef995825b784460c8bc50eb1d7))

## [0.5.8](https://github.com/amantru/rome-internal/compare/app-runtime-v0.5.7...app-runtime-v0.5.8) (2026-07-15)


### Bug Fixes

* **sdk:** restore pending SDK release tracking ([#1661](https://github.com/amantru/rome-internal/issues/1661)) ([3b1ecf9](https://github.com/amantru/rome-internal/commit/3b1ecf98b937671eec012b15c37533c5252eb3d2))

## [0.5.7](https://github.com/amantru/rome-internal/compare/app-runtime-v0.5.6...app-runtime-v0.5.7) (2026-07-13)


### Bug Fixes

* **webchat:** fork side chats from selected turn ([#1558](https://github.com/amantru/rome-internal/issues/1558)) ([e4c0f65](https://github.com/amantru/rome-internal/commit/e4c0f65ef80f27101cba805394597aac28e0a7c5))

## [0.5.6](https://github.com/amantru/rome-internal/compare/app-runtime-v0.5.5...app-runtime-v0.5.6) (2026-07-12)


### Features

* add exact fork mode for forked runs alongside the isolated default ([#1497](https://github.com/amantru/rome-internal/issues/1497)) ([45198bd](https://github.com/amantru/rome-internal/commit/45198bd9705f98b5aa64b97a4a83f6014e944e39))

## [0.5.5](https://github.com/amantru/rome-internal/compare/app-runtime-v0.5.4...app-runtime-v0.5.5) (2026-07-11)


### Features

* record forked runs as fork-type sessions visible at /sessions ([#1493](https://github.com/amantru/rome-internal/issues/1493)) ([67e1374](https://github.com/amantru/rome-internal/commit/67e1374cc2d408feacf1570b6702cf51a39a12c5))

## [0.5.4](https://github.com/amantru/rome-internal/compare/app-runtime-v0.5.3...app-runtime-v0.5.4) (2026-07-07)


### Features

* reusable Rome Cloud visitor sign-in for apps ([#1391](https://github.com/amantru/rome-internal/issues/1391)) ([bd7acb4](https://github.com/amantru/rome-internal/commit/bd7acb467ed5cf08dd9bd486965cc7940c2629e9))

## [0.5.3](https://github.com/amantru/rome-internal/compare/app-runtime-v0.5.2...app-runtime-v0.5.3) (2026-07-07)


### Features

* host-resolved caller identity for apps (request.caller + useCaller) ([#1370](https://github.com/amantru/rome-internal/issues/1370)) ([d0b03ec](https://github.com/amantru/rome-internal/commit/d0b03ec1451a806fd8c68c231e8872e455ad5d62))

## [0.5.2](https://github.com/amantru/rome-internal/compare/app-runtime-v0.5.1...app-runtime-v0.5.2) (2026-07-05)


### Features

* **routines:** app-managed routines resist user deletion, auto-attributed by the runtime ([#1335](https://github.com/amantru/rome-internal/issues/1335)) ([6a25ae2](https://github.com/amantru/rome-internal/commit/6a25ae25a123b4d129e73e57631acaea61508a97))

## [0.5.1](https://github.com/amantru/rome-internal/compare/app-runtime-v0.5.0...app-runtime-v0.5.1) (2026-07-03)


### Bug Fixes

* **favors:** return app payers to the requesting app page, not the guardian dashboard ([#1324](https://github.com/amantru/rome-internal/issues/1324)) ([90e6d01](https://github.com/amantru/rome-internal/commit/90e6d01c522f997c2255e398f7b11b8c0f9b7720))

## [0.5.0](https://github.com/amantru/rome-internal/compare/app-runtime-v0.4.0...app-runtime-v0.5.0) (2026-07-01)


### ⚠ BREAKING CHANGES

* **app-runtime:** keep SDK barrel browser-safe; move CDP client to /browser subpath ([#985](https://github.com/amantru/rome-internal/issues/985))
* drop workflow combinators + interpreter from the SDK ([#905](https://github.com/amantru/rome-internal/issues/905))
* make ActionResult a status-discriminated union ([#814](https://github.com/amantru/rome-internal/issues/814))
* hide IPC/worker transport from app authors (RFC 030) ([#773](https://github.com/amantru/rome-internal/issues/773))
* **apps:** unify suspendable actions + inline components into one pendingInteraction ([#740](https://github.com/amantru/rome-internal/issues/740))

### Features

* **actions:** suspendable actions — hand a turn off to an app surface ([#716](https://github.com/amantru/rome-internal/issues/716)) ([7de3129](https://github.com/amantru/rome-internal/commit/7de3129162b5c4546d6e38f0d5db1094249d644e))
* app runtime sdk 0.3.1 ([#1161](https://github.com/amantru/rome-internal/issues/1161)) ([dcfea4f](https://github.com/amantru/rome-internal/commit/dcfea4f85ed4b84c6ae83d2b4fbd6a98fdada96a))
* **app-runtime:** host workflow engine in SDK, apps import buildWorkflow() ([#902](https://github.com/amantru/rome-internal/issues/902)) ([516200a](https://github.com/amantru/rome-internal/commit/516200a133948ed2c051a619566acb5643486a1b))
* **apps:** deliver chat session to widgets via global-params channel, not URL query ([#1179](https://github.com/amantru/rome-internal/issues/1179)) ([828746b](https://github.com/amantru/rome-internal/commit/828746b81785609fddf51d04780cc3268954e65b))
* **apps:** inline app components — render app-defined components in webchat ([#729](https://github.com/amantru/rome-internal/issues/729)) ([cf3dac1](https://github.com/amantru/rome-internal/commit/cf3dac1dfb4f0cbf8e3162f18274da289fce8d8e))
* **apps:** unify suspendable actions + inline components into one pendingInteraction ([#740](https://github.com/amantru/rome-internal/issues/740)) ([29cf797](https://github.com/amantru/rome-internal/commit/29cf797b3c5eae1344c55710bb240884c8ef489f))
* **apps:** WebSocket support for app API handlers (RFC 030) ([#1159](https://github.com/amantru/rome-internal/issues/1159)) ([4210976](https://github.com/amantru/rome-internal/commit/421097611cfa501ffe4113b2690416814ac8115a))
* **channels:** add Feishu/Lark channel adapter ([#1219](https://github.com/amantru/rome-internal/issues/1219)) ([7b9195f](https://github.com/amantru/rome-internal/commit/7b9195fc8e07397de7b03d4b3205301730f4705d))
* **channels:** per-channel agent routing for Discord ([#676](https://github.com/amantru/rome-internal/issues/676)) ([7e65a12](https://github.com/amantru/rome-internal/commit/7e65a12c0c67183eff8c482ea7a80753361f914c))
* **connectors:** fold catalog into app description; map connector_proxy hosts ([#989](https://github.com/amantru/rome-internal/issues/989)) ([b640c7e](https://github.com/amantru/rome-internal/commit/b640c7edaaec991c8770c675ed67fac493067562))
* **core:** defer — agent self-wakeup to continue a thread later (RFC 035) ([#1156](https://github.com/amantru/rome-internal/issues/1156)) ([8633702](https://github.com/amantru/rome-internal/commit/8633702d525f77133a7e5f8631e4dc2ddc2fee91))
* **core:** fall back from exhausted Codex quota to Claude on auto turns ([#1139](https://github.com/amantru/rome-internal/issues/1139)) ([b6cdfbb](https://github.com/amantru/rome-internal/commit/b6cdfbb0cd9316b282cb876ef2c057c9ab565602))
* **core:** guardian onboarding notice when no AI tool is configured ([#841](https://github.com/amantru/rome-internal/issues/841)) ([7b37696](https://github.com/amantru/rome-internal/commit/7b3769655cd323df3b0afb5737508ad93345d306))
* drop workflow combinators + interpreter from the SDK ([#905](https://github.com/amantru/rome-internal/issues/905)) ([e766e2a](https://github.com/amantru/rome-internal/commit/e766e2ac810cb0c58a57d40dd0cd3ad9d1bf5b2f))
* **events:** capture event payload schema in the event catalog ([#751](https://github.com/amantru/rome-internal/issues/751)) ([3733995](https://github.com/amantru/rome-internal/commit/3733995b71d451548a19761d3e790ef135ec7cc0))
* hide IPC/worker transport from app authors (RFC 030) ([#773](https://github.com/amantru/rome-internal/issues/773)) ([2948e11](https://github.com/amantru/rome-internal/commit/2948e119cfc10671c29dbe2e8aacff9346e4a81c))
* **inbox:** make Discord channel-control cue capability-aware ([#824](https://github.com/amantru/rome-internal/issues/824)) ([37698c4](https://github.com/amantru/rome-internal/commit/37698c4aaca17f6110f4dced0ff04fb574ca1b00))
* interactive summon + typed Workflow Studio pipeline ([#844](https://github.com/amantru/rome-internal/issues/844)) ([b99cc8e](https://github.com/amantru/rome-internal/commit/b99cc8e2933c0070603eee89812bd7c8b1c01a8d))
* make ActionResult a status-discriminated union ([#814](https://github.com/amantru/rome-internal/issues/814)) ([a5a0010](https://github.com/amantru/rome-internal/commit/a5a00108d3f17e13decddb143545bed626f423e8))
* manual routine triggers ([#1241](https://github.com/amantru/rome-internal/issues/1241)) ([195da54](https://github.com/amantru/rome-internal/commit/195da54b1fe945b4ec6cb0230509ca267c9465c7))
* render routine cards from the action's own preview(), not agent prose ([#876](https://github.com/amantru/rome-internal/issues/876)) ([fe3ed78](https://github.com/amantru/rome-internal/commit/fe3ed78ac6caf8dd907b29c2b79c6d12b29d11c9))
* **routines:** add optional unique `key` for dedup; give briefing routines human names ([#1233](https://github.com/amantru/rome-internal/issues/1233)) ([95de845](https://github.com/amantru/rome-internal/commit/95de84528a33eed0f12e2a245ddb976b48ba4361))
* **routines:** floating vs fixed timezone binding for schedules (RFC 034) ([#1140](https://github.com/amantru/rome-internal/issues/1140)) ([69aa296](https://github.com/amantru/rome-internal/commit/69aa2966012e0a705af9e458628d2ae7f550b3db))
* simplify workflow creation — single skill, connector catalog, build-first ([#983](https://github.com/amantru/rome-internal/issues/983)) ([3d977ff](https://github.com/amantru/rome-internal/commit/3d977ff33e41e184af9094c16a793a8459761ae8))
* **system:** generic show_app action ([#868](https://github.com/amantru/rome-internal/issues/868)) ([41e4838](https://github.com/amantru/rome-internal/commit/41e483881a5495eafb9c7ad22f099ce37a02a809))
* turn-middleware onion + welcome-to-rome onboarding (RFC 034) ([#1027](https://github.com/amantru/rome-internal/issues/1027)) ([ec79ba3](https://github.com/amantru/rome-internal/commit/ec79ba3ad99d0ff2944f35553c1e43b5dcfa95bc))
* update version of app-web-sdk ([#785](https://github.com/amantru/rome-internal/issues/785)) ([1e5822b](https://github.com/amantru/rome-internal/commit/1e5822b4a2eb3393b306f5e28d5169b9743e3346))
* **webchat:** keep in-turn narration text in the transcript ([#1006](https://github.com/amantru/rome-internal/issues/1006)) ([1989d62](https://github.com/amantru/rome-internal/commit/1989d62f17fa04cd91fbc965fbcad0a57caeb0e6))
* **workflow-studio:** fire-and-forget workflow_preview widget ([#867](https://github.com/amantru/rome-internal/issues/867)) ([998cd3f](https://github.com/amantru/rome-internal/commit/998cd3fa0e1cd08694efa34ae763506bfefe23d4))


### Bug Fixes

* **app-runtime:** keep SDK barrel browser-safe; move CDP client to /browser subpath ([#985](https://github.com/amantru/rome-internal/issues/985)) ([858c10a](https://github.com/amantru/rome-internal/commit/858c10a62539264d63300f363a78b3b32d0c580f))

## [0.4.0](https://github.com/amantru/rome-internal/compare/app-runtime-v0.3.4...app-runtime-v0.4.0) (2026-06-30)


### ⚠ BREAKING CHANGES

* favor pricing now lives on action configs, and favor requests use action names instead of priced action IDs ([#1279](https://github.com/amantru/rome-internal/issues/1279)) ([30ca5dc](https://github.com/amantru/rome-internal/commit/30ca5dceca396a27ce0ecbc1f03eceba28ea3c9c))


### Features

* move favor pricing onto actions ([#1279](https://github.com/amantru/rome-internal/issues/1279)) ([30ca5dc](https://github.com/amantru/rome-internal/commit/30ca5dceca396a27ce0ecbc1f03eceba28ea3c9c))

## [0.3.4](https://github.com/amantru/rome-internal/compare/app-runtime-v0.3.3...app-runtime-v0.3.4) (2026-06-29)


### Features

* manual routine triggers ([#1241](https://github.com/amantru/rome-internal/issues/1241)) ([195da54](https://github.com/amantru/rome-internal/commit/195da54b1fe945b4ec6cb0230509ca267c9465c7))
* **routines:** add optional unique `key` for dedup; give briefing routines human names ([#1233](https://github.com/amantru/rome-internal/issues/1233)) ([95de845](https://github.com/amantru/rome-internal/commit/95de84528a33eed0f12e2a245ddb976b48ba4361))

## [0.3.3](https://github.com/amantru/rome-internal/compare/app-runtime-v0.3.2...app-runtime-v0.3.3) (2026-06-27)


### Features

* **channels:** add Feishu/Lark channel adapter ([#1219](https://github.com/amantru/rome-internal/issues/1219)) ([7b9195f](https://github.com/amantru/rome-internal/commit/7b9195fc8e07397de7b03d4b3205301730f4705d))

## [0.3.2](https://github.com/amantru/rome-internal/compare/app-runtime-v0.3.1...app-runtime-v0.3.2) (2026-06-27)


### Features

* **apps:** deliver chat session to widgets via global-params channel, not URL query ([#1179](https://github.com/amantru/rome-internal/issues/1179)) ([828746b](https://github.com/amantru/rome-internal/commit/828746b81785609fddf51d04780cc3268954e65b))

## [0.3.0](https://github.com/amantru/rome-internal/compare/app-runtime-v0.2.1...app-runtime-v0.3.0) (2026-06-13)


### ⚠ BREAKING CHANGES

* make ActionResult a status-discriminated union ([#814](https://github.com/amantru/rome-internal/issues/814))
* hide IPC/worker transport from app authors (RFC 030) ([#773](https://github.com/amantru/rome-internal/issues/773))
* **apps:** unify suspendable actions + inline components into one pendingInteraction ([#740](https://github.com/amantru/rome-internal/issues/740))

### Features

* **actions:** suspendable actions — hand a turn off to an app surface ([#716](https://github.com/amantru/rome-internal/issues/716)) ([7de3129](https://github.com/amantru/rome-internal/commit/7de3129162b5c4546d6e38f0d5db1094249d644e))
* **app-runtime:** in-process fallback for worker→main RPC ([#722](https://github.com/amantru/rome-internal/issues/722)) ([cf32b78](https://github.com/amantru/rome-internal/commit/cf32b7859c8700106b4d59ebb0e045ff68f4db11))
* **apps:** inline app components — render app-defined components in webchat ([#729](https://github.com/amantru/rome-internal/issues/729)) ([cf3dac1](https://github.com/amantru/rome-internal/commit/cf3dac1dfb4f0cbf8e3162f18274da289fce8d8e))
* **apps:** unify suspendable actions + inline components into one pendingInteraction ([#740](https://github.com/amantru/rome-internal/issues/740)) ([29cf797](https://github.com/amantru/rome-internal/commit/29cf797b3c5eae1344c55710bb240884c8ef489f))
* **channels:** per-channel agent routing for Discord ([#676](https://github.com/amantru/rome-internal/issues/676)) ([7e65a12](https://github.com/amantru/rome-internal/commit/7e65a12c0c67183eff8c482ea7a80753361f914c))
* **core:** guardian onboarding notice when no AI tool is configured ([#841](https://github.com/amantru/rome-internal/issues/841)) ([7b37696](https://github.com/amantru/rome-internal/commit/7b3769655cd323df3b0afb5737508ad93345d306))
* **events:** capture event payload schema in the event catalog ([#751](https://github.com/amantru/rome-internal/issues/751)) ([3733995](https://github.com/amantru/rome-internal/commit/3733995b71d451548a19761d3e790ef135ec7cc0))
* hide IPC/worker transport from app authors (RFC 030) ([#773](https://github.com/amantru/rome-internal/issues/773)) ([2948e11](https://github.com/amantru/rome-internal/commit/2948e119cfc10671c29dbe2e8aacff9346e4a81c))
* **inbox:** make Discord channel-control cue capability-aware ([#824](https://github.com/amantru/rome-internal/issues/824)) ([37698c4](https://github.com/amantru/rome-internal/commit/37698c4aaca17f6110f4dced0ff04fb574ca1b00))
* interactive summon + typed Workflow Studio pipeline ([#844](https://github.com/amantru/rome-internal/issues/844)) ([b99cc8e](https://github.com/amantru/rome-internal/commit/b99cc8e2933c0070603eee89812bd7c8b1c01a8d))
* make ActionResult a status-discriminated union ([#814](https://github.com/amantru/rome-internal/issues/814)) ([a5a0010](https://github.com/amantru/rome-internal/commit/a5a00108d3f17e13decddb143545bed626f423e8))
* **system:** generic show_app action ([#868](https://github.com/amantru/rome-internal/issues/868)) ([41e4838](https://github.com/amantru/rome-internal/commit/41e483881a5495eafb9c7ad22f099ce37a02a809))
* update version of app-web-sdk ([#785](https://github.com/amantru/rome-internal/issues/785)) ([1e5822b](https://github.com/amantru/rome-internal/commit/1e5822b4a2eb3393b306f5e28d5169b9743e3346))
* **workflow-studio:** fire-and-forget workflow_preview widget ([#867](https://github.com/amantru/rome-internal/issues/867)) ([998cd3f](https://github.com/amantru/rome-internal/commit/998cd3fa0e1cd08694efa34ae763506bfefe23d4))


### Bug Fixes

* **app-runtime:** enforce timeout on worker-rpc in-process path ([#723](https://github.com/amantru/rome-internal/issues/723)) ([9178f07](https://github.com/amantru/rome-internal/commit/9178f071ca5833385f796d57d58385e5f152c584))

## [0.2.1](https://github.com/amantru/rome-internal/compare/app-runtime-v0.2.0...app-runtime-v0.2.1) (2026-06-05)


### Features

* **app-runtime:** worker→main service proxies; unify schedule-event ([#641](https://github.com/amantru/rome-internal/issues/641)) ([f48991a](https://github.com/amantru/rome-internal/commit/f48991a3b80db575f7b572a97c9ac7fb9a07102c))
* **events:** expose the event catalog as a searchable action ([#635](https://github.com/amantru/rome-internal/issues/635)) ([7f06a09](https://github.com/amantru/rome-internal/commit/7f06a09474874e153a73d1c0a479f4586e4e4bab))
* **routines:** create routines from chat ([#631](https://github.com/amantru/rome-internal/issues/631)) ([7e3dc61](https://github.com/amantru/rome-internal/commit/7e3dc616fc9f74764ef7a1148aff5aa2a7451352))
* **system:** delete a routine by describing it (search_routine + delete_routine) ([#637](https://github.com/amantru/rome-internal/issues/637)) ([f57ee36](https://github.com/amantru/rome-internal/commit/f57ee36d06b9dc483b5657fa55189e2c6c97f918))
* **workflow:** create a workflow app as an atomic capability ([#632](https://github.com/amantru/rome-internal/issues/632)) ([5a741a2](https://github.com/amantru/rome-internal/commit/5a741a2b8d8c7758a582830d553ca063ad24c856))

## [0.1.1](https://github.com/amantru/rome-internal/compare/app-runtime-v0.1.0...app-runtime-v0.1.1) (2026-05-07)


### Features

* **approvals:** in-chat approval cards (simple approve/reject) ([#75](https://github.com/amantru/rome-internal/issues/75)) ([07e9bad](https://github.com/amantru/rome-internal/commit/07e9bad27262a9a54189e0e67b24afe5938ae8c0))
* **apps:** add app-template package and create-from-template flow ([#83](https://github.com/amantru/rome-internal/issues/83)) ([65d4cb1](https://github.com/amantru/rome-internal/commit/65d4cb1a6fcf5d7f35fe345bff483b4c259c1620))
* **obs:** OTEL telemetry SDK + span/metric instrumentation ([#52](https://github.com/amantru/rome-internal/issues/52)) ([aea6b77](https://github.com/amantru/rome-internal/commit/aea6b77726ccd67fe74d374f11f885a7046c0ad7))


### Bug Fixes

* **app-runtime-sdk:** lift dist-pointing exports to top level so published package resolves ([#150](https://github.com/amantru/rome-internal/issues/150)) ([e852e6b](https://github.com/amantru/rome-internal/commit/e852e6b3e259f63c85b57dc81fb787d442e8b633))

## 0.1.0

### Minor Changes

- e49cb66: Backfill the first real publish since `0.0.1` was pinned to npm. Changes accumulated on `main` without a bump; this changeset ships them in one go.

  User-visible additions:
  - New IPC subsystem: `IpcRpc`, `getWorkerIpc`, `createWorkerProcessTransport`, `createChildProcessTransport`, plus `IpcRpcTimeoutError` / `IpcRpcDisconnectError` / `IpcStreamError` and the `IpcMessage` / `IpcTransport` / `IpcCallContext` / `IpcInboundStream` / `IpcOutboundStream` types. Apps can now talk to a worker over IPC without owning the framing.
  - `AgentMessage` carries accounting and turn metadata: new `AgentTokenUsage`, `AgentContextUsage`, `AgentAccounting` types, with `accounting?` on `result` / `error` and an optional `turnId?` on `session_init`.
  - `OutgoingMessage.turnId?` lets channels correlate outbound messages with the agent turn that produced them (web chat groups concurrent turns by it; other channels may ignore).
  - `NormalizedMessage.channel` accepts `"telegram_user"` (Telegram user-account login).
  - `tool_use` / `tool_result` now carry an `id` / `toolUseId` and optional `startedAt` / `endedAt`. **Breaking** for any consumer that constructs or pattern-matches these variants — the result variant's tool-call id moved from no-id to `toolUseId`, so subagent boundaries can pair calls correctly. This is what forces a `minor` (rather than `patch`) bump under `0.x.y`.
  - `tsconfig.app.json` is now exported (`./tsconfig.app.json`) and shipped in `files`, so consumers can `extends` it directly.

  `@rome-os/app-web-sdk` has no publishable-surface changes since `0.0.5` (only a CLAUDE.md doc landed) and is intentionally omitted from this changeset — the release workflow will skip it.
