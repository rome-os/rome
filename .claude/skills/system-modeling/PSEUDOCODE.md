# The pseudocode file

Python-shaped text that is not meant to run. It exists so that every verb has a signature, every rule has a place it holds, and every scenario can be walked line by line.

## Conventions

- Nouns are classes. Verbs are methods on the noun they act on. Rules are `assert` lines with the rule number in the comment.
- Enums are sum types. Each variant carries its data, and each variant has a comment that says when it is written and by whom.
- Every method has a one-line comment. A method whose comment repeats its name is either misnamed or does not need to exist.
- Strip syntax a reader does not need: no `self`, no type imports, no `pass`, no `__init__`. Field types are written as `name: Type`, maps as `{Key: Value}`, optional as `Type?`, lists as `[Type]`.
- Facts and states share one enum when every state is also the fact that put it there.
- Persons are actors, not classes. They appear only as the `by` of a fact.

## Shape

```
enum Trigger:
    Schedule(due_at)
    Event(source)
    Person(who, message)      # only in this pass do the person-bound tools exist

enum Fact:                     # everything written to the ledger, in one family
    Created(by, brief, source) # a person wants it. State.
    Taken                      # the runtime owns it. State.
    Started(worker, prompt)    # runtime launched a worker
    Returned(worker, reply)    # the worker is done, or someone wrote it on its behalf
    Failed(worker, error)
    Lost(worker, why)          # written by someone other than the worker: it cannot
    Question(why)              # runtime to a person. Message.
    Report(what, evidence)     # runtime to a person. Message.
    Reply(by, text, source)    # a person to the runtime. Message.
    Completed(by, source)      # terminal. Only a person writes it.
    Cancelled(by, source)      # terminal. Only a person writes it.

class Ledger:
    facts: [Fact]
    reachable() -> bool
    append(task_id, fact)      # the only write; every verb is one of these
    snapshot() -> Snapshot     # the fold: tasks, states, positions, live workers

class Task:
    id
    latest: Fact               # reconcile keys on this
    facts: [Fact]
    state                      # created | taken | completed | cancelled, derived
    position?                  # working | stuck | reported, derived inside taken
```

## The deterministic part

One pure function. It takes a snapshot value and returns the list of things to do, so it is testable with no store and the caller may stop after any item.

```
def reconcile(snapshot, config, judge) -> [Action]:
    for task in snapshot.tasks:
        match task.latest:
            Created:                 Take(task), Start(task)
            Taken:                   Start(task)
            Started:                 nothing                     # working
            Returned(_, reply):      Report(task) if judge(task, reply) else Start(task, reason)
            Failed | Lost:           Start(task) if under_cap(task) else Ask(task)
            Question | Report:       nothing                     # stuck, reported
            Reply:                   Stop(task.worker), Start(task)
            Completed | Cancelled:   Stop(task.worker) if task.worker
```

Name each place a model is called, and keep the list short. In the example there are two: `judge`, and the model turn on a `Person` trigger that maps words to `create`, `reply`, `complete`, or `cancel` through tools whose `by` and `source` the runtime has already bound.

## Scenario walkthroughs

After the classes, one block per scenario. Each line is a call or a write, and after every write a comment shows the store:

```
# --- 4. Failure, cap, question, reply ---
ann says "migrate the sessions table"
    # t2: Created(by=ann)
reconcile -> [Take(t2), Start(t2)]
    # t2: Taken; Started(w2)
w2 -> Failed(w2, "0042 conflicts with 0041")
reconcile -> [Start(t2)]            # one start since ann spoke, under the cap
    # t2: Started(w2')
w2' -> Failed(w2', same)
reconcile -> [Ask(t2)]              # two starts, over the cap
    # t2: Question(why)
ann says "0041 was reverted, retry"
    # t2: Reply(by=ann)             # a person spoke: the cap resets
reconcile -> [Start(t2)]
```

Walk every scenario in the checklist in DIAGRAMS.md. A scenario the code cannot walk is a hole in the vocabulary. Record it under Open decisions before patching the code.

## What to hand back to the vocabulary

- Any method the classes needed that no verb names (a `snapshot()` read, a private `steer()` step). List it under Open decisions as "verb or rule?".
- Any counter the code wanted to keep in memory. Either it becomes derivable from the store, such as a count of `Started` since the last person fact, or it becomes a fact.
- Any place a component read another component directly instead of through the store. That is a coupling the model should either name or remove.
