# Concierge eval

`pnpm concierge:eval` measures how much the [Concierge](architecture/concierge.md) says against a fixed owner script. Each round starts from the same frozen snapshot of a dev stack, so memory and chat history are equal across rounds and across prompt versions. It is a dev tool under [`scripts/concierge-eval/`](../scripts/concierge-eval/), and the product never ships it.

## Setup

1. Start the stack with `pnpm dev:all` and pick the Concierge's model in the main chat. Topic chats start on the main chat's model.
2. If the `no-response` scenario should run, add `CONCIERGE_TASK_WAIT_EXPIRY_MINUTES=3` to the root `.env` of the checkout that runs the stack, then run `docker compose -f compose.dev.yml up -d rome` there. Without it the eval skips that scenario.
3. Freeze the state every round starts from:

   ```bash
   pnpm concierge:eval --snapshot
   ```

   The command stops the `rome` container, copies its state, and starts it again. The copy holds `rome.db` with its WAL, Concierge memory, the project files, and the provider's thread state that the database points at. Sign-in files and logs stay out, so a restore never rolls back a refreshed sign-in. Snapshots live in `~/.rome-worktrees/<slug>/concierge-eval/<name>`, `frozen` by default.

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
| Checks | The decision was asked: every task that asked the owner something had its card shown. The result reached the owner: each expected result matched a Concierge message. Scheduled: recurring work became a Concierge scheduled task of the chat, and no task chat set up a routine of its own, apart from the checks it defers. Nothing was dropped: every owner message was answered or handed to a task, every task ended as the scenario expects, and its file was or was not written. |

Echo and Ack are heuristics. Read the flagged messages in `round-N.md` before trusting a change in either.

The `no-response` scenario measures only what the Concierge says when the wait expires. The digest that lists the task runs at the owner's digest times, so a round does not reach it.
