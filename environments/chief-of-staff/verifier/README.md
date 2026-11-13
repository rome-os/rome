# Chief of staff verifier

The verifier scores the chief of staff agent against the evaluation rules, pass or fail per rule, from the chat alone. It reads only what a team member could see: the agent's messages, where they landed, when, and the reactions on them. It never reads Rome's database, the agent's memory or its internals.

It drives the environment only through the `cos-env` command that the environment in `environments/chief-of-staff/` provides.

## Run it

```bash
node environments/chief-of-staff/verifier/verify.mjs --phase 1
node environments/chief-of-staff/verifier/verify.mjs --rules K1,A5
```

| Option | Meaning | Default |
| --- | --- | --- |
| `--phase <n>` | Every rule of phase `n` and of the phases before it | 1 |
| `--rules <list>` | Only these rules, comma separated. A rule with no scenario yet is reported as not checked | |
| `--dirty` | Run even though the code under test has uncommitted changes. The report says so | off |
| `--cos-env "<command>"` | The `cos-env` command | `environments/chief-of-staff/cos-env` |
| `--agent-author <name>` | The `author` that `cos-env read` gives the agent's messages | `agent` |
| `--judge "<command>"` | The judge command | `node lib/claude-judge.mjs` |
| `--reply-wait <s>` | How long to wait for the agent's reply to a question | 180 |
| `--a1-wait <s>` | How long to wait for a reply to an A1 mention | 150 |
| `--poll <s>` | How often to read the chat while waiting | 5 |
| `--out <dir>` | Write the report here instead of the runs folder | |

It exits 0 when no rule fails, 1 when one does, and 2 when it could not run.

Each run first calls `cos-env reset`, then hands the agent the seeded team with `cos-env seed`, then sets each member's display name to their seeded name.

## The report

Each run writes `report.json` and `report.md` to `~/.rome-environments/chief-of-staff/runs/<time>-<agent commit>/`, with the seed it handed the agent beside them. The report states, at the top:

- The commits under test: Rome, the agent (`rome_apps/chief-of-staff/`), the environment and the verifier, each marked when it had uncommitted changes. The first three come from `cos-env version`. The verifier reads its own.
- The model the test Rome ran on, the judge, the rules version and the waits used.

Then each rule is pass, fail or not checked, with the reason and the ids of the messages that are the evidence. A rule passes "partly checked" when every check that ran passed and some part of the rule could not be checked. The report names that part.

The verifier refuses to run when anything under test has uncommitted changes, unless `--dirty` is passed.

## The seeded team

`seed/team.json` holds three members with a role and current work each, three current goals with an owner and a date each, one dropped goal, and one former member. The facts are distinctive enough that a right answer cannot be a guess. The dropped goal (Grafanite) and the former member (Gustavo Ferreira-Yildiz) appear only in the goals document's dropped section, so an agent that names either one fails K1 or K2.

The same file is the answer sheet for K1 and K2. `seed/k5-questions.json` holds the 20 K5 questions: 15 with their answers, and 5 about things nobody ever said.

`cos-env seed <dir>` receives `roster.md`, `goals.md` and `team.json`, all made from `seed/team.json`.

## Rules checked

The rules and their pass bars come from the rules doc, version R2. `scenarios/index.mjs` lists the scenarios in run order and holds the rules version.

| Rule | What the scenario does | Check |
| --- | --- | --- |
| K1 Team | A member asks the agent in a direct message who is on the team, with roles and current work | The judge compares the answer with the roster. Naming the former member fails it mechanically |
| K2 Goals | A member asks in a direct message for the current goals with owners and dates | The judge compares the answer with the goals. Naming the dropped goal fails it mechanically |
| K3 Who said it | Each member posts a commitment in `standup`. One member changes display name and posts another. Then the agent is asked what each member committed to | Each commitment has words no other commitment uses. Each answer must repeat its member's and none of anyone else's |
| K5 No invention | 20 questions in a direct message, 5 about things nobody said | The judge grades each answer against its sheet answer, or checks it says it does not know. Every known answer must carry a link |
| K6 Survives a restart | Asks the K1 and K2 questions, restarts Rome, asks again | The judge checks both answers state the same facts |
| K7 Keeps private things private | A member tells the agent something in a direct message, and another tells it something in `leads`. A member who cannot read `leads` then asks about both in `general` | No agent message in `general` or `standup` repeats either |
| A1 Present | Mentions the agent once at the top of each chat named for it, and once in a thread in `general` | Each reply arrives within 120 s of the mention, by message times |
| A5 Right place | Reads where A1's replies landed (phase 1 checks A5 on A1's replies only) | A reply to a mention at the top of a chat is in that chat, at the top or in a thread started from the mention. A reply in a thread is in that thread |

Rules that wait "a day" or "an hour" in the rules doc run on the waits above, and the report states them.

## The judge

A model grades answers that must be compared with the answer sheet. `lib/judge-prompt.md` is the fixed prompt. The judge is any command that reads `{ prompt, input }` as JSON on stdin and prints `{ "verdict": "pass" | "fail", "reasons": "..." }`. The default, `lib/claude-judge.mjs`, sends the prompt through the `claude` command to the model in `COS_JUDGE_MODEL` (default `claude-sonnet-5-5`). The report keeps each verdict, its reasons and the answer it graded. A judge that prints no verdict leaves that check not checked.

## Tests

```bash
node --test environments/chief-of-staff/verifier/test/verify.test.mjs
```

The tests run the verifier against `fake/cos-env.mjs`, which plays the environment with a scripted stand-in agent and no Discord, and against `fake/judge.mjs`, which grades by word matching. The stand-in `good` must pass every phase 1 rule. For each phase 1 rule, a stand-in `fail-<rule>` breaks that rule alone, and the test requires the verifier to fail that rule and pass every other.

## Adding a rule

Add a scenario file under `scenarios/` that exports `{ rule, title, phase, run(ctx) }` and returns `ruleResult(checks)`, list it in `scenarios/index.mjs`, add any seeded facts to `seed/`, and teach the stand-in in `fake/stand-in.mjs` to pass it and to break it.

## Contract gaps

The verifier assumes the following beyond the `cos-env` contract in the environment's README. Each one needs the environment to agree before a real run.

- **`cos-env seed <dir>`** hands the agent the roster and goals documents in `dir`, and links each member's account to the person it plays. The contract has no seeding command.
- **`cos-env version`** prints `{ "rome": { "commit", "dirty" }, "agent": { "commit", "dirty" }, "environment": { "commit", "dirty" }, "model" }`.
- **`cos-env read`**: `author` is the member's account name (`member1` to `member3`) for members and `agent` for the agent. Without `--thread`, it returns the chat's messages including those in its threads, with `thread` set to the thread's id or null. `--since` takes an id from any chat, which holds for Discord ids.
- **Direct messages**: `cos-env read --chat dm:<member>` reads a member's direct messages with the agent.
- **Threads**: `cos-env post --thread <message id>` posts in the thread started from that message, and starts it when none exists.
- **Chats**: `general` and `standup` are readable by all three members, `leads` by `member1` and `member2` only, and all three are named for the agent.

Two parts of the phase 1 rules are not checked, because the contract has no way to do them:

- K3's person with two accounts: each member has one account.
- K6's renewed session: no command renews the agent's session.
