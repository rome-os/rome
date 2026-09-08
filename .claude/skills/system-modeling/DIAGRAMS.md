# Sequence diagrams and the state machine

Mermaid inside `<topic>-scenarios.md`, rendered to HTML with `render/render.sh` so the user reviews pictures. Diagrams are drawn to find problems, so each scenario ends with the problems it exposed.

## The scenarios file

Header: revision, date, and a line saying which pass this file is ahead of or behind. Then the participants, one short paragraph per noun saying what it does in the diagrams and what it never does. Then the state machine section, then the scenarios.

## Sequence diagrams

- Participants are the nouns, plus persons as `actor` with plain names (ann, bob). Two persons, so the diagrams show that who hands a task is not who closes it.
- One activation bar is one execution. Its trigger is a note over the bar: `wake(Person(ann, message))`, `wake(Schedule)`.
- Every arrow into the store is one write. A note over the store after it shows the store's state: `t1: Taken`.
- A model turn is a note, never an arrow: `model turn: t2 stuck + these words -> reply tool, bound to ann`.
- A passive store never sends. When a component reacts to a new fact, draw it as a note on that component, `wake(Event: new fact seen)`, followed by its own read.
- When a person has two routes, such as talking to the agent or acting on the store directly, draw both.

## Scenario checklist

Every model gets the happy path and then these. Each one broke a revision of the model this skill came from.

1. A person's words become a unit of work, on both routes.
2. The worker finishes and someone judges the result.
3. A different person than the one who asked closes it.
4. Failure, retry under a cap, a question over the cap, a reply that resets the cap.
5. The process dies between two writes. Show that each write is consistent alone and that the next pass duplicates nothing.
6. A trigger arrives during a pass.
7. The host restarts and a worker is gone. Show who writes the fact the worker cannot.
8. The store is unreachable.
9. A person does the worker's job by hand.
10. A person cancels while work is running.

## The state machine

Two diagrams, not one.

- **States.** About ownership and termination only, so four or fewer: who wants it, who owns it, how it ended. Every transition is labelled with the verb and the actor class. Terminal states are entered by a person only, if the model says so.
- **Positions.** Inside the owned state, where the thing sits between passes, named by what the owner is waiting for: working, stuck, reported. Derived from the latest fact, never stored. Drawn as a separate flat diagram with one edge per fact that moves it.
- Keep everything that resolves within one pass out of the position diagram. A "not yet started" or "returned but unjudged" is the owner's work in progress, not a position.
- Draw orthogonal regions only when the two regions are truly independent. Two coupled machines drawn side by side hide the coupling; replace them with the reachable combinations.
- When a table restates the edges of a diagram row by row, cut the table and keep the four sentences it added as prose.

## Problems each diagram should be read for

- An actor calling something they cannot call. A person who only speaks has no arrow to the store.
- A read that bypasses the store. One component asking another for its status is a second input, and the model's "the store is the only input" rule is broken.
- A state with no way back. Ask who can take it.
- A fact whose writer can be dead when it is needed. Someone else must write it, and the diagram must show who.
- A noun with one incoming arrow and no state of its own.

## Mermaid rules that cost time

- `#` and `;` inside a message or note label truncate it. Write "PR 88", not "PR #88", and use a comma instead of a semicolon.
- A self-loop on a node in a `stateDiagram-v2` collides with the neighbouring labels. Put the retry in prose and draw only the edges that change position.
- `direction LR` on a small state diagram crowds the labels. Let it lay out top-down.
- Long labels overlap. Shorten the label and move the detail into the table or the note.
- Rendering one diagram at a time in the header script, with a try/catch around each, keeps one broken diagram from blanking the rest and prints the parse error in place.

## Rendering

`render/render.sh OUT_DIR file.md [file.md ...]` converts each markdown file to `OUT_DIR/<name>.html` with pandoc, adds the stylesheet and the Mermaid loader, and post-processes the headings. It uses `pandoc` from PATH or `nix run nixpkgs#pandoc`. Serve `OUT_DIR` however the environment says to and give the user a link they can open. Check the result in a headless browser with a virtual time budget, since Mermaid loads from a CDN after page load; a screenshot taken too early shows raw source.

The style is a monochrome infographic: off-white paper, near-black ink, one grey, Lato light headings with the last word in a black box, hatched title rule, rule-only tables, monochrome diagrams with black actor boxes.
