# Rome Apps

Apps are the extension system. An app bundles related [agents](agents.md), [actions](actions.md), [skills](skills.md), [hooks](#hooks), web UIs, APIs, and database migrations into a single package. A manifest declares the app's identity (id, version, description) and the artifacts it contains.

**Contracts:**

- Only manifest-declared artifacts are loaded. An artifact not listed in the manifest does not exist as far as the runtime is concerned.
- Disabling an app removes its artifacts (agents, actions, skills, hooks) from the running registries. Enabling it puts them back.
- First-party apps (shipped with Rome) are required and immutable to users: they cannot be uninstalled or replaced, and enable/disable is the only user control — except the system app, which cannot be disabled either ([boot convergence](../architecture/app-lifecycle.md#boot-convergence)).

**Not to be confused with:**

- **[Action](actions.md) / [Skill](skills.md)** — these are artifacts an app owns, not apps themselves.
- **[Listing](#app-store)** — the store identity of a published app. The app is the installed package.

## App ids

An app id is the runtime identity declared by `app.yaml#id`. A local app may use an unscoped lowercase slug of at most 64 characters — letters, digits, and hyphens, starting with a letter. An app published under a scoped App Store listing uses the complete `@<handle>/<slug>` listing id as its app id. The lifecycle, the [lockfile](#lockfile), the dashboard, and artifact namespaces all key on this exact value.

Apps published on the [app store](#app-store) are also identified by a **listing id**, which takes one of two forms. Both are acceptable wherever a store listing is referenced (installing from the store, publishing, store URLs):

- **Unscoped** `<name>` — follows the handle grammar: 2–32 characters of lowercase letters, digits, and hyphens, starting and ending with a letter or digit.
- **Scoped** `@<handle>/<slug>` — the handle follows the same grammar. The slug is 2–64 characters of lowercase letters, digits, hyphens, and underscores, starting and ending with a letter or digit.

**Contracts:**

- An App Store listing's canonical listing id is also its installed app id. The bundle manifest must declare that exact id. `@foo/bar` never collapses to `bar`.
- The install appId is derived from the source, never caller-supplied.
- A scoped app id is encoded when it crosses a filesystem or URL path-segment boundary. The logical id in the manifest, lockfile, APIs, and registries remains unchanged.
- The app ids `core` and `self` are reserved. Packaged apps cannot declare them. `self` is not a reference shorthand. Keeping it reserved prevents historical `self:<local-name>` values from becoming valid canonical ids.
- The two store namespaces are independent: owning the unscoped name `foo` grants no rights over `@foo/*`, and vice versa. A scoped id whose slug equals its handle (`@foo/foo`) is forbidden, so every listing has exactly one canonical id.
- The handle `rome` is reserved for first-party apps shipped with the platform — the reservation covers both the scoped `@rome/*` namespace and the unscoped name `rome`.

**Not to be confused with:**

- **Listing id** — identifies a store listing. For a store install it is also the app id, cross-checked against the bundle manifest. Local-only apps can use an unscoped app id without a listing.
- **[Handle](#handle)** — the publisher namespace inside a scoped listing id, not an identifier of any single app.

## Artifact names and references

Every agent, action, and skill has a local name inside its owning app. The app
id and local name form its canonical artifact id:

```text
<app-id>:<local-name>
```

For example, the `app_creation` skill in the `coding` app has the canonical id
`coding:app_creation`.

A scoped app keeps its complete namespace. The `baz` agent in `@foo/bar` has
the canonical id `@foo/bar:baz`.

New format version 2 local names match `^[a-z][a-z0-9_-]{0,63}$`. Every format
version rejects `:` in a local name. The separator belongs to reference syntax,
so `coding:app_creation` is a reference, not a valid definition name. Format
version 1 remains readable for legacy bundles. New apps write format version 2
and use qualified references.

**Contracts:**

- Agent, action, and skill definitions declare only their local name. A definition such as `name: example:foo` is invalid.
- The Agent local name `main` is reserved for Rome Core. Apps must choose another Agent name. This restriction does not apply to Action or Skill local names.
- Every format version 2 reference uses `<app-id>:<local-name>`, including references to another artifact in the same app.
- Runtime registries, authorization checks, and new durable references use canonical artifact ids.
- A bare name is a legacy input. The compatibility resolver maps it to one stable canonical artifact id. New app definitions and references do not create bare-name behavior.
- The complete manifest app id owns the namespace. For a scoped Store app, that includes its `@handle/slug` scope.

**Not to be confused with:**

- **Local name** — the unqualified name declared by one artifact, such as `app_creation`.
- **Canonical artifact id** — the runtime identity, such as `coding:app_creation`.

## App-author SDKs

Apps consume three supported packages published under the `@rome-os/` scope: `@rome-os/app-runtime` (server-side), `@rome-os/app-web-sdk` (web bundles), and `@rome-os/ui` (the shared component kit, web only).

**Contracts:**

- These three packages are the entire supported app-author surface. Rome also publishes internal packages for its own cross-repository use. Apps must not depend on them.

**Not to be confused with:**

- **Internal `@rome-os` packages** — published for Rome's own cross-repository use, not part of the supported app-author surface.

## Caller identity

The caller is the request identity an app observes: the [guardian](people.md#guardian), a [visitor](people.md#visitor), or anonymous. The host resolves it before an app handler runs and hands the same shape to server code and web code.

**Contracts:**

- The host derives the caller from primary session material and strips identity headers arriving from outside before a handler runs — an external caller cannot forge an identity ([access control](../architecture/access-control.md)).
- The platform gates access at the edge regardless of what the app does with the caller. In-app checks refine the platform gate, never replace it.
- The web-side caller is advisory, for UI gating only. Enforcement lives server-side.
- The SDKs ship the standard visitor gate, so apps do not re-implement it. An anonymous caller receives the wire-stable `visitor_auth_required` error, and app frontends key on that code to start visitor sign-in.
- A caller holding both a guardian and a visitor session resolves as the guardian.
- A visitor session may carry a favor credential. It stays host-side — app code can cause the runtime to spend it, never read it.

**Not to be confused with:**

- **[Actor](actions.md#actor)** — the actor is stamped on every action execution in the chain. The caller is what one app observes for the request it handles.

## Lockfile

Durable state for every applied app lives in a single per-profile lockfile. Each entry records the app's source, enabled flag, terminal state, installed hash and version, and last error. See [`architecture/app-lifecycle.md`](../architecture/app-lifecycle.md) for the components that maintain it.

**Contracts:**

- The lockfile is the single source of truth for durable app state — there is no per-app deployment record and no reconcile loop.
- An entry's state is terminal — installed, failed, or broken. Installing and uninstalling exist only as runtime overlays surfaced through the catalog while an operation is in flight. They are never written to disk.
- A broken state means the on-disk bundle drifted from what the lockfile expects (failed probe at boot, or a corrupted entry that the salvager recovered).
- There is exactly one lockfile writer, and lockfile writes are atomic ([ownership](../architecture/app-lifecycle.md#ownership)).

**Not to be confused with:**

- **The app catalog** — the in-memory resolved view the runtime reads. The lockfile is the durable record it is rebuilt from.

## Install sources

The source names where an app's bytes come from. Three kinds exist:

- **Source** — a local app repository. The daemon builds it, packs it, and installs the packed artifact. This is the dev flow.
- **Bundle** — an already-packed artifact, installed as-is. First-party apps shipped with Rome install this way.
- **App store** — a published bundle on [Rome Cloud](rome-cloud.md), named by listing id, version, and content hash. The installer downloads the bundle, verifies the hash, and extracts it.

**Contracts:**

- The source determines provenance and *how* the bytes arrive. It does not affect runtime semantics: once the installer activates a bundle, all kinds converge on the same activation point, and provenance is invisible at runtime.
- The runtime reads an app's files only through its single live-bundle activation point. Activation is swapped atomically, and identical sources are content-addressed so they cache-hit on re-install (crash ordering in [`architecture/app-lifecycle.md`](../architecture/app-lifecycle.md#crash-model)).

**Not to be confused with:**

- **[Lockfile states](#lockfile)** — the source says where the bytes come from. The lockfile state says what happened when they were applied.

## Lifecycle operations

The lifecycle operations apply apps to a profile: install, uninstall, and enable/disable. Each is a blocking call that runs to a terminal state recorded in the [lockfile](#lockfile). Component ownership and crash ordering live in [`architecture/app-lifecycle.md`](../architecture/app-lifecycle.md).

**Contracts:**

- Install is a completion barrier: when the call returns success, the new bundle is live and the runtime has finished reloading it. The caller never polls.
- An invalid local source is rejected before any state is written. The declared install mode must agree with the observed directory shape, and a bundle missing a manifest-declared output is rejected up front. A healthy installed app cannot be flipped to failed by a bad install attempt.
- A failed install preserves the previous state: the live bundle and the recorded hash and version stay unchanged. Only the failure fields move.
- Uninstall always drops the lockfile entry, even when disk cleanup fails part-way. A later install of the same id recovers the disk state.
- Dependency installation applies no minimum release age, so a bundle can consume an SDK published in the same release window.

**Not to be confused with:**

- **[Install sources](#install-sources)** — the source says where the bytes come from. The lifecycle operations apply them.
- **[Lockfile](#lockfile)** — the lockfile records the terminal outcome. The operations produce it.

## App store

The app store is a Rome Cloud-hosted directory of publicly available apps. Two objects are kept deliberately separate:

- **Listing** — the store identity of an app: its [listing id](#app-ids) (`<slug>` or `@<handle>/<slug>`), owned by a handle, survives across versions. Listings have lifecycle states published and taken-down.
- **Version** — one immutable bundle: a frozen content hash, a SemVer string, a publication timestamp. Versions have lifecycle states live, superseded, and revoked.

Listings give an app its durable name. Versions give a specific bundle its address. Splitting them lets a listing be taken down without losing version history and lets versions be revoked without affecting the listing.

**Contracts:**

- Published versions are immutable, SemVer is monotonic per listing, and superseded/revoked versions are retained indefinitely.
- Updates are opt-in: the consumer never polls the store in the background.
- A published bundle is self-contained but not pre-installed: it declares its dependencies without workspace references, and dependency installation runs after extraction.
- A version with `app.yaml#includeSource: true` carries its root `src/` directory in the same bundle. That manifest field is the version's source-availability signal.

## Remix

A remix is a new project directory populated with code from an App Store app, whether installed or not.

**Contracts:**

- The Apps page derives remixability from the installed `app.yaml#includeSource` field. The Store entry checks `sourceAvailable`. Core still requires `includeSource` in the downloaded bundle.
- A remix always receives a new app id and a new authoring directory. It never updates or overwrites the installed source app.
- A scoped remix name maps to a path-safe local app id. For example, `@ray/calendar` maps to `ray-calendar`.
- Core copies installed code locally. For a Store pin not installed locally, it downloads, verifies, and extracts the bundle without installing the source. Both paths copy the complete code root without assuming a `src/` layout. Creation does not install the new app either.
- The derived `app.yaml#remix` block records the source listing and version. The lockfile and Rome Cloud do not store a second lineage record.
- Declared action, agent, and skill names are qualified with the derived app id before installation.
  Structured references follow the same mapping.
  The authoring pass updates semantic references in free-form code.
- A database-backed remix receives a table prefix derived from its new app id and generates a fresh initial migration. Copied source migrations cannot be installed while they still address the source app's tables.

**Not to be confused with:**

- **[Rome Cloud](rome-cloud.md)** — the service hosting the store. The store is one of its surfaces.

## Handle

A handle is the publisher namespace in a scoped [listing id](#app-ids) (`@<handle>/<slug>`). An unscoped name occupies a handle namespace of its own.

**Contracts:**

- Handles are first-class objects on the app store: each handle has its own ownership and an authorized-publisher set, separate from any single user account.
- The `rome` handle is reserved for first-party apps shipped with the platform — in both namespaces, as described in [app ids](#app-ids).

**Not to be confused with:**

- **[Listing id](#app-ids)** — a handle names a publisher namespace. A listing id names one published app within it.

## App data

Each app gets a persistent data directory for files outside the database, plus database tables namespaced by a per-app prefix.

**Contracts:**

- Both the data directory and the app's tables survive an install→uninstall→re-install round-trip. Only an explicit purge at uninstall wipes them.
- A database-backed scoped app must declare `db.tablePrefix`. The scoped app id itself is not a SQL identifier.

**Not to be confused with:**

- **[Memory](data.md#memory)** — memory is the guardian's knowledge, git-tracked and agent-readable. App data is an app's private state.

## Hooks

Hooks are event handlers that trigger behavior in response to system events. An app declares its hooks in its manifest.

The primary hook type is **channel-message**, the entry point for all incoming messages. It fires when a message arrives on any [channel](messaging.md#channels) and triggers the message-handling [action](actions.md), which runs the [policy engine](messaging.md#policies) to decide routing.

Apps can also observe the agent turn lifecycle with the **agent-turn-started** and **agent-turn-finished** hooks. Lifecycle payloads carry stable session and turn ids, agent name, channel thread context, timing, metrics, status, and final output text where available.

**Contracts:**

- Lifecycle hooks are best-effort and non-blocking: Rome schedules every loaded app hook for the event, logs failures, and does not delay or fail the agent turn when a hook throws.
- Lifecycle payloads never include the prompt text (start metrics carry only its length).
- Lifecycle hooks fire for root agent turns and subagent turns. Subagent events carry a parent reference (parent session, turn, and agent). Apps that only care about root turns filter for events without one.

**Not to be confused with:**

- **[Action](actions.md)** — a hook reacts to a system event and routes into an action. The action is what runs.
- **[Routine](data.md#routines)** — a routine is a guardian- or agent-authored trigger→action binding managed as data. A hook is app-owned code declared in the app's manifest.
