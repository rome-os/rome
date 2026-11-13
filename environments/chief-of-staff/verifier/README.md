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
| K1 Team | A member asks in the private chat who is on the team, with roles and current work | The judge compares the answer with the roster. Naming the former member fails it mechanically |
| K2 Goals | A member asks in the private chat for the current goals with owners and dates | The judge compares the answer with the goals. Naming the dropped goal fails it mechanically |
| K3 Who said it | Each member posts a commitment in `standup`. One member changes display name and posts another. One member posts a further commitment from a second account of the same person. Then the agent is asked what each member committed to | Each commitment has words no other commitment uses. Each answer must repeat its member's and none of anyone else's. The second-account leg is required: when no second account is available, K3 does not pass and the report says so |
| K5 No invention | 20 questions in the private chat, 5 about things nobody said | The judge grades each answer against its sheet answer, or checks it says it does not know. Every known answer must carry a link |
| K6 Survives a restart | Asks the K1 and K2 questions, renews the agent's session, asks again, restarts Rome, asks again | The judge checks the answers state the same facts. The renewal and the restart are separate legs. The renewal leg is required: when the session cannot be renewed, K6 does not pass and the report says so |
| K7 Keeps private things private | A member tells the agent something in their private chat, and another says something in `leads`. A member who cannot read `leads` then asks about both in `general` | No agent message in `general` or `standup` repeats either |
| A1 Present | Mentions the agent once at the top of each shared chat named for it, and once in a thread in `general` | Each reply arrives within 120 s of the mention, by message times |
| A5 Right place | Reads where A1's replies landed (phase 1 checks A5 on A1's replies only) | A reply to a mention at the top of a chat is in that chat, at the top or in a thread started from the mention. A reply in a thread is in that thread |

Rules that wait "a day" or "an hour" in the rules doc run on the waits above, and the report states them.

### Direct messages

A Discord bot cannot send another bot a direct message, so in the scripted run a private chat only the agent and one member can read, `dm-<member>`, stands in for a direct message. K1 and K5 ask there, and K7's "said in a direct message" becomes "said in a chat only some members can read", which the rule already covers. The report names the form used. The real direct-message path is checked by hand in the live trial.

## The judge

A model grades answers that must be compared with the answer sheet. `lib/judge-prompt.md` is the fixed prompt, with a version in `JUDGE_PROMPT_VERSION`. A change to the prompt bumps it, because a judge change is a verifier change, and every report names the judge model and the prompt version its verdicts came from. The judge is any command that reads `{ prompt, input }` as JSON on stdin and prints `{ "verdict": "pass" | "fail", "reasons": "..." }`. The default, `lib/claude-judge.mjs`, sends the prompt through the `claude` command to the model in `COS_JUDGE_MODEL` (default `claude-haiku-5-5`). The report keeps each verdict, its reasons and the answer it graded. A judge that prints no verdict leaves that check not checked.

`calibrate-judge.mjs [rounds]` grades 13 answers whose right verdict is known, such as a goal given another goal's owner, and prints the score. Run it after any change to the judge's model or prompt. The default model is the cheapest one that grades reliably: prompt J2 on `claude-haiku-5-5` scored 39 of 39 over 3 rounds, while prompt J1 on the same model passed a goal with a swapped owner every time.

## Tests

```bash
pnpm test:cos-verifier   # part of pnpm test:unit
```

The tests run the verifier against `fake/cos-env.mjs`, which plays the environment with a scripted stand-in agent and no Discord, and against `fake/judge.mjs`, which grades by word matching. The stand-in `good` must pass every phase 1 rule. For each phase 1 rule, a stand-in `fail-<rule>` breaks that rule alone, and the test requires the verifier to fail that rule and pass every other. One test runs with the second account and session renewal made unavailable, and requires K3 and K6 to come back not checked rather than passed.

## Adding a rule

Add a scenario file under `scenarios/` that exports `{ rule, title, phase, run(ctx) }` and returns `ruleResult(checks)`, list it in `scenarios/index.mjs`, add any seeded facts to `seed/`, and teach the stand-in in `fake/stand-in.mjs` to pass it and to break it.

## Contract with the environment

The verifier drives the environment (`environments/chief-of-staff/`) only through `cos-env`, and relies on the following, all agreed with the environment builder:

- **`cos-env seed <dir>`** hands the agent `roster.md`, `goals.md` and `team.json` from `dir`, and links each member's account (`member1` to `member3`) to the person it plays.
- **`cos-env version`** prints `{ "rome": {...}, "agent": {...}, "environment": {...}, "model" }`, each part with a `commit` and a `dirty` flag. It may carry a `verifier` field too; the verifier reads its own and ignores that one.
- **`cos-env read`**: without `--thread`, it returns the chat's messages including those in its threads, each with `thread` set to the thread's id or null. `author` is `agent` for the agent (`--agent-author` sets the value expected). `--since` takes an id from any chat, which holds for Discord ids.
- **`cos-env read --dm <member>`** reads the private chat (`dm-<member>`) that stands in for that member's direct messages with the agent.
- **`cos-env post --thread <message id>`** posts in the thread started from that message. The thread is created with `--chat <name>`; once it exists `--chat` is optional.
- **`cos-env post --as <member>:2`** posts from a second account of the same person. Without a fourth bot token, only that command fails, and K3's two-account leg reports as not checked.
- **`cos-env rome renew-session --chat <name>`** renews the agent's session. When the environment cannot renew it, the command exits with an explanation, and K6's renewal leg reports as not checked.
- **Chats**: `general` and `standup` are readable by all three members, `leads` by `member1` and `member2` only, and `dm-member1` to `dm-member3` are the private chats. All are named for the agent.

Two legs of the phase 1 rules are required: K3's person with two accounts, and K6's renewed session. When the environment cannot run a required leg, the report names which leg and why, and that rule does not count as passed.
