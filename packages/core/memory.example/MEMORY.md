# Memory

This is the agent's general-purpose memory (`memory/MEMORY.md`). It is loaded in
full into the agent's context at the start of every session, so treat it as an
always-on index, not a store. Keep it short: only frequently-used facts live here
inline; everything else lives in a topic file or the journal, with at most a
one-line pointer here.

<!--
## Privacy Config

Topics the agent must NEVER store, in this file or any other memory file. The
agent checks this before writing anything. Uncomment and list what is off-limits,
for example:
- Financial details (account numbers, balances, transactions)
- Medical information (diagnoses, medications, appointments)
- Specific people or relationships to keep out of memory
-->

## How to use this file

Route every fact to where it belongs, then keep this file lean:

- **Frequently-used, durable facts → here, inline.** The handful of things the
  agent needs almost every session: who the guardian is at a glance, standing
  preferences, what's top of mind. If it isn't used often, it doesn't belong
  inline.
- **Everything else → a topic file, with a one-line pointer under Topics.** Write
  the full knowledge in the topic's own file and link to it, so this file stays
  an index:
  - `memory/topics/<topic>.md` — a subject the guardian cares about (e.g.
    `health.md`, `finances.md`, `house-remodel.md`).
  - `memory/relationship/GUARDIAN.md` — the guardian's full profile.
  - `memory/relationship/<person-id>.md` — one profile per known person.
  - `memory/projects/<project-name>/PROJECT.md` — per-project summaries.
  - `memory/IDENTITY.md` — the agent's own name, personality, and purpose.
- **Details and events → the journal.** Specifics, play-by-play, and anything
  tied to a particular day go in `memory/journal/yyyy/mm/dd.md`. Distil only the
  durable takeaway up into a topic file or here.

Maintenance rules:

- **Update, don't duplicate.** A fact lives in one place. If a topic file or an
  inline entry already covers it, edit that — don't add a second copy.
- **Remove what is wrong or stale.** Delete obviously incorrect memory and replace
  facts that have been superseded. Prune over hoard.
- **Promote and demote.** When an inline fact stops being used often, move it into
  its topic file and leave a pointer. When a topic becomes day-to-day, surface its
  key fact inline.
- **Use absolute dates.** Convert "next Tuesday" to a real date (e.g. 2026-06-23)
  so entries don't rot as time passes.
- **Respect the Privacy Config.** Never store a topic listed above. When in doubt,
  ask the guardian before remembering.

## Topics

<!-- One-line pointers to topic files. The link is the home; the hook says when it's relevant. -->
<!-- e.g., - [Health](topics/health.md) — providers, medications, history -->
<!-- e.g., - [Acme fundraise](topics/acme-fundraise.md) — Series A investors, deck, timeline -->

## Key Facts

<!-- A few frequently-used facts about the guardian. Deeper detail goes in a topic file. -->
<!-- e.g., "Lives in San Francisco", "Founder/CEO of Acme Corp" -->

## Preferences

<!-- Standing preferences the agent applies often. -->
<!-- e.g., "Prefers concise replies", "Morning person — no calls before 9am" -->

## Top of Mind

<!-- What the guardian is focused on right now. Keep current; move the rest to a topic file or the journal. -->
<!-- e.g., "Preparing the investor deck this week (due 2026-06-26)" -->
