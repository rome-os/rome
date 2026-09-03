---
name: secondary-text-audit
description: Audit the subordinate copy in a UI — section descriptions, field helper text, hints, card subtitles, empty-state body copy, tooltip bodies — against the secondary-text ruleset, and emit a per-string keep/rewrite/delete verdict table a coding agent can apply. Use this skill whenever the user asks to review, tighten, trim, or clean up UI copy, microcopy, descriptions, helper text, subtitles, hints, or empty states; asks "is this copy necessary?", "does this description earn its place?", "why is our UI so wordy?"; wants a settings page or dialog decluttered; or is writing new secondary text and wants it checked before it ships — even if they don't say "audit". For view-level UX behavior (labels, missing states, redundancy, one-primary-action), use ux-semantics-audit; for palette and tokens, use color-audit. This skill owns everything about whether a piece of subordinate copy should exist at all and how it should read.
---

# Secondary-Text Audit

Extract every piece of subordinate copy in a surface and put each one on trial.
The ruleset's premise is that **secondary text defaults to absent**: it exists
only to carry information the user needs before acting that the label, the
control's shape, and the surrounding context do not already give them. Most
shipped secondary text describes what something *is*, which the label already
did. That text goes.

The output is a verdict table, not prose commentary. Every row resolves to
`keep`, `rewrite`, or `delete`, and every `rewrite` carries its replacement
string.

## Design philosophy (read this — it shapes every judgment call)

1. **Delete is the expected majority outcome.** This is the inversion that makes
   the skill useful. An audit that keeps most of what it finds has not applied
   the ruleset; it has admired the copy. If your table is mostly `keep`, re-run
   the fact test on every `keep` row and mean it.
2. **Uncertainty resolves to `delete`, with one exception.** When a string sits
   between `delete` and `rewrite`, choose `delete` — the primary label almost
   always suffices. This is the opposite of the precision-over-recall bias in
   `ux-semantics-audit`, and deliberately so: a wrong `keep` is permanent noise
   on the screen.

   The exception is a string carrying a cost, a scope, or a cause. Deleting one
   of those does not cost a line of copy, it costs the reader the fact that made
   the screen actionable. When the string tells the user what an action breaks,
   where a setting stops applying, or why a surface is in a state they did not
   choose, uncertainty resolves to `rewrite`. Trim it to the fact and keep it.
3. **Judge the rendered pair, never the key name.** A verdict needs the label
   the user actually sees next to the text. A key called `*.description` may
   render as a card subtitle, a tooltip body, a dialog description, or nothing
   at all.
4. **Fact before verdict.** Name which kind of fact the text carries before
   deciding anything. A string carrying none is `delete` — that is the rule,
   not a shortcut.
5. **A rewrite must be a real string.** "Tighten this" is not a replacement.
   Write the sentence that ships, in the register
   [`docs/ui/VOICE.md`](../../../docs/ui/VOICE.md) fixes. If you cannot write
   one that passes the rules, the verdict was `delete`.

6. **A shorter string is not automatically a better one.** Trimming is the means,
   not the goal. A replacement that reads as a system log has failed even when
   every word left is load-bearing — check it against `VOICE.md` before it ships.

## Workflow

### Step 1 — Scope the audit

The unit of analysis is the **surface**: a page, tab, dialog, drawer, or
self-contained section. Secondary text is judged against what renders beside it,
so the scope must be something the user sees at once.

- Whole package → audit surface by surface; do not emit one 120-row table.
- A named page ("the settings page", "the app detail page") → that page and the
  dialogs it opens.
- New copy the user just wrote → that string plus its label and siblings.

### Step 2 — Extract the candidates

```bash
node .claude/skills/secondary-text-audit/scripts/extract-secondary-text.mjs --scope settings
```

The script collects both carriers Rome uses — i18n locale keys under
`packages/web/src/i18n/locales/<locale>/` and literal strings in `*Description`
components and `description=` / `subtitle=` / `hint=` / `helperText=` props —
pairs each with its label, resolves it back to the component that renders it,
and prescreens it. `--scope <substr>` filters by key or location; `--json` emits
the rows for programmatic use; `--root` points at another package.

Its flags are **advisory triage**, not verdicts:

- `forbidden:*` and `generic-verb` are near-certain `delete`, but confirm the
  match is real before writing it down.
- `no-signal` fires on most rows. It means "re-examine", nothing more — real
  cost text often has no number.
- `sr-only` rows are out of scope entirely. Never delete them.
- `UNRENDERED` means no call site was found. Confirm with a grep for the bare
  key before calling copy dead, then verdict it `delete`.
- `dynamic-key` and `key-ref` are the weakest resolutions and can over-match: a
  computed key like `connections.headings.${role}` matches every sibling under
  that prefix, including ones the union type never produces. Open the cited line
  and check the key can really reach this row before trusting it — a row that
  only resolves this way is a `delete` candidate hiding behind a wildcard.
- `label-inferred` means the label shown is a guess from the key path. Read the
  component before judging that row.

### Step 3 — Read the ruleset and the voice

Read [`docs/ui/VOICE.md`](../../../docs/ui/VOICE.md) first — it fixes the
register, the person, and what a description must carry, and every `rewrite`
row is written in it. Then read
[`docs/ui/secondary-text.md`](../../../docs/ui/secondary-text.md) in full. It
carries the scope, the five kinds of fact, the four-question test, and the
repo rules. Do not
audit from memory of the kind names.

### Step 4 — Establish the rendered context

For each surface, read the component and write down, before judging anything:

- **the label** rendered above/beside each string, verbatim;
- **the siblings** rendered on the same screen (this decides every
  difference verdict);
- **whether the string is conditional** — empty-state only, error-only,
  first-run only (this decides first-step text and pulls error copy out
  of scope);
- **what the control's shape already says** — a toggle, a file input, and a
  destructive-variant button each carry information the copy need not repeat.

This step is what separates a verdict from a guess. Skipping it produces
plausible-sounding tables that are wrong about half the rows.

### Step 5 — Run the test per sentence

Ask the four questions of every sentence, in order, stopping at the first
failure. Derive the string's verdict from its sentences. Then, for `rewrite`
rows, check that the replacement passes the four questions on its own and
obeys `VOICE.md`.

### Step 6 — Verdict-hardening pass

Before emitting, re-examine the table:

- Every `keep` — name its kind of fact out loud. If naming it takes a paragraph of
  justification, it is `rewrite` or `delete`.
- Every `rewrite` — read the replacement alone, without the original. Does it
  pass the four questions as a new string? Does it lead with the fact?
- Every `delete` — confirm the information is not lost: either it was
  restatement, or the surviving payload moved into another row's replacement.
  Say which.
- Every row — is the label quoted the one that actually renders?

### Step 7 — Emit the report

Use exactly this structure:

```markdown
# Secondary-Text Audit: <surface>

## Summary
<2-4 sentences: how many strings, the keep/rewrite/delete split, and the single
pattern driving most deletions on this surface.>

## Verdicts

| Location | Label | Secondary text | Fact | Verdict | Replacement |
|---|---|---|---|---|---|

## Notes
<Only rows needing a reason a reader would otherwise dispute: a `keep` that
looks like description, a `delete` whose payload moved elsewhere, a `rewrite`
that changes placement. One line each, referencing the location.>

## Out of scope
<Strings the extractor surfaced that the ruleset excludes — sr-only
descriptions, error messages, placeholders, dev-gallery copy — with the
exclusion that applies. Keeps the next reader from re-litigating them.>
```

Column rules:

- **Location** — `file:line` of the render site, plus the i18n key when there is
  one. The applying agent needs both: the key to edit, the line to check.
- **Fact** — one of the five kinds, or `none`.
- **Verdict** — `keep`, `rewrite`, or `delete`.
- **Replacement** — required for `rewrite`, empty for `delete` and `keep`.

Order rows by render order on the surface, not by verdict. The applying agent
walks the file top to bottom, and a reader checking your work walks the screen.

### Step 8 — Applying the verdicts

When the user asks for the changes and not just the table:

- A `delete` on an i18n key removes it from **every** locale under
  `packages/web/src/i18n/locales/` — `en` and `zh-CN` today. A key deleted from
  `en` alone leaves the other locale still rendering the string.
- A `rewrite` updates `en` and marks the other locales for retranslation; do not
  hand-translate unless the user asks.
- Deleting the last child of a key object removes the empty parent too.
- Removing a rendered string usually leaves a dead wrapper element — delete the
  `<p>` or the `description={...}` prop, not just the key.
- Verify with `pnpm typecheck`, then look at the surface in the running
  dashboard. Copy changes are exactly the class of change a type check cannot
  catch: a deleted key that is still rendered fails at runtime as a raw key
  string, not at build time.

## Division of labor

| Question | Skill |
|---|---|
| Should this description exist, and how should it read? | **secondary-text-audit** |
| Does this view have the right labels, states, and emphasis? | **ux-semantics-audit** |
| Is the palette itself sound? | **color-audit** |

The seam with `ux-semantics-audit` is its `consistent-terminology` and
`label-outcome-clarity` rules: those judge the **label**, this skill judges what
hangs beneath it. When a description only exists because the label is wrong, say
so in Notes and name the `ux-semantics-audit` follow-up rather than writing a
replacement that props up a bad label.

## What this skill does NOT do

- Judge labels, button text, or headings — that is the primary layer.
- Own tone or brand voice — [`docs/ui/VOICE.md`](../../../docs/ui/VOICE.md) does.
  This skill decides whether a string exists and what it must carry; every
  replacement it writes must obey that file.
- Rewrite error messages or validation text — different rules, out of scope.
- Translate. It flags locales that need retranslation; it does not write them.
- Apply its own verdicts unless asked. The table is the deliverable.
