# The vocabulary file

One markdown file the user reviews. Sections in this order. Every section is short; the tables carry the content.

## Header

Title, date, revision number, and one line with the counts: "Five nouns, thirteen verbs, five rules." Then two paragraphs: what the general thing is and its one invariant, and which instance the user has in mind and how it maps.

## Nouns

| Noun | Description | Verbs |
|---|---|---|
| **Ledger** | Everything the agent remembers outside any session. The only thing it may rely on. | write |
| **Task** | Work a person handed the agent, recorded in the ledger. A person decides when it is done. | create, take, ask, report, reply, complete, cancel |

The description states the property that must hold. It names what the noun is not when a nearby term in the host project could be mistaken for it ("Not Rome's Memory").

## Verbs

| Verb | On | By | Description |
|---|---|---|---|
| take | Task | runtime | Record that the runtime is on the task. Stops the next pass and other people from handing it again. |
| complete | Task | a person | Close the task as done. Written only from a person's own words or action, and cites them. |

"By" names the actor class, never a component name the instance happens to use. When a verb has two routes, such as speaking to the agent or acting on the store directly, say so in the description.

## Rules

Numbered invariants, each with a bold name and one or two sentences. A rule is something a test could check.

1. **The ledger is the only input.** A pass's writes depend only on the ledger and the trigger.
2. **One pass at a time.** A trigger that arrives during a pass causes the next pass.

## Instance as values of the model

| General | Instance |
|---|---|
| Ledger | One GitHub repository: issues, labels, comments, pull requests |
| complete | Merge the pull request, or say so in chat and the agent records it citing the message |

## Not in the model

Two lists. Words that are implementation or instance-local and were deliberately left out, with a phrase each on why. And an Avoid list: words that collide with the host project or that the user rejected.

## Open decisions

Numbered, each with the choice, what each side costs, and a recommendation. Anything the pseudocode or diagrams needed that the tables do not name lands here.

## Changes in revision N

One entry per revision, newest first, listing what changed and why. Keep every revision's entry, so the file records how the model was reached.

## Tests to run on a draft

- Every noun appears in a rule. A noun in no rule is a verb or is out.
- Every verb's "By" is an actor class. A component name in "By" means the instance has leaked in.
- No description mentions a session, a process, a file, or a table unless the noun is one.
- Names for states are participles. Names for messages are nouns. Names for actors are plain words.
- The counts in the header match the tables.

## The review brief

Hand the file to a subagent with this scope: "Judge whether this model is feasible to implement, whether its rules are sound and sufficient for the invariant, and whether any noun, verb, or rule can be removed or merged without losing a rule. Report each finding with the sentence in the file it concerns. Do not compare the model to existing code." Fold the findings into Open decisions and the next revision.
