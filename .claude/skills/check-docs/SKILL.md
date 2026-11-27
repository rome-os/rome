---
name: check-docs
description: Find where Rome's target docs are missing, break the rules for target docs, or state one fact in two places, and report each place. Use when the user asks whether the docs are up to standard, which docs are missing or what to write next, asks to check a change to `docs/target/` or to the fields of a part's `AGENTS.md`, or schedules such a check. Reads only docs, never compares code with them, and changes no file.
---

# Check the target docs

Goal end-state: the person has every place where the target docs fall short of [docs/authoring/target.md](../../../docs/authoring/target.md), each with its file, its words and the rule it breaks, in the order to fix them.

**The script decides what code can decide.** Run `pnpm lint:docs` and report its lines as they are. Judge nothing it already decides. A `[mech]` rule that a doc breaks and the script let through is a gap in the script, and is reported as one.

**Judge every line of every target doc against the `[llm]` rules.** The target docs are the files under `docs/target/` and the three fields of each listed part's `AGENTS.md`. A finding quotes the words and names the rule by its opening sentence. Words that read badly and break no rule are not a finding. The `[human]` rules are not judged.

**Read other docs for one thing only: a fact that a target doc also states.** Search `docs/` and the part's folder for the terms of each concept and part the target docs cover. Name both places.

**When the rules do not decide a case, report it as unclear.** The person then decides how the rule should read.

**Whether the code keeps what a doc says is another check.** A line that looks false against the code is not a finding here.

## Report

**Open with one line: the number of gaps from the script, the number of findings per rule, and what was not read.**

**Then one line per finding: the file and line, the words, the rule.** A missing piece comes before a weak line, because a weak line may change when the piece is written.

**Propose a new wording only when the person asks.** A person decides every line of a target doc.
