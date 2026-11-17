# Concierge eval

`pnpm concierge:eval` measures how much the [Concierge](architecture/concierge.md) says against a fixed owner script. Each round starts from the same frozen snapshot of a dev stack, so memory and chat history are equal across rounds and across prompt versions. It is a dev tool under [`scripts/concierge-eval/`](../scripts/concierge-eval/), and the product never ships it.

## Setup

1. Start the stack with `pnpm dev:all` and pick the Concierge's model in the main chat. Topic chats start on the main chat's model.
2. If the `no-response` scenario should run, add `CONCIERGE_TASK_WAIT_EXPIRY_MINUTES=3` to the root `.env` of the checkout that runs the stack, then run `docker compose -f compose.dev.yml up -d rome` there. Without it the eval skips that scenario.
3. Freeze the state every round starts from:

   ```bash
   pnpm concierge:eval --snapshot
   ```

   The command stops the `rome` container, copies its state, and starts it again. The copy holds `rome.db` with its WAL, Concierge memory, the project files, and the provider's thread state that the database points at. Sign-in files and logs stay out, so a restore never rolls back a refreshed sign-in. Snapshots live in `~/.rome-worktrees/<slug>/concierge-eval/<name>`, `frozen` by default. The eval works on this checkout's stack, named by its slug from `scripts/worktree-slug.sh`. For another stack, pass `--container` and `--base-url`. A snapshot name is letters, digits, `.`, `_` and `-`, starts with a letter or digit, and holds no `..`.

## Run

```bash
pnpm concierge:eval --label before --rounds 3
```

Each round restores the snapshot, waits for `/api/health`, and plays every scenario in its own new topic chat, all at once. Add `--serial` to play them one at a time. The script plays the owner. It answers question cards with their first option and approves or rejects approvals as the scenario says. A step ends when the chat has no running turn and no task active or waiting on the owner for 45 seconds (`--settle`), or after 25 minutes (`--timeout`).

`--compare <label>` puts an earlier label beside this one. `--report <label>` rebuilds a label's summary and comparison from the saved rounds without running anything. A summary judges again whether each expected result reached the owner, from the messages each round kept, so every label is judged by the current scenario rules. `--only ask-one,quick` plays some scenarios only, for debugging.

Results go to `.concierge-eval/<label>/`, which git ignores:

- `round-N.json` holds every metric, the classified messages and the check notes.
- `round-N.md` holds the round's table, its failed checks, and each message flagged as an echo or an acknowledgement, to check by eye.
- `summary.md` holds the mean and range of each metric over the label's rounds.
- `../compare-<a>-vs-<b>.md` holds the two labels side by side, over the scenarios both played, and warns when their models or scenario versions differ.

A further run with the same label adds rounds to it.

## Scenarios

The scenarios live in [`scenarios.ts`](../scripts/concierge-eval/scenarios.ts). A change to one makes earlier labels incomparable, so it bumps `SCENARIOS_VERSION`.

| Scenario | The owner |
|---|---|
| `ask-one` | starts a task whose only job is one question, and answers it. |
| `approve` | starts a task that asks for an approval, and approves. |
| `reject` | starts the same kind of task, and rejects. |
| `quick` | asks for the weather, which the Concierge answers itself. |
| `research` | asks for a comparison with a real result to report. |
| `no-response` | starts a task that asks a question, and never answers it. |
| `several` | sends three requests in one message. |
| `follow-ups` | starts a task, replies to its result with Reply, then sends a plain follow-up. |
| `daily` | starts a task, then replies to its result asking for it every day at 10:00. |

## Metrics

Every metric comes from the stack's database, read inside the container. The script never opens the database from the host.

| Metric | What it counts |
|---|---|
| Owner msgs, Concierge msgs, Per owner msg | Messages in the scenario's chat. A card's answer is not an owner message. |
| Task cards, Ask cards, Forwards, Says | The Concierge's messages by kind. Ask cards include its own question cards. |
| Echo | A say or forward of at most 200 characters, sent after a card settled, that names the owner's pick or the card's outcome (approved, rejected, expired), and carries none of the scenario's expected result. |
| Ack | A say or forward that opens with an acknowledgement or announces what it will do ("Got it", "I will…", "好的"). |
| Bursts | Runs of two or more Concierge messages, each within a minute of the one before, with no owner message or card answer between. |
| Turns, Silent turns | Concierge turns in the chat, and those that sent no message. |
| Prompt, Cached and Out tok/turn | The mean prompt size (input, cache read and cache write together), cache-read and output tokens of the chat's Concierge turns. The prompt sum fits Anthropic, which reports the cache apart from the input, so compare labels on one provider. |
| Checks | The decision was asked: every task that asked the owner something had its card shown. The result reached the owner: each expected result matched a Concierge message that is not an acknowledgement or an announcement, and a comparison names at least two of the things it compares. Scheduled: recurring work became a Concierge scheduled task of the chat, and no task chat set up a routine of its own, apart from the checks it defers. Nothing was dropped: every owner message was answered or reacted to, every task ended as the scenario expects, and each file it names was or was not written. |

Echo and Ack are heuristics. Read the flagged messages in `round-N.md` before trusting a change in either.

The `no-response` scenario measures only what the Concierge says when the wait expires. The digest that lists the task runs at the owner's digest times, so a round does not reach it.

## Timing

Rome times every Concierge turn, in the product and not only in the eval. A turn the owner's message starts counts from the moment the send reaches Rome. A turn Rome starts, such as one that relays a task's result, counts from its start. Housekeeping turns, which say nothing, are not timed. Each turn ends in one log line, `concierge.turn.timed`, and three histograms, labelled by trigger (`guardian` or `system`), model, effort and session (`warm` when the chat's session was open, `cold` when the turn opened one):

| Histogram | Until |
|---|---|
| `rome.concierge.turn.ack` | the first sign the owner sees: 👀 working, a reaction or a message |
| `rome.concierge.turn.first_say` | the first message the turn said lands in the chat |
| `rome.concierge.turn.duration` | the turn ends |

The log line adds the time until the model turn started (session acquire, open and any wait for a renewal), the model calls and tool calls, each tool's count, the context the turn ended with, and its input, cache-read, cache-write and output tokens. `rome.model.turn.ttft` measures the first plain text of a model turn, which a Concierge turn does not send, so read these for the Concierge instead.

## Baseline

`pnpm concierge:baseline` plays the scenarios of [`baseline-scenarios.ts`](../scripts/concierge-eval/baseline-scenarios.ts), one or more for each kind of turn the Concierge handles: chat, a simple question, a quick lookup, a reasoning question, a simple task, a heavy task, a task's relayed result and recall from earlier in the chat. It plays one model and effort per run, so runs of several configurations compare on latency and quality:

- Each of those scenarios also runs in Chinese, `zh-` before its id, with a Chinese rubric ([`baseline-scenarios-zh.ts`](../scripts/concierge-eval/baseline-scenarios-zh.ts)).
- `multi-turn` and `zh-multi-turn` are chats of twelve messages. The same kind of quick sum comes early, midway and late, so a late answer that grows counts as drift, and the second-to-last message asks for facts from the first two.
- `long-context` first pastes four long parts of a diary, about 45,000 tokens in all, then times a few simple turns, which is the tail of the latency spread. The pasted messages are setup: their turns stay out of the timings, and the judge sees only their first lines.

```bash
pnpm concierge:baseline --config opus-low --model claude-opus-5-5 --effort low --runs 3
pnpm concierge:baseline --report
```

The `lookup-memory` scenario asks for a fact from the Concierge's memory. Run `scripts/concierge-eval/seed-baseline.sh` on the stack before you freeze the snapshot, so every run starts with it.

`--model` is a model selection id, which the eval picks for each scenario's topic chat as the composer's model menu does. `--effort` labels the run. A Concierge chat runs at its own effort whatever a message asks, which is `reasoningEffort` in [`concierge.yaml`](../packages/core/agents/concierge.yaml), so set that to the effort the run measures, on the stack, without committing it. Each play checks the effort its timed turns ran at against the label, and an `effort:` note marks a mismatch. Each run restores the snapshot first, as `concierge:eval` does, and plays the scenarios one at a time, so their timings do not compete. `--concurrency` plays several at once, and `--no-restore` keeps the stack as it is between runs. `--max-load 15` waits before each scenario until the machine's 1-minute load average is under 15, and each play keeps the load when it started and ended.

Each scenario reads its timed turns from the stack's log and checks what they did: answered inline or started a task as the scenario expects, searched the web at most three times, said no filler, and named the expected fact. The standing rules below are checked as well. A judge model then scores the answers from 1 to 5 against the scenario's written rubric. The judge runs through the Claude Code CLI on the host, `claude -p` on `--judge-model` (Opus 5.5 by default), and may search the web to check a fact. `--no-judge` skips it.

Results go to `.concierge-eval/baseline/<config>/run-N.json`, with the machine's load average before and after each run. `--report` writes `.concierge-eval/baseline/report.md`. It opens with one row for each configuration over every scenario: checks passed, rule regressions, Chinese style and drift notes, the judge's mean in English and in Chinese, and the first say of inline, long-context and task turns. Then it lists each rule note, and gives a table for each scenario, with a row for each configuration, giving p50 and p95 of each timing, the mean model calls, tool calls and cache tokens, how many runs passed their checks, and the judge's mean score.

### Rules

[`baseline-rules.ts`](../scripts/concierge-eval/baseline-rules.ts) checks the rules the Concierge keeps in every chat, so a prompt change that breaks one shows up as a regression:

| Note | The rule |
|---|---|
| `rule:` | A thanks gets no 👀, neither the working status nor a reaction. A message carries at most one emoji. A task's result never sends the owner to the task chat. A simple answer ends on the answer, with no question back and no offer of more. |
| `zh:` | A Chinese chat gets Chinese answers with full-width punctuation, and "Agent" stays in English. |
| `drift:` | In a long chat, a late quick answer is at most twice as long as its early twin, or 150 characters longer. |
