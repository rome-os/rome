# Data & State

## Memory

The memory system provides persistent, git-tracked knowledge that survives across agent [sessions](sessions.md). It holds general memory (preferences, key facts, privacy boundaries), the agent's identity, a daily journal, relationship profiles for [persons](people.md#person), and summaries of the guardian's [projects](#projects).

**Contracts:**

- The entire memory directory is a git repository: every change (by agents or the [guardian](people.md#guardian)) is tracked with full commit history and can be reverted.
- Key files load into agent context at session start. Person profiles and journal entries load on demand when relevant.
- Privacy boundaries are part of memory itself: topics marked off-limits must not be remembered.

**Not to be confused with:**

- **[Database](#database)** — the database holds operational state (sessions, approvals, policies). Memory holds knowledge.
- **[App data](apps.md#app-data)** — app data is an app's private state. Memory is the guardian's knowledge, agent-readable.
- **[Session](sessions.md)** — a session carries short-term context. Memory survives across sessions.

## Projects

Projects are working directories where the agent does its work — writing code, creating files, running commands. A default project directory serves when no specific project context applies.

**Contracts:**

- A project can have a memory summary. The first paragraph of the summary always loads into agent context as a brief description. The rest is available for deeper reference (repo structure, commands, conventions).
- Folder names such as `build`, `coverage`, `dist`, and `node_modules` do not prevent browsing, editing, uploading, or recognizing a project.
- Folder downloads include build outputs and coverage reports. They skip descendant dependency trees named `node_modules`. An explicitly selected dependency folder can be downloaded separately.
- Browsing, live updates, search, and archive exclusions are independent policies. Search can omit generated content without making it inaccessible in the file browser.
- Dot entries remain excluded from directory listings, folder uploads, search, and archive traversal. Archives omit symbolic links and reject direct symbolic-link downloads. Entry filters are not access controls.

**Not to be confused with:**

- **[App](apps.md#rome-apps)** — an app is an installed extension package. A project is a working directory the agent operates in.

## Routines

A routine is a durable binding from a trigger to an [action](actions.md): when the trigger fires, Rome runs the named action with the routine's stored arguments. Trigger kinds are schedule, webhook, event-bus, poll, and manual ("run now" only). Agents create routines when the guardian asks to automate or schedule something.

*Deprecated alias:* **Events** — surfaces that still say "events" for scheduled automation mean routines.

**Contracts:**

- Every fire is recorded as a routine run linked to its action execution, so a routine's history is inspectable.
- A routine with an active run (executing, or parked awaiting [guardian approval](messaging.md#approvals)) cannot be deleted out from under it. The active-run check and the delete are atomic.
- An app-managed routine can only be deleted by the managing app, never by a user.
- A schedule trigger states its timezone binding explicitly. *Floating* resolves against the guardian's current timezone, so the routine follows them when it changes. *Fixed* pins the stored zone forever.

**Not to be confused with:**

- **[Hook](apps.md#hooks)** — a hook is app-owned code declared in a manifest. A routine is guardian- or agent-authored data managed at runtime.
- **Event-bus event** — an event is a thing that happens. A routine is a standing binding that may use one as its trigger.

## Database

The database holds Rome's operational state — sessions, persons, policies, approvals, and the like. [Apps](apps.md#rome-apps) define their own tables, namespaced by a per-app prefix.

**Contracts:**

- App tables are namespaced by a per-app prefix, so apps cannot collide with each other or with system tables.
- Migrations run automatically on startup.

**Not to be confused with:**

- **[Memory](#memory)** — memory is git-tracked knowledge. The database is operational state.
