# Rome testkit

Boot the real wiring; fake only the edges. Tracking issue: [#763](https://github.com/amantru/rome-internal/issues/763).

**Status: provisional API.** Until a couple of conversion PRs have landed on top of it, expect signatures to shift. Record API decisions on the tracking issue.

## The rule

Fake a dependency only if it crosses the process boundary:

| Edge | Fake |
|---|---|
| Model API | `FakeModel` (scriptable `ModelProvider`) |
| Chat-network SDK | `FakeChannelEndpoint` (plays the remote side of the adapter); for adapter units, `FakeTelegramApi` (plays the Bot API server behind a real grammy `Bot`) |
| Wall clock | `FakeClock` (injectable `Clock` seam); `installTestClock()` for ambient-time code |
| Subprocess fork | avoided via `ActionEngine` `processRole: "worker"` (the harness does this) |
| Outbound HTTP | `createFetchRecorder()` (inject `recorder.fetch` via a module's `fetch?: typeof fetch` option) |

Everything else — repositories, ActionEngine, SessionManager, PromptBuilder, AgentRunner, ChannelManager — runs the production class over in-memory SQLite with real migrations. Don't hand-roll `{ … } as unknown as SomeRepository` stubs and don't `rs.mock` internal modules; if you feel the need to, the harness is probably missing something — raise it on #763 instead.

Assert **outcomes**, not stub call shapes: read the DB row, the outbound channel message, or the prompt the model received — not `expect(mock.run).toHaveBeenCalledWith(…)`.

## Usage

```ts
import {
  createTestRome, buildAction, recordingAction,
  text, result, invokeAction,
} from "../test/kit/index.js";

const sendMessage = recordingAction("send_message");
const rome = await createTestRome({ actions: [sendMessage.action] });

// Script the model (the one true fake in the agent stack)
rome.model
  .whenPromptIncludes("send hi")
  .reply(invokeAction("send_message", { to: "u1", body: "hi" }), result("Sent."));

// Drive a real turn: real AgentLoader/PromptBuilder/SessionManager/ActionEngine
const messages = await rome.runAgent({ prompt: "send hi", channelThreadKey: "telegram:t1" });

// Assert real outcomes
expect(sendMessage.calls).toEqual([{ to: "u1", body: "hi" }]);
expect(await rome.repos.actionExecutions.findByAction("send_message")).toHaveLength(1);

await rome.cleanup(); // always — restores env scoping, closes sessions/DB, removes temp dirs
```

Approval flows: record through `rome.actionEngine.run(...)` (the gate persists journal + payload for real), approve via `rome.repos.approvals.resolvePending(id, "approve")` or seed directly with `rome.seed.approvedActionApproval(payload)`, then drive `rome.approvalHandler.onApproved(id)`. See `src/actions/approval-handler.test.ts` for the reference conversion.

Channels: `rome.channel("telegram").send({ text: "hello" })` injects an incoming message at the adapter seam; `nextReply()` awaits what Rome sent back. (The inbox pipeline — the system-app message hook — is not booted by the harness yet; attach your handler under test via `onMessage`.)

Adapter units (testing the adapter itself, below the harness): inject through the adapter's factory seam — `new TelegramAdapter({ botToken }, fake.createBot)` with `const fake = new FakeTelegramApi()`. The fake is a *server*, not an SDK replica: `createBot` returns a real grammy `Bot` whose API transformer answers outbound calls with canned wire JSON, so middleware filters, init, and the long-poll lifecycle run grammy's production code instead of a hand-rolled imitation that drifts. Await `fake.untilPolling()` after `adapter.start()`, drive incoming traffic with `fake.emitUpdate(update)` (a Telegram `Update`, through real `bot.handleUpdate`), and assert the outbound contract on `fake.sent` (`{ method, payload }` pairs captured pre-serialization — an `InputFile` is still an instance, since multipart encoding happens in grammy's HTTP caller below the seam; methods the fake doesn't model throw instead of fake-succeeding); no `createTestRome()` and no DB needed. See `src/channels/telegram.test.ts` for the reference conversion.

## Notes

- `engine:` mirrors the daemon's ActionEngine wiring variations: `tracer` for real `action:*` spans, `onApprovalCreated` for the approval-card callback, `processRole: "main"` for tests that exercise the fork orchestration itself (stub `executeInSubprocess` — the fork is the edge), and `clock` to inject a time source.
- Clocks, by mechanism: `ActionEngine` and `RoutineEngine` take the production `Clock` seam (`src/lib/clock.ts`) — inject a `FakeClock` and drive it with `advance("30s")`; durations, row timestamps, and retry/cancel timers become deterministic, and global timers stay real. `installTestClock()` globally fakes timers via Rstest for code that still reads ambient time (croner schedules, ad-hoc `setTimeout`). Don't mix the two in one test — `FakeClock.advance()` settles fired work via `setImmediate`, which global fake timers stall.
- The default agent is `main` with `actions: ["*"]`. Pass `agents:` (e.g. via `buildAgentConfig`) to test allow-list gating or multi-agent setups.
- Path resolution (`~/.rome/<profile>`, project root) is ambient env until it grows a real seam; the harness scopes the write-backed locations (`HOME`, `ROME_PROFILE`, `ROME_PROJECTS_ROOT`) to a temp sandbox — so profile-backed *writes* land inside it and are deleted on `cleanup()`. Read-only repo roots stay real by default so `PromptBuilder` produces the production system prompt (CHARTER.md etc.); pass `repoView: "empty"` for a bare repo view. Because env scoping is process-global state, harnesses are strictly sequential: creating a second one before the first's `cleanup()` throws.
- `invokeAction` failures (unknown action, allow-list rejection, action throw) surface to the scripted model as an error-shaped `tool_result` — the same contract real providers deliver — so permission/unknown-action paths are testable.
- `FakeModel` turns always end with a terminal `result` block — the kit appends one if your script omits it, matching real provider behavior.
- `createFetchRecorder()` string rules match the **full** request URL exactly, so the test pins URL construction; an unmatched request rejects. Caveat: code under test often maps *any* fetch rejection to a benign result (`"unreachable"`), so a typo'd rule URL can silently satisfy a failure-path assertion — assert `recorder.unmatched` is empty (or check `recorder.calls`) when the outcome alone can't tell the two apart. Modules with the seam today: `rome-cloud-listing-client`, `bundle-fetcher`, `instance-identity`, `rome-cloud-relay`.
