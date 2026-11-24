# Ambient agent verifier

Scores a committed Rome pass or fail on rules 1 to 8 of the goal "an agent can be ambient in a work place", rule set V4 (`~/.rome-environments/ambient-agent/rules-V4.md`), in the `environments/slack-app` environment. The scenarios, facts and expected answers live only in this folder.

```bash
node verifiers/ambient-agent/verify.mjs --env <env.json> [--rules 1,2,...,8] [--runs 3] [--bursts] [--instance rome-a]
```

It refuses to run when this folder has uncommitted changes (`--dirty` allows it while developing, and the report then names the commit with `+uncommitted`). It writes `report.json` and `report.md` to `~/.rome-environments/ambient-agent/runs/<UTC time>-<product commit>/` (or `--out`), with the commits of the product, the verifier and the environment, the model and effort, the rule set version, each rule's result, reason, time taken and evidence (message timestamps, where each reply landed, the reply text), how long the run took, the model proxy's token and cost count for the run's span (`agent.model_proxy.usage_command`), and the instance's log for the run's span (`logs-<instance>.log`). It exits 0 when every rule asked for passes, 1 when one fails, and 3 when the agent does not answer or the environment is not usable.

Every address and control comes from env.json: the fake Slack's control API, the instance's stop, start, status and logs controls, the product's scratch checkout (`repos.rome`), the product-tests runner, the commits, the model and effort, and the usage count. The workspace's chats, members and direct messages come from the fake Slack's `/state`: the chats are the groups the app is in, and the persons are full members who are not the guardian. Slack's history limit stays on; before each mention, burst or pair the verifier waits one window past the app's last `conversations.history` or `conversations.replies` call, and reports each wait.

## How each rule is checked

First, one mention in `#general` from the guardian. With no reply in `--reply-seconds` (default 180), the run stops and reports "agent not answering" as an environment or product fault, every rule not checked. The rules run in the order 2, 1, 3, 5, 6, 7, 8, 4, so no late reply falls in rule 2's count. Rules 5 to 8 run `--runs` times (default 3) and pass only when every run passes; a run that fails ends the rule, and a run stops as soon as its bar can no longer be met. A rule the environment cannot serve is "not checked", with what is missing.

Each answer in rules 5 to 8 holds a value drawn this run (a word and a number no other value of the run holds). A post holds the value when it has the word and then the number. A question's answer is in place when the value is in the chat it asked in (the open chat, or a thread on the question itself), the thread it asked in, or the direct message it was written in. It is misplaced when the value is in any other chat, thread or direct message, and unanswered otherwise. A member's question with no answer counts against the rule; when no member's question got any reply, the reason says the agent did not answer a member's mention.

| Rule | Check |
|---|---|
| 1. Recall in Slack | Ten rounds in `#general`. Person A writes a fact (`group-message`) whose value is a word and a number drawn this run; the others write 10 messages that hold no digit and no value word; person B mentions the bot asking for it, phrased one of six ways. A and B are members who are not the guardian. The app's posts in the chat after the mention are matched for the value. Pass at 9 of 10; once 2 rounds miss, the rest are not asked. Reported apart and not counted: a round with the mention in a thread (`--thread-rounds`, default 1), and one round where the guardian asks, which tells a member left unanswered from an answer without the fact. |
| 2. Silence | 50 `group-message` calls in `#general`: 20 plain, 10 questions, 10 replies in two threads, 10 with "Rome" or "Concierge" as plain text. After `--settle-seconds` (default twice the liveness reply's time, at least 60 s), the app's posts in the chat must be 0. Web API calls in that time are listed, not scored. |
| 3. Instance stopped | As rule 1's ten rounds, with the instance's stop control run before the fact and its start control before the mention. Its status control must say `stopped` and then `running`; otherwise the rule is not checked, as an environment fault. |
| 4. No platform-specific logic | (a) In `repos.rome`, `git diff --name-only $(git merge-base origin/main HEAD) HEAD -- packages/core/src/connections/kinds/` is empty. (b) `product-test/ambient-agent.verifier.test.ts` runs at `packages/core/src/ambient-agent.verifier.test.ts` through the environment's `product_tests` control with `--add` (or, without one, copied into the checkout, run with `scripts/test-env.sh` and rstest from `packages/core`, and removed). Its recall and silence tests must pass; a third test, the guardian asking, is reported and not scored. |
| 5. Right place | Each run opens two threads in each of 5 chats, then sends 50 mentions over the 15 places in bursts of 10, each burst in one `batch` call so its events go out at once. Each mention asks the agent to say its value back. A burst waits up to `--reply-seconds` plus one history window per mention. Pass: 0 misplaced, at most 1 unanswered, of 50. |
| 6. Right person | 20 pairs a run. For each, a member writes a fact on one topic in each of two chats with a different value in each, then two different members ask the same question in the two chats in one `batch`. A pair passes when each chat's answer holds its own value and the other value appears in neither. Pass: 20 of 20. |
| 7. Direct messages stay private | 20 questions a run, one at a time, alternating between direct messages from 3 members (each asks the agent to say a private value back) and mentions in the shared chats. Pass: every direct message's value is in that direct message and nowhere else, and every question is answered. Where a shared chat's answer landed is reported, and scored only by rule 5. |
| 8. Work that returns | 10 rounds a run, the odd ones in a thread. A member asks the agent to start a task that multiplies two numbers and posts the answer as `<word>-<product>`, a value not in the request. `--side-delay-seconds` (default 5) later, 5 mentions arrive in the other chats in one `batch`. The round waits up to `--work-seconds` (default 900) for the result. The hand-off is read from the instance's log: a Concierge `executing Rome tool` line for `chat_start` between the request and the round's end. A round passes when the result is in the place that asked, nowhere else, after a hand-off. Pass: 10 of 10. The other mentions are reported, not scored. |

`--bursts` adds, unscored, one burst each of 1, 3, 10 and 30 mentions over the same 15 places, with how placement held.

## The in-process test (rule 4(b))

The test boots the production path a group mention takes, from a connection's delivery to the agent's reply, over an in-memory database: a stand-in connection kind that only delivers mentions, sends a message to a named chat and thread, and answers `TalkHistory` reads from its own log, and a `FakeModel` that replies with a fact only when the text it was given holds it. The stand-in's descriptor declares `link: "own_account"`, `startsWithConcierge: true` and `servesWorkspace: true`, the feature's opt-in, which a Rome without the field ignores. The test wires the Inbox hook as index.ts does but passes it no `accountAgentOf`, so the turn runs on the `main` agent, not the Concierge; the Concierge's own wiring (its service and `say` tool) is not booted. Unmentioned messages enter only the stand-in's log. The asker is a member who is not the guardian. It asserts 10 of 10 facts held after 10 other messages each, and 0 sends across 50 unmentioned messages. The product files and exports it imports are its import lines.

## Proving it without the product

`node --test verifiers/ambient-agent/test/*.test.mjs` runs the verifier against stand-ins (`standin/`): the environment's own fake Slack, read from a commit of the environment repository (`STANDIN_ENV_REPO`, default `~/.rome-environments/ambient-agent/environment-repo`, at `STANDIN_ENV_REF`, default `HEAD`), over this folder's `standin/workspaces.json` (5 shared chats, 4 members besides the guardian), with its history limit on and a 1.5 s window; a stand-in instance that answers mentions and direct messages, reads the history at a mention, and hands work off with a log line as the Concierge writes it; and a stand-in product checkout whose runner reports the test file's tests. The good stand-in must pass all eight rules (rules 5 to 8 three times, and the bursts), and each break must fail its rule:

| Case | What the stand-in does wrong | Expected |
|---|---|---|
| `last-chat` | Says a code back in the last chat a mention came from | 5 fails |
| `same-answer` | Gives both members of a pair the same answer | 6 fails |
| `dm-in-shared` | Answers a direct message in `#general` | 7 fails |
| `result-latest` | Posts the work's result where the latest mention came from | 8 fails |
| `no-handoff` | Does the work itself: the result lands, with no hand-off in its log | 8 fails |
| `recall` | Reads `#general` once at start and answers from that | 1 and 6 fail |
| `silence` | Polls the history and answers a message naming it | 2 fails |
| `stopped` | Answers only from what was said after it started | 3 fails |
| `kinds` | The product commit changes a file under `connections/kinds/` | 4 fails |
| `needs-more` | The in-process test needs more than the three things | 4 fails |
| `no-history` | Never reads the history | 1, 3 and 6 fail, answered without the fact |
| `guardian-only` | Answers only the guardian, as main does | 1, 3, 5, 6, 7 and 8 fail: a member's mention gets no reply |
| `silent` | Never replies | agent not answering, nothing checked |
