# Spike: Rome turns follow SDK turns (DO NOT MERGE)

Task t-8e1a6e90. This tests option C of
`zhangfand/rome-work@ab8a3e8:_conductor/tasks/t-8e1a6e90/research/simplify-turns.md`.

**The model:**
- A Rome turn opens when an SDK turn starts and closes on that turn's result.
- The SDK's echo decides which messages the turn answers.
- Messages are fire-and-forget. A map from message id to the waiting caller
  connects each reply to its caller.

**What is on this branch** (from `main` at `b8db82e`):

| File | What it is |
|---|---|
| `sdk-turn-projection.ts` (97 lines) | Reads turn start, the ids a turn answers, and turn end straight off the SDK stream. It holds no waiting state. |
| `anthropic-provider.ts` | #524's routing is replaced by the projection: −137 / +14 lines against `main`. <ul><li>No reader pause.</li><li>No steer, carried-steer or minted-id bookkeeping.</li><li>Every SDK turn reaches the consumer.</li><li>Sends and steers are fire-and-forget.</li></ul> |
| `spike/sdk-conversation.ts` | A stand-in for what AgentSession would hold: one map of waiting callers, plus the turn now streaming. <ul><li>A send nobody echoes back is ignored with a warning.</li><li>Callers still waiting when the stream ends fail with a warning.</li><li>`exclusive` sends wait until the conversation is idle, as `summon` and API callers would.</li></ul> |
| `spike/run-sdk-turns.mts` | The 9 cases, run against the real SDK. |

The spike doesn't change AgentSession, webchat, Codex or the 28
provider unit tests that pin #524's event sequences.

## How to run

You need a logged-in Claude CLI, or `ANTHROPIC_API_KEY`. No Rome instance is
started.

```sh
pnpm install --frozen-lockfile
pnpm --filter @rome-os/app-runtime run build   # if typecheck complains about stale app-runtime types
cd packages/core
NODE_ENV=development npx tsx src/core/spike/run-sdk-turns.mts            # all cases
NODE_ENV=development npx tsx src/core/spike/run-sdk-turns.mts 3 9        # cases whose name starts with 3 or 9
```

Each case writes `$SPIKE_OUT/<case>.json` (default `/tmp/spike-sdk-turns`).
The file holds:
- the turns, with what each answered, its tools, cards, `submit_output`
  calls and timings;
- each caller's reply;
- warnings and a timed log.

Committed runs are in `results/`.

## Results (SDK 0.3.281, `claude-haiku-4-5`, 2026-10-01)

The runs:
- **Runs 1 and 2:** two full runs of every case.
- **Case 5:** two extra re-runs.
- **Run 3:** in `results/` (see the end of this file).

"Results naming it" counts the results whose echo listed that message.
**Every message got exactly one, or failed cleanly when the process was
killed.**

| # | Case | Turns seen (what each answered) | Results naming each message | What callers got |
|---|---|---|---|---|
| 1 | Background task finishes while idle | `[A]`, then the task's own turn `[]` (started by a model frame, no replay), then `[B]` | A 1, B 1 | **Webchat stream:** A's turn, then a turn answering nothing that reported the task's result ("Background task completed…").<ul><li>**Today:** this turn is hidden.</li><li>**Under this model:** it is just shown.</li></ul>B, an exclusive send like `summon`, got "MARKER-41" in its own turn. |
| 2 | Late follow-up (sent while the final answer streams) | `[A]`, then `[S]` | A 1, S 1 | **The SDK carried S, and it became its own turn, echoed `[S]`.**<ul><li>No adoption and no pause.</li><li>S's caller got its own reply.</li></ul> |
| 3 | Follow-up folded in during a tool call | one turn `[A,S]` | A 1, S 1 | **Both callers got the same combined reply ("OK BANANA").**<ul><li>S was read (replayed) at the tool boundary.</li><li>S's echo arrived only on the result.</li></ul> |
| 4a | `summon` sent straight into a running task turn | `[A]`, then the task turn, which began answering `[]` and ended `[Q]` | A 1, Q 1 | The SDK folded Q into the task turn at the next tool boundary, and that turn took Q's echo.<ul><li>**Q's reply was that turn's result ("SUMMONED").**</li><li>That is the accepted combined-reply behaviour.</li></ul> |
| 4b | `summon` with the idle gate | `[A]`, then the task turn `[]` ("printed: DONE-77"), then `[Q]` | A 1, Q 1 | **Q waited for the task turn to finish, then got its own turn.** |
| 5 | Two messages sent close together | `[X]`, then `[Y]` (4 of 4 runs, cold and warm) | X 1, Y 1 | **No batching:** each message got its own turn and reply.<ul><li>On a cold first turn, Haiku answered the bare "Reply with exactly ONE." with a question.</li><li>That is model behaviour: the warm variant 5b answered ONE and TWO.</li></ul> |
| 6a | Error result: `error_max_turns` | `[A]` `error_max_turns`, then `[B]` | A 1, B 1 | A's caller got the error terminal, and the next exclusive send worked. |
| 6b | Error from the API: unknown model | `[A]`: the SDK's synthetic "There's an issue with the selected model…" success result | A 1 | **The echo is present, so the error reached A's caller.** |
| 7 | SDK process killed mid-turn (`SIGKILL` to the CLI) | `[A]`, open when the process died | A: none; **process exit** | **A failed cleanly** ("the SDK stream ended without a reply", plus a warning).<ul><li>The provider reported "terminated by signal SIGKILL" and closed the session.</li><li>A later send was rejected with "ModelSession is closed".</li><li>AgentSession's existing reopen-on-next-turn path would take over.</li></ul> |
| 8 | Interactive card (`ask_question`) | `[A]`, holding the card, then `[B]` for the answer | A 1, B 1 | **The card was attributed to the turn answering `[A]`.**<ul><li>The turn ended normally after parking.</li><li>The human's answer ("Red.") was a new message with its own turn ("You prefer red.").</li></ul> |
| 9 | `submit_output` in a turn a follow-up folded into | one turn `[A,S]` | A 1, S 1 | **One `submit_output`, whose payload already included S's "banana".**<ul><li>At call time the spike tied it to `[A]` only, because S's echo arrives on the result.</li><li>Both callers got the same reply.</li></ul> |

**Turn ids and metrics.** Every SDK turn got its own Rome turn id, including
background-task turns, and a duration. Each caller has a "send → first
echoing frame" time. Examples from run 1:
- cold start: about 4.9 s;
- warm exclusive send: about 0.6 s;
- the summon in 4a: 7.3 s, because it waited for the next tool boundary.

## Findings that production must handle

None of them breaks the model.

1. **A fold inside a turn Rome started is only named on the result.**
   - In a turn opened by a typed prompt, frames after the fold carry no echo.
     That is documented: "a typed prompt keeps that uuid for its whole turn".
   - The replay ("read") is the in-turn signal that the message joined.
   - **Fix:** attribute turn-level outputs (`submit_output`, cards) when the
     result arrives. The live UI can mark a message "joined" at its replay.
   - Case 9 shows why: attribution at call time listed only A.
2. **A fold into a turn the SDK started** (4a): the turn takes the folded
   message's echo, and its result is that caller's reply.
   - **Fix:** a caller's live stream should start at the echo, or the replay,
     not at the turn's start.
   - Otherwise a `summon` sees the task's earlier tool output. Its final reply
     is correct either way.
3. **A killed process:** callers fail with a warning, and the session reports
   itself closed. Nothing else is needed.
4. **Unchanged from #524:** every task notification runs the model, and
   that now shows in the chat.

**Not covered by this spike:**
- real AgentSession and webchat client wiring;
- Codex;
- forks;
- turn middleware that answers without the model;
- approvals and `defer`;
- structured-output (`outputSchema`) sessions;
- stop/interrupt of a turn the SDK started.

None of these talks to the SDK differently. They are integration work for the
production PRs.

## Size of the production change (estimate)

Baseline:
- **`anthropic-provider.ts`** on `main`: 1,182 lines, carrying #524's routing.
- **#585's router:** 227 lines, plus 236 test lines and its provider and
  AgentSession hooks. It is unmerged.
- **AgentSession:** 3,624 lines.
- **`AgentInputQueue`:** 222 lines.

| Area | Delete | Add |
|---|---|---|
| Provider routing (#524) | ~140 (this spike: −137) | ~100 (projection) |
| #585 router and hooks | ~470 code + 236 tests, never merged | 0 |
| Provider routing tests | ~400 (13 "SDK-started turn" cases and pinned sequences) | ~250 scenario tests |
| `AgentInputQueue`: steer dispatch, sealing, adoption | ~130 | ~20 |
| AgentSession: sink-per-send, no-sink drop, `turnMutex` for every caller | ~200-300 | ~250-400 (turns from SDK turn events, waiting map, idle gate, session turns, result-time attribution) |
| Codex provider: emit turn events | 0 | ~30 |
| Webchat route and client: one stream per SDK turn answering 0..n messages | ~50 | ~150-250 |

**Net code:** roughly flat against `main`, from about −500 to +550 code
lines, and about 700 lines smaller than `main` plus #585. The real reduction
is in state:
- **Today** (main plus #585): 9 router fields, steer adoption, the pause, and
  seven input states.
- **After:** one waiting-caller map, the turn now streaming, and three input
  states (sent, read, answered).

## Recommendation: go

**The decisive result:** in every run of every case, each message got exactly
one result naming it, or failed cleanly when its process died. Nothing needed
Rome to wait, pause or guess.

**Production PR plan:**
1. **Provider: project SDK turns.** Replace #524's routing with the
   projection. Emit turn start, answers and end as a core-internal
   `ModelSession` event (not a public app-runtime type). Make steers
   fire-and-forget. Have Codex emit the same events. Rewrite the routing tests
   as scenarios.
2. **AgentSession: open turns from SDK turns.** Add the waiting-caller map.
   - `sendTurn` and `submitInput` keep their signatures; a caller's handle
     binds to the turn that echoes its id.
   - An idle gate replaces `turnMutex` for exclusive callers (`summon`, API,
     routines, system turns).
   - SDK-started turns become session turns, published to subscribers and
     metrics.
   - `submit_output` and cards are attributed when the result arrives.
   - Callers fail with a warning if the process ends.
3. **Webchat: one stream per SDK turn, fire-and-forget inputs.**
   - `AgentInputQueue` shrinks to send-through, with sent → read → answered.
   - The route maps one turn to 0..n messages.
   - The client renders turns answering several messages, and task-result
     turns.
4. **Then:**
   - #585 can be closed; it's your call. Its P1 can't happen in this model.
   - Rebase #589 and #590 onto PR 2.
   - The planned "Rome starts a turn for task results" PR is no longer
     needed.
   - PR 4, the task-list UI, continues as planned.
