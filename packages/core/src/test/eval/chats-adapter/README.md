# Chats and adapter eval

Measures how well the boundary between Chats and each platform's adapter
holds, against the qualities and quantities in the report "Chats and adapters:
patterns and interface gaps". This branch is not meant for main; keep it
rebased and run it from time to time.

```sh
packages/core/src/test/eval/chats-adapter/run.sh
```

A run writes `out/scorecard.md` and adds one line to `out/history.jsonl`, so
runs can be compared. A check never fails the test run: the eval measures.

## What it checks

`boundary.eval.test.ts` starts each platform's production adapter against its
peer from `test/kit/im/`, with a stand-in for Chats behind `deliver`, and
checks only what crosses `ChatAdapter`:

| Quality | Checks |
|---|---|
| Q1 Nothing is lost quietly | an empty inbound message is handed over or reported through `fault`; an empty send is refused with `SendRefused`; a send the platform refuses fails |
| Q2 Handed over exactly once | a message the connection delivers twice reaches `deliver` once; so does one delivered again after the adapter restarts |
| Q3 Ordered | five messages reach `deliver` in the platform's order |
| Q4 Same conversation, same chat | a reply lands where the person sees it; a direct message Rome opens is the one chat the person answers in (through Chats) |
| Q5 One truth | a direct message, a group message and a thread's message are stated as such |
| Q6 Declared equals actual | a quote is made, or refused with `SendRefused`, never dropped |

`scorecard.ts` measures Q7, Q8 and the rest of Q6 from the source: platform
name literals outside the connection kinds, files outside `connections/` that
import the connection's port types, send entry points, inbound paths, error
vocabularies, which capabilities a connection kind can declare, and how many
chat-capable connection kinds the eval runs.

## Where faults are injected

Redelivery and empty messages are injected at the connection's inbound port,
just below `ChatAdapter`. Once each connection kind has its own adapter, the
injection point moves into that adapter's own port to the platform, and
`seam()` in `boundary.eval.test.ts` is the one place to change.

## Not covered yet

- Telegram user accounts (#1693), Slack, WhatsApp, LinkedIn, the personal
  WeChat account and the dashboard have no peer, so the eval does not run
  them.
- Two of Rome's accounts hearing one message: by the #1670 decision, a kind
  that numbers per account may hand over one copy per account, so there is no
  cross-account check.
- What Chats owes back (answering `deliver` only once a message is safe)
  needs a crash between record and acknowledge, which no peer can inject yet.
