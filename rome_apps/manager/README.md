# Manager

A long-running agent: it keeps working on your tasks across sessions, and its
correctness never depends on a session continuing.

Tell it what you want in chat. It records the task in an append-only ledger,
puts a coding session on it, retries what fails, asks you when it is stuck, and
reports when there is something to look at. Only you close a task.

This is a prototype of the "long-running agent, revision 3" model. Almost all of
it is plain TypeScript; a model runs at exactly two points.

## The two model call sites

**The language boundary.** You chat with the `manager` agent
(`src/agents/manager.yaml`). Its only ledger-writing tools are `manager:create`,
`manager:reply`, `manager:complete`, and `manager:cancel`, plus the read-only
`manager:snapshot`. The agent picks which task your words are about and how to
word the fact; the app stamps who said it and cites the message. When the words
map to none of those, the agent answers in chat and writes nothing. Its system
prompt carries no scheduling logic — no caps, no retries, no age.

**The judge.** `src/lib/judge.ts` answers one question: is the task done, given
what the worker returned. The default answer needs no model — done when the
reply is not empty and no line opens with `BLOCKED:`. The worker's brief states
that contract, so a worker that hits a wall says so in a form a plain function
can read. Swapping in a model-graded judge is a change to that one file.

Everything else — when to take a task, when to start a worker, how many at once,
when to retry, when to ask, when to stop — is `src/lib/reconcile.ts`, a pure
function from a ledger snapshot to a list of writes.

## The ledger

One table, `manager__facts`, append-only. Nothing updates or deletes a fact.
A task's state and position are folded from its facts every time they are
needed, so a pass can die between any two writes without corrupting anything.

Facts are named by one rule: a participle is something that happened, a noun is
something somebody said.

| Kind | Written by | Payload |
| --- | --- | --- |
| `Created` | a person | `brief` |
| `Taken` | the runtime | — |
| `Completed` | a person | `reason?` |
| `Cancelled` | a person | `reason?` |
| `Started` | the runtime | `workerId`, `prompt` |
| `Returned` | the worker | `workerId`, `reply` |
| `Failed` | the worker | `workerId`, `error` |
| `Lost` | the runtime | `workerId`, `why` |
| `Question` | the runtime | `why` |
| `Report` | the runtime | `what`, `evidence` |
| `Reply` | a person | `text` |

Every fact a person writes carries `by` (who) and `source` (their words or the
action, verbatim).

**States** are about ownership: Created, Taken, Completed, Cancelled. Only a
person ends a task, from Created or Taken. **Positions** live inside Taken and
are never stored: `working` (the runtime's last word is a Started),
`stuck` (a Question), `reported` (a Report). The runtime never leaves Taken on
its own.

## Setting it up

```jsonc
// manager:setup — the only required field is the directory workers work in.
{
  "workingDir": "/absolute/path/to/your/project",
  "workerAgent": "coding:coding",  // default
  "startCap": 2,                   // starts per task since the last person fact
  "maxWorkers": 3,                 // workers running at once, across tasks
  "ageCapHours": 3,                // silence before a worker is declared lost
  "intervalMinutes": 5             // how often reconcile runs
}
```

`setup` stores the config and registers one routine, `Manager: reconcile`,
deduplicated on its routine key. Rome's scheduler accepts `FREQ=MINUTELY` down
to one minute, so five minutes is a choice rather than a floor; the app snaps an
arbitrary interval to a cadence the RRULE-to-cron conversion reproduces exactly.

Then talk to the `manager` agent, or call `manager:create` directly:

```jsonc
{ "brief": "add rate limiting to the upload endpoint", "source": "<the person's message>" }
```

`manager:reconcile` also runs at the end of every person-fact action and at the
end of every worker, so a new fact is acted on immediately rather than at the
next tick.

## Known gaps

These are limits of what Rome exposes to an app today, not choices.

- **No detached agent run.** `system:summon` runs an agent to completion and
  returns its reply; it has no detached mode. The app gets detachment one level
  up: the runtime dispatches `manager:run_worker` with `{ detached: true }`, and
  that action holds the blocking summon. The worker is a Rome execution the
  runtime does not wait for, which is what the model needs — but Rome sees an
  action, not a session it can report on.
- **No way to stop a worker.** Nothing in `@rome-os/app-runtime` cancels a
  detached execution or an agent session. `ActionEngine.cancel(rootExecutionId)`
  exists in core and takes exactly the id `runAction` hands back, but no
  `system:*` action and no `RomeAppContext` method reaches it. So a stop is
  recorded as `Lost(why="stopped by runtime")` and the runtime stops reading
  that worker; the worker itself runs to the end. A late reply from a stopped
  worker is dropped, because the Lost already closed it. Closing this gap needs
  a `system:cancel_execution` action or a `cancel(executionId)` on
  `RomeAppContext`.
- **No working directory on summon.** `RunParams.workingDir` exists on the agent
  runner, but `system:summon` does not pass it through, and an app must go
  through summon to run another app's agent. So the configured `workingDir` is
  stated in the worker's brief instead of being enforced by the platform.
- **No boot-time restart detection.** An app cannot ask whether an execution it
  launched is still alive, so the runtime cannot write `Lost(why="host restart")`
  on boot. The age cap covers the same case: a worker silent past `ageCapHours`
  gets `Lost(why="silent past cap")` and is retried. The cost is latency, up to
  the cap, on a restart.
- **No person id in an action.** `getCurrentActionContext()` gives the calling
  session, agent, and channel thread, but core deliberately drops the resolved
  `SessionActor` before the context reaches app code. So a fact from a chat is
  stamped `by="guardian"` unless the channel names its sender, and the agent is
  required to pass the person's message verbatim as `source`. A guardian id
  would need `SessionActor` threaded through the projection in
  `packages/core/src/actions/context.ts`.
- **No web UI.** `manager:snapshot` is the only view.

## Layout

```
src/
├── agents/manager.yaml        the language boundary, one of two model call sites
├── lib/
│   ├── facts.ts               the ledger's vocabulary
│   ├── fold.ts                facts -> states and positions
│   ├── reconcile.ts           snapshot -> the list of writes and launches
│   ├── judge.ts               the other model call site
│   ├── prompt.ts              the worker's brief
│   ├── config.ts              settings and the routine's trigger
│   ├── identity.ts            who a person's fact is stamped with
│   └── person-fact.ts         stamp, append, reconcile
├── db/
│   ├── schema.ts              facts, config, locks
│   └── repositories/          the only way into those tables
└── actions/
    ├── setup                  config + the reconcile routine
    ├── reconcile              the runtime loop; applies reconcile's list
    ├── run-worker             one worker, dispatched detached
    ├── create reply complete cancel   the person's four verbs
    └── snapshot               read-only
```

The pure logic is unit-tested next to it — `fold.test.ts`, `reconcile.test.ts`,
`judge.test.ts`, `config.test.ts`. None of them touches a database: `reconcile`
takes a snapshot value and returns actions, and the action layer applies them.
Run them with `pnpm --filter @rome/core test:unit`.
