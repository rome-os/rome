# Data & State

## Memory

The memory system provides persistent, git-tracked knowledge that survives across agent [sessions](sessions.md). It holds general memory (preferences, key facts, privacy boundaries), the agent's identity, a daily journal, relationship profiles for [persons](people.md#person), and summaries of the guardian's [projects](#projects).

**Contracts:**

- The entire memory directory is a git repository: every change (by agents or the [guardian](people.md#guardian)) is tracked with full commit history and can be reverted.
- Key files load into agent context at session start. Person profiles and journal entries load on demand when relevant.
- The agent name setting owns the `Agent Name` line in `IDENTITY.md`. When the guardian asks for a rename, the agent updates the setting and identity note together. The dashboard refreshes without a reload.
- Privacy boundaries are part of memory itself: topics marked off-limits must not be remembered.

**Not to be confused with:**

- **[Database](#database)** — the database holds operational state (sessions, approvals, policies). Memory holds knowledge.
- **[App data](apps.md#app-data)** — app data is an app's private state. Memory is the guardian's knowledge, agent-readable.
- **[Session](sessions.md)** — a session carries short-term context. Memory survives across sessions.

## Projects

Projects are working directories where the agent does its work — writing code, creating files, running commands. A default project directory serves when no specific project context applies.

**Contracts:**

- Every project can have a one-line memory summary describing what it is. The main agent receives all project summaries, not just the selected project's summary.
- The first paragraph supplies the summary, capped at 160 Unicode code points including a trailing ellipsis when truncated. Separate this short introduction from detailed notes with a blank line. Consecutive list items without blank lines count as one paragraph.
- Detailed notes remain available on demand and stay out of the automatic project context.
- A blocking `summon` starts its agent in the project of the session that called it. The summon can name another project instead, but only a directory inside the projects root. The host rejects any other path before the agent starts. Agents that other actions run start in the default project unless the action names a directory.
- A resumed agent session reopens in the directory it last ran in, because the model provider keeps its transcript per directory. A caller that names another directory moves the session there. When the recorded directory is missing, resuming that session by id fails, and a thread that reuses its session implicitly starts a fresh session in the default project.
- A session learns the default project and the projects root when Rome starts. In code, they are `AgentFolders` in [`packages/core/src/agent/domain/agent-folders.ts`](../../packages/core/src/agent/domain/agent-folders.ts), with the rule for a project's path under the root.
- The Projects browser and shared-project views skip dependency folders named `node_modules` and dot entries in listings, live updates, uploads, and folder downloads. Build outputs such as `build`, `coverage`, and `dist` remain browsable, editable, and downloadable, and a top-level folder with one of those names is a project. Search still omits build outputs. These filters are not access controls.

**Not to be confused with:**

- **[App](apps.md#rome-apps)** — an app is an installed extension package. A project is a working directory the agent operates in.

## Chat files

A file shown in a dashboard chat is a copy in the profile's `assets` folder under a new random name, so it never overwrites or replaces another file. Two things put files there: a file the guardian attaches, and the `core:show_file` action, which an agent calls with a local path to show a picture, video or file.

**Contracts:**

- The copy is read-only and never changes. The dashboard serves it at `/api/assets/<id>.<ext>` behind the same session check as the rest of `/api`, and the browser may cache it for a year. If the agent later overwrites the original file and shows it again, the earlier message keeps the earlier bytes.
- An attached file's message links to that URL. The agent's copy of the turn also names the file's local path, so it can read the file.
- `core:show_file` takes an absolute path to a regular file of at most 100 MB under the projects, memory or assets folder, with links resolved first. It refuses keys, credentials, `.env` files, databases and the insides of `.git`, `.ssh` and similar folders. It returns the URL and the Markdown that shows the file.
- Only images, audio, video, and PDFs open in the browser. Every other type downloads.
- In chat, pictures show as thumbnails that zoom, video and audio play in place (a file the browser cannot play becomes a chip), and other files appear as a chip that saves the file under its own name. The server sends no file name, so the name the chat asks for is the one used.

## Routines

A routine is a durable binding from a trigger to an [action](actions.md): when the trigger fires, Rome runs the named action with the routine's stored arguments. Trigger kinds are schedule, event-bus, and manual ("run now" only). Agents create routines when the guardian asks to automate or schedule something.

*Deprecated alias:* **Events** — surfaces that still say "events" for scheduled automation mean routines.

**Contracts:**

- Every fire is recorded as a routine run linked to its action execution, so a routine's history is inspectable.
- A routine may opt out of keeping its trigger payload in that history. Its runs and its action's execution record then hold only the payload's size, while the action still receives the whole payload. Routines keep the payload unless they opt out.
- Creating a routine fails when its stored arguments do not satisfy the bound action's input schema, so no routine is saved with arguments that fail on every fire.
- A routine with an active run (executing, or parked awaiting [guardian approval](messaging.md#approvals)) cannot be deleted out from under it. The active-run check and the delete are atomic.
- A run still executing when Rome stops is recorded as an error at the next start, so it does not block a delete. A run awaiting approval stays active.
- An app-managed routine can only be deleted by the managing app, never by a user.
- A schedule trigger states its timezone binding explicitly. *Floating* resolves against the guardian's current timezone, so the routine follows them when it changes. *Fixed* pins the stored zone forever.
- A schedule that repeats every N days fires N calendar days apart, across month and year ends. The count starts on the routine's creation day, read in the zone the schedule fires in. A floating schedule reads that day in the guardian's current zone, so the first gap after the guardian changes zone can be shorter or longer than N days.

**Not to be confused with:**

- **[Hook](apps.md#hooks)** — a hook is app-owned code declared in a manifest. A routine is guardian- or agent-authored data managed at runtime.
- **Event-bus event** — an event is a thing that happens. A routine is a standing binding that may use one as its trigger.
- **[Event](sessions.md#event)** — one item of a turn's stream. The deprecated alias "events" above means routines, never turn events.

## Personal data

Personal data is data about the guardian that only they should see, which their devices push to Rome and Rome stores, such as Apple Health. It lives in the personal-data store and is read only in private turns ([audience](../domains/participation.md#audience)). Agents read it through `core:personal_data_catalog` and `core:personal_data_query`. The contracts for the ingest, the routes and the query are in [personal-data.md](../personal-data.md).

- **Source**: where personal data comes from, such as `apple_health`. Each source declares its types in core.
- **Origin**: the device that sent a source's data, such as the guardian's iPhone. A query reads one origin per source.
- **Type**: one kind of reading inside a source, such as `stepCount`, with one unit and one shape: bucket, sample or record.
- **Sync**: one run on the device that reads changes and sends them.
- **Ingest**: one batch as the server received it.
- **Personal-data action**: an action that reads the store. It runs only in a private turn, and is refused in a shared one.

**Contracts:**

- A source joins the store only when each item is a reading with a time range and a numeric value, and a query over a window aggregates them. Document data, such as calendar events, is not personal data.
- An ingest is idempotent per batch and per item, so a device may resend a batch after a lost answer.
- Rome keeps personal data until the guardian deletes it. Deleting an origin removes its readings and keeps the ingest log, which holds counts and never a value.
- Facts an agent already wrote into memory or a chat are not personal data anymore, and nothing checks where they go next.

**Not to be confused with:**

- **[Memory](#memory)** — memory is authored and loads into context. Personal data is measured, and an agent reads it on demand.
- **[App data](apps.md#app-data)** — app data belongs to an app. No app owns personal data.

## Database

The database holds Rome's operational state — sessions, persons, policies, approvals, and the like. [Apps](apps.md#rome-apps) define their own tables, namespaced by a per-app prefix.

**Contracts:**

- App tables are namespaced by a per-app prefix, so apps cannot collide with each other or with system tables.
- Migrations run automatically on startup.

**Not to be confused with:**

- **[Memory](#memory)** — memory is git-tracked knowledge. The database is operational state.
