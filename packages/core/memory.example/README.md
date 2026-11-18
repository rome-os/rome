# Memory System

The memory directory is the agent's persistent, git-tracked knowledge store. It allows the agent to maintain continuity across sessions and remember information about the guardian and their relationships.

## Directory Structure

```
memory/
├── README.md                         # This file
├── MEMORY.md                         # Always-loaded index: frequently-used facts + pointers + privacy config
├── IDENTITY.md                       # Agent identity (name, personality, purpose)
│
├── topics/                           # Per-subject knowledge, linked from MEMORY.md
│   ├── README.md                     # Topic-memory conventions
│   └── <topic>.md                    # One file per topic (e.g. health.md, finances.md)
│
├── journal/                          # Daily journal entries (details + events)
│   └── yyyy/
│       └── mm/
│           └── dd.md                 # One file per day
│
├── projects/                         # Per-project summaries for work under ~/.rome/<profile>/projects
│   ├── README.md                     # Project-memory conventions
│   └── <project-name>/
│       └── PROJECT.md                # High-level project summary + deeper notes
│
└── relationship/                     # People and relationships
    ├── BONDS.md                      # Tier definitions + people lists
    ├── GUARDIAN.md                    # Guardian's profile
    ├── TEMPLATE.md                  # Template for new person profiles
    └── <person-id>.md               # Individual person profiles
```

## How Memory Files Are Used

The agent reads memory files at the start of each session to build context:

1. **MEMORY.md** is loaded first and in full, so it is kept lean: only frequently-used facts inline, plus a one-line pointer to each topic file. Its privacy config determines what the agent is forbidden from storing. Key facts and preferences provide session continuity.
2. **IDENTITY.md** defines the agent's personality and communication style.
3. **GUARDIAN.md** provides the guardian's profile, timezone, and communication preferences.
4. **BONDS.md** tells the agent who people are and how much to remember about them based on their tier.
5. **Topic files** (`topics/<topic>.md`) hold the durable, per-subject knowledge that MEMORY.md only points to. They are loaded on-demand when the agent works on that subject, so they can hold more than MEMORY.md.
6. **Project summaries** (`projects/<project-name>/PROJECT.md`) contribute their first paragraph to the main agent's always-loaded context. The rest of each file is for deeper reference and maintenance.
7. **Person profiles** (`<person-id>.md`) are loaded on-demand when the agent interacts with or discusses a specific person.
8. **Journal entries** hold details and events, loaded on-demand for recent context (e.g., the last few days). Durable takeaways are distilled up into a topic file or MEMORY.md.

### Memory Writing Flow

1. The agent decides something should be remembered (based on skill instructions or conversation context).
2. Checks `MEMORY.md` privacy config — skips if the topic is blocked.
3. Checks `BONDS.md` to determine how much to remember for a person's tier.
4. Writes to the appropriate file: details and events to the journal, per-subject knowledge to a topic file (with a one-line pointer in `MEMORY.md`), a person to their profile. Only frequently-used facts go inline in `MEMORY.md`.
5. Git commits the change with a descriptive message.

## How the Guardian Can Edit Memory

The guardian has full control over all memory files:

- **Web UI**: Browse, edit, and save memory files through the `/memory` page with a markdown editor and live preview.
- **Direct editing**: Memory files are plain markdown — edit them with any text editor, IDE, or from the command line.
- **Git history**: All changes (by the agent or the guardian) are git-committed, so you can always review the history or revert changes.

Common things the guardian might want to edit:
- Add privacy restrictions in `MEMORY.md`
- Correct facts or preferences the agent got wrong
- Add or update project summaries in `projects/`
- Promote or demote people between relationship tiers in `BONDS.md`
- Add or update person profiles in `relationship/`
- Update their own profile in `GUARDIAN.md`

## Auditability

All memory changes are tracked in git:
- Every write by the agent creates a git commit with a descriptive message.
- The guardian can review the git log for any file to see what changed and when.
- Changes can be reverted using standard git operations.
- The web UI provides a history view for each file.

## File Formats

### Voice Terms (`memory/voice-terms.md`)

An optional dictation term list lives in the profile's memory directory. Create it as:

```markdown
---
send: off
---
# Voice terms
## Mine
- term
## Learned
- term
## Never
- term
```

Only `send: on` (also `true` or `yes`, case-insensitive) enables sending terms to the transcription provider with each dictation. Missing, unreadable or malformed files send nothing. The provider bills context as input text tokens. Rome Cloud sees neither the terms nor the audio.

`Mine` holds guardian-written terms. `Learned` holds automatically maintained terms. `Never` excludes terms from both sections, case-insensitively. Use `- ` or `* ` bullets. Mine comes first, with duplicates removed. Do not put secrets or private information in the list.

Rome keeps single-slash terms such as `CI/CD` and `I/O`. It filters path prefixes (`/`, `\`, `./`, `../`, `~/`, `~\`, or a Windows drive) and terms with two or more separators. It also filters email addresses, URLs, items with six or more digits, long token-like strings, and items over 40 characters. It sends at most 150 terms and 3,000 characters, stopping before the next term exceeds either cap. These filters are defense in depth, not a guarantee that a term is safe to share. The file is read once per listening session and does not belong in `MEMORY.md`.

### Topic File (`memory/topics/<topic>.md`)

One file per subject the guardian cares about. Holds the full, durable knowledge of that topic; `MEMORY.md` keeps only a one-line pointer to it. See `topics/README.md` for conventions and the recommended format. The `<topic>` is a URL-safe slug (e.g., `health.md`).

### Journal Entry (`memory/journal/yyyy/mm/dd.md`)

One file per day. Sections for key events, interactions, notes, and reminders.

```markdown
# Journal — YYYY-MM-DD

## Key Events
- Description of notable events from the day.

## Interactions
- **Person Name**: Summary of interaction.

## Notes
- Observations, thoughts, or context worth preserving.

## Reminders
- Things to follow up on or remember for upcoming days.
```

### Person Profile (`memory/relationship/<person-id>.md`)

One file per known person. See `TEMPLATE.md` in the relationship directory for the full format. The `person-id` is a URL-safe slug derived from the person's name (e.g., `john-doe.md`).

### Project Summary (`memory/projects/<project-name>/PROJECT.md`)

Each project under `~/.rome/<profile>/projects/<project-name>` can have a matching memory folder at `memory/projects/<project-name>/`.

- The first paragraph must be a high-level description of the project. This paragraph is always loaded into the main agent's context.
- The rest of the file can capture deeper notes such as repo structure, conventions, current priorities, important commands, and known pitfalls.
- Sync with `~/.rome/<profile>/projects` is best effort. Rome does not scan that directory and does not create these summaries automatically; agents and the guardian maintain them over time.

Recommended format:

```markdown
# Project Name

Short high-level description of what this project is and why it exists.

## Structure
- apps/web
- packages/core

## Current Priorities
- Finish auth migration
- Remove legacy job runner
```
