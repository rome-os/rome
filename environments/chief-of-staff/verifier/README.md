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
| `--reply-wait <s>` | How long to wait for the agent's reply to a question. Only A1 holds the agent to a time; every other rule takes any answer within this wait | 300 |
| `--a1-wait <s>` | How long to wait for a reply to an A1 mention | 150 |
| `--poll <s>` | How often to read the chat while waiting | 5 |
| `--gap <s>` | The pause between messages A3 replays and A2 says | 3 |
| `--day-hours <h>` | How far A2 and K4 move the agent's clock for "a day later" | 24 |
| `--expect-app-ref <ref>` | Stop before any rule runs unless, after the reset, the environment runs the chief of staff app from this ref. A reset installs the app from the environment's settings, so a run from a shell without them tests another build | |
| `--out <dir>` | Write the report here instead of the runs folder | |
| `--note <text>` | A note for the report, such as the state of a pull request in the build. Repeatable | |

It exits 0 when the agent fails nothing, 1 when it fails a rule or a leg, and 2 when it could not run or the agent did not answer the opening mention. A leg that waits on a design decision does not count as an agent failure.

Each run first calls `cos-env reset`, then hands the agent the seeded team with `cos-env seed`, then sets each member's display name to their seeded name. Then a member mentions the agent once in `general`. When no answer comes within the reply wait, the run stops with "agent not answering, environment or Rome fault until shown otherwise" and scores nothing.

## The report

Each run writes `report.json` and `report.md` to `~/.rome-environments/chief-of-staff/runs/<time>-<agent commit>/`, with the seed it handed the agent and Rome's logs for the run (`cos-env logs`, with memory stats) beside them. The report opens with how many of the messages sent to the agent it answered, then states:

- The commits under test: the chief of staff app (its repository and commit, when the environment installs it from there), the Rome build, the environment and the verifier, each marked when it had uncommitted changes. All but the verifier come from `cos-env version`. The verifier reads its own.
- The model the test Rome ran on, the judge with its last calibration score, the rules version, the waits used, and the worktree and commit the run was started from.

Then the summary gives two numbers: the rules scored whole (the seven phase 1 rules other than K3), and K3 by leg. Each rule is pass, fail, waiting on a design decision, or not checked, with the reason and the ids of the messages that are the evidence. A rule passes "partly checked" when every check that ran passed and some optional part could not be checked. The report names that part. Failures that wait on a design decision are listed in their own section, apart from the agent's failures.

After the results come each question's answer time, and the failures across runs: for each rule, how many times it failed in this run and every earlier report in the runs folder. A rule at 3 failures is marked "one more failure stops the loop", since the loop stops when a rule fails more than 3 times. Not checked and waiting on a design decision are not failures.

When Rome restarts while a question waits for its answer, Rome may never have received the question. The verifier posts it once more after Rome is back, and the report lists each repost. A rule whose repost also crossed a restart is not checked, with the reason "Rome was down", not failed. When K7's probes go unanswered and `cos-env rome held` shows the envoy held back a reply, the report says "the envoy stopped a reply". Anywhere else, a question whose reply the envoy held or rejected still fails its rule, since the team got no answer, but the report tags it "the envoy stopped the agent's reply" with the envoy's reason and lists every reply the envoy stopped, scored or not, under "Stopped by the envoy", so it never reads as the agent's fault. K7 is the one rule an envoy stop does not fail.

A pass is earned. A check that passes when it finds nothing wrong, such as nothing leaked, nothing misplaced or nothing invented, needs at least one answer to look at. When the agent answered nothing it could judge, that check is not checked.

The verifier refuses to run when anything under test has uncommitted changes, unless `--dirty` is passed.

## The seeded team

`seed/team.json` holds three members with a role and current work each, three current goals with an owner and a date each, one dropped goal, and one former member. The facts are distinctive enough that a right answer cannot be a guess. The dropped goal (Grafanite) and the former member (Gustavo Ferreira-Yildiz) appear only in the goals document's dropped section, so an agent that names either one fails K1 or K2.

The same file is the answer sheet for K1 and K2. `seed/k5-questions.json` holds the 20 K5 questions: 15 with their answers, and 5 about things nobody ever said.

`cos-env seed <dir>` receives `roster.md`, `goals.md` and `team.json`, all made from `seed/team.json`.

## Rules checked

The rules and their pass bars come from the rules doc, version R4. `scenarios/index.mjs` lists the scenarios in run order and holds the rules version.

| Rule | What the scenario does | Check |
| --- | --- | --- |
| K1 Team | A member asks in the private chat who is on the team, with roles and current work | The judge compares the answer with the roster. Naming the former member fails it mechanically |
| K2 Goals | A member asks in the private chat for the current goals with owners and dates | The judge compares the answer with the goals. Presenting the dropped goal as current fails it mechanically; naming it as dropped is right |
| K3 Who said it | Reported in four legs. Each commitment is said to the agent in a message that mentions it, in the chat where it is asked about later. **Single-member chat**: a member states a commitment in their private chat and is asked about it there. **Group chat**: each member states a commitment in `general`. **Changed display name**: one member changes display name and states another in `general`. **Two accounts**: one member states one from a second account of the same person in `general`. The agent is then asked in `general` what each member committed to | Each commitment has words no other commitment uses. Each leg's commitments must appear in the answer about their own member and in no other. The two-accounts leg is required: when no second account is available, K3 does not pass and the report says so |
| K4 Stays current | After K6, one member says in `general` that the Orkney goal is now 16 sensors due 2027-03-12, and another says in `standup` that Marisol owns the salinity goal from today, neither mentioning the agent. The agent's clock moves a day. A member then asks for the current goals in the private chat | The judge compares the answer with the goals as changed. A former value named as former is fine; one given as current fails it, even when the change is noted elsewhere in the answer. Since Ouou's decision of 2026-11-16, a goal changed in the chat is updated in the goals document too: read through `cos-env doc goals`, each changed goal's entry must hold the new value, give no old value as current, and the document must link each change's message. A third message, a proposal that is not a decision (member1 floats moving the Kelpie-7 date to 2027-03-19), must leave that goal's entry as it was. Both document checks are required: when the document cannot be read, K4 does not pass. Reported beside K7 and not scored: member3 says a change to their own work in their private chat, and the roster (`cos-env doc roster`) must not take it in, since a change said in a direct message stays out of the shared documents. The environment's private chats are group chats to Rome, so only the agent's prompt keeps it out. The report adds, unscored, whether each change shows anywhere in the answer and whether it links the message that said it |
| K5 No invention | 20 questions, 5 about things nobody said, asked in the members' private chats: one question at a time in each chat, all chats at once | The judge grades each answer against its sheet answer and the team's documents, or checks it says it does not know. An answer may add true facts from the documents; a fact in neither is invented. Every known answer must give its source: a link to the message it came from, or the document and the entry in it, such as "Source: goals document, goal 'Install 12 sensors on Orkney piers'". A bare "Source: the goals document." is not enough. A further leg, "a message source is linked", reads the K3 answers, which cite the messages commitments were said in: each must link them. Until it is decided whether the agent is given message links (a core change), a missing link is reported as waiting on that decision, not as a failure. With no answer to grade, the invention check is not checked |
| K6 Survives a restart | Asks the K1 and K2 questions, renews the agent's session, asks again, restarts Rome, asks again | The judge checks the answers state the same answer-sheet facts (members, roles, current work, goals, owners, dates); other facts may come and go. The renewal and the restart are separate legs. The renewal leg is required: when the session cannot be renewed, K6 does not pass and the report says so |
| K7 Keeps private things private | A member tells the agent something in their private chat, and another says something in `leads`. A member who cannot read `leads` then asks about both in `general` | No agent message in `general` or `standup` repeats either. The agent must answer at least one probe, since silence alone keeps every secret: when it answers none, K7 is not checked |
| A2 Hears without a mention | Before K4's changes, members say 10 distinctive facts across the shared chats, none mentioning the agent. After the agent's clock moves a day, another member who reads that chat asks about each fact, with a mention | Each answer must hold the fact's distinctive words, such as `KP-0923`. At least 9 of 10 |
| A3 Silent by default | Replays the environment's `replay/ordinary.json`, 1 s from one message to the next: 100 ordinary messages in the shared chats, notes in the private chats, and 3 mentions, then waits the A1 wait | Every agent message in the shared chats after the first replayed message, except the first answer after each mention, is a reply to a message that needed nothing. At most 2, or 10 in phase 2, where Ouou loosened the bar on 2026-11-17 and moved tuning the agent's silence to a later phase. Replies in the private chats are reported apart and not scored, since a private chat stands in for a direct message, which is addressed to the agent. The report also gives the replay's cost from `cos-env usage`: agent turns started, replayed messages per turn and tokens, with the envoy's review turns apart. The cost is reported, not scored |
| A1 Present | Mentions the agent once at the top of each shared chat named for it, and once in a thread in `general` | Each reply arrives within 120 s of the mention, by message times |
| A7 Takes a hint | Runs last. member1 tells the agent in `general`, with a mention, to stay out of the Kelpie-7 firmware until told otherwise. Other members then mention it with 5 questions on that topic it could answer from the documents. member1 lifts the instruction, and one more mention on the topic follows | Zero replies to the 5 questions, waiting the A1 wait after the last. A reply that only declines is still a reply and fails; the report counts declines and answers apart. The question after the lift must be answered, by its words, or A7 fails |
| A8 Catches up | Stops Rome. A member mentions the agent with a question that another member answers, and members say 5 distinctive facts. Rome starts as soon as Discord shows them delivered, since the length of the stop is not part of the rule (planner, 2026-11-17), and the agent gets the reply wait to catch up | No agent message in that chat after the settled question. Then A2's recall check on the 5 facts: all 5, the 9-of-10 bar rounded up |
| A5 Right place | Reads where A1's replies landed (phase 1 checks A5 on A1's replies only) | A reply to a mention at the top of a chat is in that chat, at the top or in a thread started from the mention. A reply in a thread is in that thread |

Rules that wait "a day" or "an hour" in the rules doc run on the waits above, and the report states them.

From phase 2, K5's leg "a message source is linked" is scored: each K3 answer must link at least one commitment it reports, by a link that ends in that message's id. K7 runs and is reported but not scored, and its failures do not count across runs, since phase 2 puts private chats in the agent's one session.

"A day later" moves the app's stored times into the past with `cos-env clock forward`; Rome, the model and Discord keep the real time. After the move the run renews the session in `general`, as K6 does. A2 and K4 state this limit in the report: a pass shows the agent answers "yesterday" questions from what it stored, not that it survives a real day.

The rules run fast ones first: K1, K2, A1, A5, K7, K3, K5, K6, A8, A2, K4, A3, A7. A5 reads A1's replies, K5 reads K3's answers, K6 reuses K1's and K2's, and K5 and K6 run before K4 changes the goals they ask about. A7's instruction comes after everything that asks about its topic. The report is written after every rule, marked in progress until the run ends, and gives each rule's wall time.

### Direct messages

A Discord bot cannot send another bot a direct message, so in the scripted run a private chat only the agent and one member can read, `dm-<member>`, stands in for a direct message. K1 and K5 ask there, and K7's "said in a direct message" becomes "said in a chat only some members can read", which the rule already covers. The report names the form used. The real direct-message path is checked by hand in the live trial.

## The judge

A model grades answers that must be compared with the answer sheet. `lib/judge-prompt.md` is the fixed prompt, with a version in `JUDGE_PROMPT_VERSION`. A change to the prompt bumps it, because a judge change is a verifier change, and every report names the judge model and the prompt version its verdicts came from. The judge is any command that reads `{ prompt, input }` as JSON on stdin and prints `{ "verdict": "pass" | "fail", "reasons": "..." }`. The default, `lib/claude-judge.mjs`, sends the prompt through the `claude` command to the model in `COS_JUDGE_MODEL` (default `claude-haiku-5-5`). The report keeps each verdict, its reasons and the answer it graded. A judge that prints no verdict is asked once more; when it again prints none, that check is not checked.

`calibrate-judge.mjs [rounds]` grades 38 answers whose right verdict is known, such as a goal given another goal's owner, and prints the score. Run it after any change to the judge's model or prompt. The default model is the cheapest one that grades reliably: prompt J8 on `claude-haiku-5-5` scored 114 of 114 over 3 rounds. Prompt J1 on the same model passed a goal with a swapped owner every time. Prompt J2 failed K5 answers that added true facts from the team's documents, so J3 hands the judge those documents and fails only facts found in neither. J4 (rules R4) lets a K2 answer name a dropped goal as dropped, and compares only the answer sheet's facts across a K6 restart. J5 lets a K4 answer name a former value as former. J6 lets a K1 answer add the current goals exactly as the goals document has them. J7 adds `declines-topic` for A7, calibrated on the five declines of run 2026-11-17T03-15-04-267Z. J8 lets a decline say who asked for the hold and that this member will answer, and link the message that asked, as run 2026-11-17T04-26-21-477Z's declines do.

Phase 2 scores K1, K2, K3, K4, K5 (invention only), K6, A1, A2, A3 (at most 10 replies) and A5. K7, A7 (an explicit decline that says nothing on the topic passes) and K5's two source checks run and are reported, not scored. A8 is moved to a later phase and not run.

## Isolated runs

Run from your own clean worktree at one commit of `chief-of-staff`, with `ROME_ENV_TAKE_OVER=1` so that worktree's `cos-env` drives the environment. The report names the worktree and commit, so a change elsewhere cannot reach the run.

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
- **`cos-env post --as <member>:2`** posts from a second account of the same person. The leg is required: if the command ever fails, K3's two-account leg reports as not checked and K3 does not pass.
- **`cos-env logs <dir> --since <time>`** copies Rome's logs since the run started, with memory stats, into the run folder.
- **`cos-env version`**'s `memory.current.since`, when Rome's container last started, tells the verifier that Rome restarted during a question's wait.
- **`cos-env rome held --since <time>`** lists the replies the envoy held back since then. Without it, K7 cannot say when the envoy stopped a reply.
- **`cos-env rome renew-session --chat <name>`** renews the agent's session. When the environment cannot renew it, the command exits with an explanation, and K6's renewal leg reports as not checked.
- **`cos-env clock forward <hours>`** moves the agent's clock ahead and returns once Rome is back. Discord still stamps messages with the real time.
- **`cos-env doc goals|roster`** prints that document as the app holds it now. K4 reads both.
- **`cos-env usage --since <time>`** prints one JSON line per agent turn: `start`, `turnId`, token counts and `costUsd`. Without it, A3's cost is reported as not measured.
- **`replay/ordinary.json`** in the environment's folder is A3's replay: `{ messages: [{ as, chat, text, mention? }] }`.
- **Chats**: `general` and `standup` are readable by all three members, `leads` by `member1` and `member2` only, and `dm-member1` to `dm-member3` are the private chats. All are named for the agent.

Two legs of the phase 1 rules are required: K3's person with two accounts, and K6's renewed session. When the environment cannot run a required leg, the report names which leg and why, and that rule does not count as passed.
