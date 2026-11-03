---
name: ddd
description: Interview a person as the domain expert to build a shared DDD language and model, map where the code diverges, hand off prioritized implementation, then check the merged code against the model.
---

# Shared language and model, from interview to code

## What this skill is for

A person knows what their domain is; the code only knows what it does today. This skill runs the whole Domain-Driven Design loop between them, so that the person, the AI and the code end up using one language:

1. **Interview** the person as the domain expert until the words and their rules are settled.
2. **Write the language** they can read and correct without knowing code.
3. **Shape the model**: context map with direction, aggregates, and a walk of a real story through it.
4. **Map divergence**: where today's code contradicts the model, ranked with the person.
5. **Hand off** implementation in priority order, with the language as the brief.
6. **Check drift** once the code has merged, and bring every gap back as a decision.

It is long-running. One pass can take dozens of rounds over a day or more, and the artifacts are living documents edited in place, not reports written once.

## Code and model

The code is an authority on facts: what the system does today, how outside platforms behave, and what a change would cost. Read those yourself instead of asking, and report what the code does, not what its names imply. The code is not an authority on the model: whether a concept is right or where a boundary belongs is the person's call. ADRs and docs are the same as code here. Five rules follow from this:

1. **Two records.** "Today" comes from the code and lives in the notes; the language holds what the person decides. The divergence map is where they meet.
2. **Today is never the default.** Show today's behaviour as one labelled option among others. Recommending it needs a reason other than "it exists".
3. **Compare against the language, not the code.** A new concept is tested against agreed words. A concept that exists only in code is a candidate to test, not a baseline.
4. **Cost decides when, not what.** How hard a change is sets its priority in the divergence map; it never bends the model.
5. **Strain in the code becomes a question.** Where the code's words pull apart, ask the person; don't copy the design.

## Ground rules

**Talk to a domain expert, not a programmer.** No table names, columns, file paths or type names in questions or in the language document. If a question needs code to be understood, it is the wrong question. Short beats complete: one line per word, a short story, a few questions per round.

**Use only the language's words.** Every noun and verb you use in a question must already be in the language, or be the one you are asking about. When you catch yourself saying a word the language doesn't have ("bot", "disconnect the agent"), stop, consolidate it into a language word, and add that word to the language.

**One meaning per word inside a context.** A context states the question it answers ("who said what, where, and as whom"). A word that is a term in two contexts is written with its context in front, everywhere ("People link", "Envoy link").

**Stay in scope.** The person decides what the current focus is. Words and rules outside it get one line, "keeps today's behaviour, not part of <focus>", and no further questions. Don't fill gaps the person has put out of scope.

## The five facts every word needs

DDD prescribes no glossary format, but a word is only usable for design when it states:

- **Meaning**, in the person's words.
- **Identity**: what makes two of them the same one.
- **Lifecycle**: when one starts to exist and when it stops.
- **Operations**: the verbs people use on it (not create/read/update/delete).
- **Rules**: what must always hold.

Plus, across contexts, the **context map**: which context depends on which, and which side bends.

Identity and lifecycle carry the most weight; one answer about them can move an aggregate boundary. Most words come out of early rounds with meaning and rules but no identity or lifecycle. Checking every word against these five, as a table, is the review step below.

A word earns its place only if it has an identity, lifecycle or rule that no other word already carries. Test existing words against this too, not just new ones: a word whose every job is done by others (who it is → account, how messages move → connection, where they live → chat) is plumbing, not domain, and leaves the language. The code may keep it as a technical word.

## Stage 1: Interview

### Prepare

Read the code, docs and any earlier modeling notes for the area. Write the as-is model in the practitioner's notes (below): each term as the code has it, where it lives, and a short list of **strain points**, places where the words pull apart (one word naming two things, a thing with three names, an identity that surprises). The strain points seed the first questions.

### Rounds

Keep rounds small, and offer concrete options with a recommendation rather than open blanks.

- Start with the words the person uses most, and the open "what is X, in your words?" question for anything central. Then test their answer with a concrete case that would break it ("one chat or two, if a group has two of the product's accounts in it?").
- Ground abstract questions in real instances. When the person says "I don't understand the question", you jumped ahead: back up, show a plain table of the actual cases (every connection that exists today, whose it is, what it allows) and ask about those.
- Settle lifecycle by **experiment**, not definition: write a numbered story ("1. you connect account A. 2. … 6. you remove it") and ask what exists at each step.
- When an answer could be read two ways, say which reading you took. When you and the person read a step differently, name both readings and ask again; don't build on the ambiguity.
- When the person reverses an earlier decision, accept it, update every artifact, and ask what rule the reinstated state now needs.
- Record each answer at once, in the person's words, and say in one line what you recorded and what it changes. Flag where a decision diverges from shipped behaviour without arguing it then.

### Review the language against DDD

When the person thinks the language is done, check it: a table of every word against meaning / identity / lifecycle / operations / rules, the context map's direction, and rules that were agreed earlier but lost from the file. Rank the gaps. Separate a **missing column** (a word lacks its identity) from a **missing word** (the story needs a concept the language has no term for, such as "who answers in a group"); a missing word usually ranks first. Take the gaps as the next rounds. Close each gap or mark it out of scope.

## Stage 2: The language document

The person's document. Rewrite it whenever a round settles something; it is never "final" until the person says so. No code anywhere in it.

Shape, in order:

1. **One paragraph** saying what this is and that it is written for the domain expert.
2. **Contexts.** A small table: context, the question it answers. Then the context map as a picture with a one-sentence caption of the arrows.
3. **One section per context.** Each word in bold with one sentence of meaning, and its identity, lifecycle, operations and rules as bullets **under the word they belong to**. Never a flat "agreed so far" list; each decision is a rule under some word. Verbs (connect, link, switch) live under the word they act on.
4. **The story.** A short scenario using only the language's words, in which every step says **where it happens** (on the platform, or in the product). It is how the person hears whether the language sounds right.
5. **Open.** Only while something is genuinely open; remove the section when nothing is.

How each decision was reached does not belong here. It goes in the notes.

## Stage 3: The model

Once the person accepts the language, the next DDD steps are:

1. **Context map with direction**: for each dependency, which side conforms ("Chats refers to agents by name and never changes them").
2. **Tactical model**: which words are aggregate roots, entities inside an aggregate, or values. Derive the kind from identity and lifecycle: no identity that survives change → value; created and removed only through something else → entity in that thing's aggregate; otherwise a root. Put each rule on the aggregate that enforces it.
3. **Walk the story through the model**: every step must be expressible with the building blocks. A step that isn't sends you back to the interview.

Publish this as a page the person can comment on (context map and aggregates drawn, each block with its five facts, the story walked through, a first divergence table at the bottom). Revise it in place as comments come in.

Screens are outside DDD but should use only language words; a screen that needs a word the language lacks points to a gap in the model.

## Stage 4: Divergence map

Where today's system contradicts the model, as a table, scoped to the current focus. Columns:

| # | Model | Today | What changes | Depth | Where today |

- **Model** and **Today** in plain words, so the person can rank rows.
- **Depth**: *words* (names and labels), *rule* (a check or lookup changes, stored records don't), *data* (stored records change shape and need migrating).
- **Where today**: file and symbol pointers for engineers; the only code in any person-facing file.

Prioritize with the person, and write the reason on any deferred row. End with:

- **What is not a divergence**: deliberate keeps (out of scope, reused as is, a name collision the person accepted).
- **Order**: the agreed sequence, and who set it, when.

**Refactor, not a translation layer.** An anti-corruption layer is for a context you cannot change (a vendor, another team). For code the team owns, the layer would be a second vocabulary to keep in step. What DDD still gives the refactor is sequencing: add the new behaviour beside the old, switch callers, remove the old, and delete any middle-step adapter at the end.

## Stage 5: Hand-off

Implementation goes to other sessions or threads, one per priority tier or per row small enough for one PR. Each brief is the language document plus the divergence map plus the rows it owns, and says that the language document is the source of truth for words.

Stay available for model questions while they work. When an implementer finds the language and the divergence map disagree, the language wins: fix the map, tell every session that follows either file, and if a real choice remains (a noun, a verb), put it to the person.

## Stage 6: Drift check

After the work merges, check the code against the language once, read-only. Report in four parts:

1. **Words**: language words now in the product and code, words that should have gone and where they remain (split the product's own voice from the platform's own words and from stored keys kept for compatibility).
2. **Rules**: each rule implemented, partly, or not, with file pointers.
3. **New things the model does not name**: states, refusals, defaults and plural nouns the code introduced (a "retired" record, a "listening" state, an automatic default). Each one is a question for the person: add the word to the language, or change the code.
4. **Verdict** in two or three sentences.

Bring the forks to the person as decisions with a recommendation, update the language and the divergence map with the answers, and send follow-up rows to the implementation sessions.

## Artifacts

Keep them together in one folder for the domain. A typical set:

- **language.md**: the person's document (Stage 2).
- **map.svg**: the context map picture.
- **model.md**: practitioner's notes. Ground rules at the top; the as-is model and strain points; numbered decisions (D1, D2, …) with the person's words and date; an interview log by round; each fact tagged **code** (read at a named place), **said** (the person said it) or **guess** (waiting for the person). The person doesn't need to read this.
- **review.md**: the DDD gap review.
- **The model page**: published and commentable (Stage 3).
- **divergence.md**: Stage 4.
- **drift.md**: Stage 6.

When a decision changes, update every file that states it in the same turn, and say which.

## Common mistakes

- Writing the first language draft as a practitioner's document: too long, code words, decision history mixed in.
- Citing an ADR or the code as a reason the domain should be one way, or letting the cost of a change shape the model.
- Using your own shorthand ("owner", "slot") in a question before it is a language word.
- A rule written too broadly ("every account has an agent") when it holds only in one context; ask which accounts, which uses.
- Keeping a word because the code has it. Test it against the five facts.
- Asking about out-of-scope areas after the person has set the focus.
- Letting the divergence map and the language drift apart; the language is the source.