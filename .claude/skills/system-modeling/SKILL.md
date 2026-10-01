---
name: system-modeling
description: Design a system's model as a few nouns, their verbs, and rules, then sharpen it with pseudocode, sequence diagrams, and a state machine until every scenario holds. Use when the user wants to design or rethink an architecture, wants a shared vocabulary and mental model before building, or asks for nouns and verbs, pseudocode of a model, sequence diagrams, or a state machine.
---

# System modeling

Three passes, each producing one file the user reviews, each feeding the problems it finds back into the pass before. The vocabulary is the model. The pseudocode and the diagrams exist to find what the vocabulary got wrong.

Work one revision at a time with the user in the loop. Every file carries a revision number and a change log, so a reader can tell which pass is ahead of which.

## 1. Frame the general problem

- Name the general thing the request is an instance of. An "engineer bot" is one instance of "an agent whose lifetime spans sessions and who keeps working with people across them". Model the general thing. The instance becomes a mapping table at the end of the vocabulary.
- Write the one invariant everything else serves, in one sentence. For the agent above: correctness never depends on a session continuing.
- Done when the user agrees with both sentences.

## 2. Nouns, verbs, rules

Produce `<topic>-vocabulary.md` in the format in [VOCABULARY.md](VOCABULARY.md).

- Propose few nouns, five or fewer. Each noun has a description and its verbs. Each verb has what it acts on, who does it, and a description. Rules are numbered invariants.
- Define every term by the property that must hold, never by how the current code achieves it. Test: if a different implementation would falsify the sentence, the sentence is implementation and comes out.
- Noun test: a noun carries state that outlives a verb and appears in at least one rule. Anything else is a verb. A reified verb with one verb of its own ("end" on "Wake") is a call, and a call is a verb.
- State or message test: a fact that changes who owns a thing is a state. A fact that records something somebody said is a message. Name states as participles (Created, Taken) and messages as nouns (Question, Reply), so a reader can tell them apart by the word alone.
- Check every name against the host project's existing terms and against words the user has rejected. Colliding words go on the Avoid list.
- Have a subagent review the model for feasibility, soundness, and minimality. Word the brief as a review of the model itself; conformance to an existing prototype is a different question and is not this review.
- Done when every noun has a verb and a rule, the user has chosen every name, and every unresolved point is listed under Open decisions.

## 3. Pseudocode

Produce `<topic>.py` in the conventions in [PSEUDOCODE.md](PSEUDOCODE.md).

- Nouns are classes, verbs are methods, rules are asserts. Enums are sum types whose variants carry their data. Every method and every variant has a comment. Strip syntax that a reader does not need.
- Split what is deterministic from what needs a model. The deterministic part is one pure function from a snapshot of the store to a list of actions, so it can be tested without a database and can stop after any single action. The model appears at named call sites only, and each is listed.
- A person interacts only in natural language. Model the language boundary as tool use whose author fields the runtime binds, so the model picks the words and never the author.
- Walk the scenarios in code, showing the store after every write.
- Whatever the code needed that the tables did not name goes under Open decisions in the vocabulary.
- Done when every verb in the tables is a method, every rule is an assert or has a comment saying where it holds, and every scenario in the checklist in DIAGRAMS.md has been walked.

## 4. Diagrams

Produce `<topic>-scenarios.md` following [DIAGRAMS.md](DIAGRAMS.md), and render it with `render/render.sh` so the user reads pictures, not Mermaid source.

- One sequence diagram per scenario. Participants are the nouns plus named persons. One activation bar is one execution. Every arrow into the store is one write, and a note under it shows the store afterwards.
- A state machine for the central noun. States are about ownership and are few. Positions inside a state are derived from the latest fact and are drawn as a second, separate diagram.
- After each diagram, write down the problems it exposed. Fix them in the vocabulary first, then let the change flow down.
- Done when the user has seen every diagram rendered and every problem found is either fixed upstream or listed as an open decision.

## 5. Propagate and hand off

- A decision lands in the vocabulary first, then the pseudocode, then the scenarios, in that order, with a change-log entry in each.
- When the model is signed off, hand the glossary to the `domain-modeling` skill for `CONTEXT.md`, and the deterministic function and the scenarios to whoever builds the prototype: the scenarios are its test cases.

## Questions that find problems

Ask these of the model at every pass. Each one found a real defect in the sessions this skill came from.

- Why is X a noun?
- Is X a state or a message?
- Who writes this fact, and can they be dead when it needs writing?
- What happens if the process dies between these two writes?
- Can these two parties be fully decoupled through the store?
- Which parts need a model at all, and where exactly is it called?
- Is there a way back from this state? Who can take it?
- Does this table say anything the diagram does not? If not, cut the table.
