---
name: workflow_creation
description: Build a new Rome **workflow app** — one action whose body is a single async function that implements its control flow in plain TypeScript (`await`, `if`, `for`, `Promise.all`) and calls existing actions (including `system:summon`). Use whenever the user describes a multi-step automation OR asks an LLM to produce something from inputs: "read X then do Y", "pull from A, B, C and combine", "monitor … and notify me", "for each item, if … then …", "turn my X into Y", "write/draft/summarize me a … from …". Generative work — writing, drafting, summarizing, judging — belongs HERE as a `system:summon` call, not a separate app with its own agent. A specialization of `coding:app_creation`; reuses its scaffold/build/pack/install mechanics and adds the workflow shell. Build a plain app (`coding:app_creation`) instead only when the thing needs a user-edited data model, multiple distinct operations, or a conversational agent.
tools: [Read, Edit, Bash]
---

# Workflow Creation

A **workflow** is a single Rome action whose body is plain author-written code: one async function, `runWorkflow(input, ctx)`, that transforms the value flowing in and implements its own control flow — sequencing, concurrency, conditionals, fan-out — directly in TypeScript. The run action calls `runWorkflow` directly, and the function reaches reusable work through `ctx.runAction(canonicalId, args)`, which can invoke any registered action — `system:send_message`, a SaaS API via `connector:connector_proxy`, or `system:summon` (hand a piece of work to an LLM agent).

**Each workflow is its own Rome app**, scaffolded from the bundled `workflow` template. The template ships the entire shell — run action, trigger API, web page, run-history table — already wired and buildable. You write the one thing that differs per workflow: the body of `runWorkflow()`.

## Artifact identity — never use bare names

The scaffold is `formatVersion: 2`. Definitions use app-local names (`name: run`);
every reference and runtime call uses `<app-id>:<local-name>`, even for an action
owned by this workflow. Never emit a bare artifact name or `self:<name>`.

Use the real canonical ids for shared platform artifacts:

- LLM work: `ctx.runAction("system:summon", { agentName: "assistant:assistant", prompt })`
- Connected provider API: `ctx.runAction("connector:connector_proxy", args)`
- Messaging: `ctx.runAction("system:send_message", args)`
- Routine creation: `ctx.runAction("system:create_routine", { actionName: "<workflow-app-id>:run", ... })`
- Core orchestrator, only when the workflow explicitly needs it: `core:main`

## Three principles that decide most of the design

These come up on nearly every workflow, so internalize them before writing anything — the rest of the skill assumes them.

1. **Generative work is a `system:summon` call, never a bespoke agent or action.** When the request is "write me a recap / draft replies / summarize these / decide what matters," the tempting move is to stand up a custom *writer agent* plus a `generate` action plus a DB of past results. Resist it — that whole apparatus collapses to one line: `await ctx.runAction("system:summon", { agentName: "assistant:assistant", prompt })`. Put the voice, persona, and instructions in the **prompt**, not a custom agent. A hand-written `action.yaml`/`agent.yaml` is also an error surface: one wrong field fails the whole app to load, and the run then throws "action not found." `system:summon` *is* the agent entry point.

2. **External APIs go through `connector:connector_proxy`, grounded in a supported toolkit.** The connector holds the credential and injects it into a raw HTTP call to the provider's own API. Reach for it first; call an API directly from code only when no connector can broker its toolkit. The endpoint must be the provider's **real, documented** REST/GraphQL endpoint — not invented — on a toolkit from the catalog in your context. Whether the guardian has *connected* that toolkit is a post-build step, not a precondition for writing the code: build first, then ask them to connect what's needed. (Full procedure: [Connector steps](#connector-steps).)

3. **Run history is the shell's job — don't add your own `db:` table.** The template ships a `runs` table and a "Recent runs" list, and the run action records every run (status, input, result, timing) for you. Even a one-shot "gather → write" task needs no results table of its own.

Reach for `coding:app_creation` instead of this skill only when the thing needs a user-edited data model, multiple distinct operations, or a conversational agent (see its litmus).

> **Out of scope here:** scheduling and live run visualization. The workflow runs **on demand** (a "Run now" button / its run action) and **returns its result**. *When* it fires (a routine bound to the run action) and a richer run UI (structure diagram, per-node progress) are separate follow-ups the platform will provide. Build the workflow as if it runs on demand: don't put scheduling in `runWorkflow`, and don't invent a `cron` call.

## What you author (the template ships everything else)

| Per-workflow (you edit) | Shell (template ships it; don't touch) |
| --- | --- |
| `src/workflow/definition.ts` — the `runWorkflow(input, ctx)` function | `src/workflow/context.ts` — the `WorkflowContext`/`Json` types the app owns |
| `app.yaml` `description` + web nav labels | `src/actions/run/` — the run action (calls `runWorkflow`) |
| `.rome_store/rome_store.yaml` + `README.md` store listing copy | `src/api/index.ts` — the `POST /run` trigger + `GET /runs` history feed |
| `src/web/App.tsx` `COPY` block (title + run-button copy) | `src/web/App.tsx` body (incl. "Recent runs") + `styles.css` |
| `src/assets/icon.svg` — replace the placeholder | `src/db/` — the `runs` history table, migrations, and repository |

The template scaffolds with a starter `definition.ts` (one trivial line) so it builds and runs immediately. If your only changes are `definition.ts` + the `COPY` block, you cannot break the shell.

## Step 0 — Derive the control flow (the real work)

Translate the request into the shape of `runWorkflow`'s body **before** touching the filesystem. It is ordinary TypeScript — write control flow with the language's own constructs, threading values through local variables:

- **Sequence** — `await` each call in order; bind each result to a `const` and feed it into the next.
- **Concurrency** — `const [a, b] = await Promise.all([...])` for genuinely independent work. For concurrent work that performs external *writes*, prefer `Promise.allSettled` then throw if any settled `rejected`, so one failure doesn't resolve the run while a sibling is still mutating the world.
- **Conditional** — a plain `if (pred) { … } else { … }` over the values in scope.
- **Fan-out** — `await Promise.all(items.map(async (item) => …))` for concurrent per-item work, or a `for` loop when it must be sequential.
- **Fold** — `items.reduce(...)` / `.filter(...).length` in plain code.

The non-LLM building blocks inside the function:

- **Transform** data with plain code (fold, score, format) — keep values plain JSON as you thread them.
- **Call an existing action** with `await ctx.runAction("<owner-app-id>:<action-local-name>", args)`. The call throws on failure, so the run fails loudly. For a non-SaaS action, resolve its canonical id and argument shape with `search_actions { query }` then `read_action { action_name }` (which summarizes each argument's name/type/required; nested shapes aren't expanded — confirm complex inputs against the owning app's docs). Don't guess. For a SaaS API, use `connector:connector_proxy` per [Connector steps](#connector-steps).
- **Reach for an LLM** with `await ctx.runAction("system:summon", { agentName, prompt })` when a piece of work needs judgment, exploration, or proactiveness. `agentName` is required and canonical; use the general-purpose **`"assistant:assistant"`** for ordinary generative work, and name a more specific installed agent only when one clearly fits. `system:summon` resolves to `{ result, sessionId, output? }` — the generated text is `result`, not the bare object; read and validate `.result` before passing it downstream. A summon can run inside a `Promise.all`/`map`/loop for per-item generation, or once over a whole batch — one batch call is often cheaper and gives the agent cross-item context, while per-item fan-out wins when each item needs independent judgment.

You do **not** register an action per call. The logic is inline in `runWorkflow`, the app ships only the `run` action the template provides, and you call *existing* registered actions by canonical id.

### Worked example — "Find early-stage AI-infra founders from GitHub and LinkedIn plus your own leads table in Supabase; enrich the promising ones; draft a warm intro email for each."

```ts
import { type Json, type WorkflowContext } from "./context.js";

export async function runWorkflow(_input: Json, ctx: WorkflowContext): Promise<Json> {
  // concurrency: three independent sources at once
  const [github, leads, linkedin] = await Promise.all([
    // catalog toolkits: pass only the path; Rome fills in the default host
    ctx.runAction("connector:connector_proxy", { toolkit: "github", path: "/search/users", method: "GET", query: { q: "ai-infra" } }),
    // a toolkit with no fixed host (Supabase is per-project) → name it in `host`
    ctx.runAction("connector:connector_proxy", { toolkit: "supabase", host: "<project-ref>.supabase.co", path: "/rest/v1/leads", method: "GET", query: { select: "*", tag: "eq.ai-infra" } }),
    ctx.runAction("connector:connector_proxy", { toolkit: "linkedin", path: "/v2/...", method: "GET" }),
  ]);

  // pure code: dedupe + score (read each response off `.data`)
  const founders = mergeAndScore([github.data, leads.data, linkedin.data]);

  // fan-out + conditional: enrich only the promising founders
  const enriched = await Promise.all(
    founders.map(async (f) =>
      f.score >= 0.7
        // catalog toolkit → omit host; dynamic value → `query`, never string-built into the URL (query-param injection)
        ? ctx.runAction("connector:connector_proxy", { toolkit: "linkedin", path: "/v2/people", method: "GET", query: { id: f.handle } })
        : null,
    ),
  );

  // empty is a first-class outcome — say so plainly, never fake a success
  const promising = enriched.filter(Boolean);
  if (promising.length === 0) {
    return { ok: false, message: "No promising founders turned up this time." };
  }

  // one `system:summon` over the whole batch — the intros share context
  const drafted = await ctx.runAction("system:summon", {
    agentName: "assistant:assistant",
    prompt: `Draft a warm intro email for each promising founder:\n${JSON.stringify(promising)}`,
  });

  // return a DISPLAY ENVELOPE: the page renders `message`, so hand it the text
  // (`system:summon` resolves to `{ result, … }` — read `.result`, never the bare object)
  return { ok: true, message: (drafted as { result: string }).result, founders: promising };
}
```

One function, every shape you need: `await` for the spine, `Promise.all` for the three sources, plain code for `mergeAndScore`, `map`+`if` to enrich only the promising founders, and a single `system:summon` call to draft the intros. Note three things — control flow is ordinary TypeScript over the values in scope; the LLM work is one `system:summon` call (over the whole batch here because the intros share context, though a per-item call inside the `map` is equally valid); and the generative part is a summon prompt, not a bespoke "writer" agent.

The endpoints and `toolkit` slugs above are **illustrative** — don't copy them blind. Ground each against the provider's real API docs (or a GraphQL introspection query), and confirm each toolkit is connected, via [Connector steps](#connector-steps).

A complete, runnable reference lives at `example_apps/morning-brief/` (it is also seeded into the guardian's `projects/example-apps/morning-brief` as an editable starter). Its `src/workflow/definition.ts` exercises every shape in this skill (sequence, `Promise.all`, `.map`, `.reduce`, `if`/`else`, one `system:summon` call, a dry-run-guarded write) using in-file fixtures, so it runs with zero setup. Read it as the worked reference for the whole app shape.

## Step 1 — Scaffold the workflow template

Follow **app_creation**'s scaffold flow with `template: "workflow"`:

1. Pick `$REPO="${ROME_APP_AUTHORING_ROOT:-$HOME/.rome/${ROME_PROFILE:-default}/projects/apps}/<appId>"` (under the Runtime Context "Custom app authoring directory" — never `$HOME/projects`). `<appId>` is the lowercase-hyphenated workflow name (e.g. `morning-brief`).
2. Scaffold into the empty dir: `system:app_management { "op": "create", "appId": "<appId>", "rootPath": "<absolute $REPO>", "template": "workflow" }`.
3. `git init` + commit, **in that order** — `op: "create"` refuses a non-empty dir, and a pre-existing `.git/` counts.
4. `pnpm install`.

This materializes the app shell (`actions/run`, `api`, `web`) plus the starter `definition.ts` and its `src/workflow/context.ts`. Dev and production scaffold identically — don't hand-copy shell files from another app. The SDK carries no workflow runtime; nothing to copy or rename.

The run action definition is the local name `run`. Runtime calls and routines target its canonical id `<appId>:run` (for example, `morning-brief:run`). Do not copy the app id into the definition name.

## Step 2 — Author the definition

Edit `$REPO/src/workflow/definition.ts` so `runWorkflow(input, ctx): Promise<Json>` implements the control flow from Step 0, replacing the starter. Import `Json` and `WorkflowContext` from the app's own `./context.js` (the template ships it; don't edit it). Keep the body small: transform with plain code, reach external work via `ctx.runAction`, write control flow with the language's own constructs.

This is the only file you author for behavior. Don't add another file under `actions/`, don't add an agent under `agents/`, and don't add your own `db:` table — the code reaches everything through `ctx.runAction(canonicalId, …)`, and the template's `runs` table is the only DB this app needs. (The "why" for each is in [Three principles](#three-principles-that-decide-most-of-the-design).)

For a demo/validation build the user explicitly asked to run without live credentials, returning realistic **fixture** data inline is fine — the shape is identical when you later swap in the real `ctx.runAction` call, and you should say in the app that the value is a fixture. This is the **only** allowed substitute for an unconnected toolkit; never paper over a missing connection with a fixture silently.

### Return a display envelope — the page shows `message`, not your JSON

The web page renders the workflow's return value for a **non-technical guardian**. It does not pretty-print the object — by default it shows a human-readable `message` and nothing else. So `runWorkflow` must return a small envelope:

- **`message`** (string, required for any user-facing outcome) — the result in the guardian's words, as **light markdown** (`**bold**`, line breaks, `-` bullets, emoji all fine). This is the deliverable; if your workflow already composes a message to send somewhere, return that same text here. A bare blob (`{ founders: [...] }`, or the raw `system:summon` object) means the guardian sees a wall of JSON.
- **`ok: false`** — set it when nothing useful happened (no match, empty search). The page then shows a clear empty state instead of a fake success. Never fabricate placeholder values ("the upcoming match", "kickoff TBD") to manufacture a result — a missing input is an `ok: false` outcome, not a license to invent one.
- Any **structured fields** you also return (`founders`, `issueUrl`, …) ride along for power users behind a collapsed "Details" — never the primary surface.

```ts
// good — human-readable, with an honest empty case
if (!bar) return { ok: false, message: "Couldn't find an open bar near you for this match." };
return { ok: true, message, recommendedBar: bar };   // `message` is the formatted blurb you'd post
```

### Connector steps

The toolkits you can use are listed in your context under the `connector` app's entry in "# Installed Apps" — its description names each connectable toolkit (display name and slug). Pick from that catalog instead of searching or probing to discover slugs or endpoints. `connector:connector_proxy` makes a raw HTTP request to the provider's own REST/GraphQL API (the full surface, not a curated subset), so you write the call against the provider's real endpoints — and fills in each toolkit's host for you, so you pass only the `path`.

Build the workflow first; sort out connections after. Connection *status* (whether the guardian has actually connected a given toolkit) is not in your context, and you do not need it to author or install the app — so don't block on it. Write the body and install, then name the toolkits the workflow needs and ask the guardian to connect any that aren't (next step). The catalog tells you a toolkit is connectable and where it lives; that's enough to write correct code now.

1. **Target the real native endpoint — never invent it.** Decide the provider's actual API path and HTTP method (e.g. `POST /graphql` on Linear, `GET /drive/v3/files` on Drive, `POST /api/chat.postMessage` on Slack), grounded against the provider's API docs. Pass it as `path` (beginning with `/`); Rome prepends the toolkit's default host, so you don't repeat it. Supply `host` only for the hard cases the catalog flags — a toolkit with no fixed host (Supabase's `<project-ref>.supabase.co`) or a provider's non-default host (Dropbox content `content.dropboxapi.com`, GitHub uploads `uploads.github.com`). The resolved host must be the toolkit's **own** API domain — `connector:connector_proxy` forwards the connection's credential and refuses any other host. For a GraphQL API (Linear, GitHub v4), discover the schema at runtime with an introspection query through the same `connector:connector_proxy` call — a guessed field 400s, so introspect when unsure.

2. **Write the call against `connector:connector_proxy` and parse the response with zod.** `ctx.runAction("connector:connector_proxy", { toolkit, path, host?, method, body?, query?, headers? })` is shaped like a common HTTP client: `path` is the relative API path, `host` is omitted for single-host toolkits (Rome fills it in), `body` is the JSON request body (a GraphQL `{ query }` object or a REST payload), `query` is a `{ name: value }` object of query-string params, `headers` a `{ name: value }` object. **Never string-build a dynamic or step-sourced value into the `path`** — that's query/path injection. Pass dynamic *query* values via `query` (escaped for you); `encodeURIComponent` a dynamic *path* segment; put request data in `body`; keep `path` a static, documented path.

   `ctx.runAction` already unwraps the action's result envelope: on a 2xx it returns `{ status, data, headers }` (the provider's response verbatim, body on `data`) and it **throws** on any failure — not signed in, toolkit not connected, *or* a non-2xx provider response (the connector fails closed before it reaches you). So there is no `ok` flag to check. Parse `.data` with a zod schema derived from the provider's documented response and narrowed to the fields this workflow consumes, so an upstream shape drift fails loudly instead of threading malformed data downstream:

   ```ts
   import { z } from "@rome-os/app-runtime";

   // derived from GitHub's documented create-issue response, narrowed to what we use
   const IssueCreated = z.object({ number: z.number(), html_url: z.string() }).passthrough();

   // ...inside runWorkflow, where `input` carries owner/repo/title/body:
   if (ctx.dryRun) return input;                         // external write: no-op on a verification run
   const res = await ctx.runAction("connector:connector_proxy", {
     toolkit: "github",                                  // single-host toolkit → omit host, Rome prepends api.github.com
     // dynamic PATH segments → encodeURIComponent (path injection); dynamic QUERY values → `query`
     path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues`,
     method: "POST",
     body: { title: input.title, body: input.body },     // request-body values are JSON, safe as-is
   });                                                   // { status, data, headers } on 2xx; throws on any failure
   const issue = IssueCreated.parse(res.data);           // parse the provider's response body
   const issueUrl = issue.html_url;
   ```

3. **Connect after the build, not before.** Once the app is installed, name the toolkits the workflow uses and ask the guardian to connect any that aren't yet connected, e.g. "this workflow uses GitHub and Slack — connect them from the Connector page (or the `connector:connector_connect` action) and it's ready to run." `connector:connector_proxy` fails closed on an unconnected toolkit, so until then the workflow simply can't run — which is fine; the app is built and waiting. Never swap in a fixture or fake data to dodge a missing connection.

### The web surface — three files, the rest is the template's

A workflow is a real Rome app, so its UI follows app_creation's [`AUTHORING.md`](../app_creation/AUTHORING.md), not a workflow-only standard. The template owns the whole page (run button, "Recent runs", `styles.css`), so you author only three surfaces:

- `app.yaml` — a one-line `description`, `web.navLabel`/`displayName`, and a `tagline` (uncomment the scaffold line and write one sentence, ≤ 80 chars / 40 CJK, benefit-first — it is the share card's only description, see [`app_creation/REFERENCE.md`](../app_creation/REFERENCE.md)).
- the `COPY` block (title, what-it-does, run-button verb, `needsInput`) in `src/web/App.tsx`.
- `src/assets/icon.svg` — replace the template placeholder; never ship the generic glyph.

If the workflow performs a real external action (sends a message, creates an issue, posts to an API), set `COPY.hasSideEffects: true` and write a one-line `COPY.autoTriggerNote` for how it normally fires (e.g. "Runs automatically ~2h before kickoff — use the button to preview."). The page then makes the manual button a safe **preview** (a dry run — your `ctx.dryRun` guards make the writes no-op) and puts "Run for real" behind a confirm, so a curious click never fires a real action by surprise. A read-only workflow leaves `hasSideEffects: false`. This flag and the `ctx.dryRun` write-guards are two halves of one promise — set both whenever the workflow writes.

Apply AUTHORING.md's **"Typography and copy"** rules to the labels and `COPY` text (sentence case, no emoji, no marketing voice) and its **"App Icon"** rules to the glyph (a custom mark grounded in *this* workflow's domain, readable small in light and dark). Those rules are the single source of truth — don't restate or diverge from them here.

## Step 3 — Install, then verify

Hand back to **app_creation** for the tail: commit, then call `system:app_management` with `{ op: "install", source: { mode: "source", path: "$REPO" } }` — one call; the daemon builds, packs into `$REPO/.rome/artifact`, and installs.

> **Known snag — ignore the `defineAction` typecheck error.** `pnpm typecheck` (and editor tooling) may report that `@rome-os/app-runtime` has no exported member `defineAction` / `z`. This is the four-context SDK resolution bug ([#612](https://github.com/amantru/rome-internal/issues/612) / [#613](https://github.com/amantru/rome-internal/issues/613)), not a problem with your code: `rome build` externalizes `@rome-os/app-runtime`, and at runtime the worker is handed the real workspace SDK. Don't investigate node_modules, rewrite imports, or switch the dep to `workspace:*` (that breaks the boot install). Treat it as expected and proceed.

File edits alone are never a complete task — prove it works:

1. **It builds and installs.** `pnpm build` succeeds and emits `dist/actions/run`, `dist/api`, and `dist/web`, and the install lands. This is the bar for "built" — it does not depend on any toolkit being connected.
2. **The installed manifest has a tagline.** `grep -n '^tagline:' .rome/artifact/app.yaml` prints a real sentence, not the scaffold's commented line or its placeholder — a workflow is a shareable app and its card has no description without one.
3. **A run returns a result.** `POST /api/apps/<appId>/run` with `{ "input": … }` (or `{}`) returns `{ "result": … }` — `runWorkflow`'s return value; the dashboard's "Run now" button shows the same. Run this once the workflow's toolkits are connected. If it needs a toolkit the guardian hasn't connected yet, `connector:connector_proxy` fails closed, so this smoke run is expected to fail until they connect — that's not a code bug; finish the connect step first, then run it.

Unlike a full app, a workflow does not need the separate `coding:app_verification` pass — skip it. A workflow is one run action behind a template-shipped shell, so the three checks above are sufficient proof. Confirm them yourself, then report what you built; don't summon a verifier agent.

If the request implied a recurring trigger ("every morning", "weekly"), say so when you hand off — the workflow runs on demand now; scheduling it is a separate follow-up.

## Control-flow quick reference (plain TypeScript)

```ts
export async function runWorkflow(input: Json, ctx: WorkflowContext): Promise<Json> { … }

const a = await ctx.runAction("owner-app:action", args); // sequence: canonical id; thread results through consts
const [a, b] = await Promise.all([p, q]);          // concurrency (allSettled when writing externally)
if (pred) { … } else { … }                         // conditional over values in scope
await Promise.all(items.map(async (it) => …));     // fan-out (concurrent); use a for-loop if sequential
items.reduce(…)/.filter(…).length                  // fold in plain code
```

`ctx` gives the code `runAction(canonicalId, args)` (invoke any registered action, including `system:summon`), `log`, and `dryRun`. There is no engine to author — `WorkflowContext` is a small shell file the app owns (`src/workflow/context.ts`).

## Boundaries

- **New workflow apps only.** Editing an installed workflow is the normal app edit loop (app_creation `AUTHORING.md`); don't hand-build the app outside this flow (the app_creation invariants — permanent git repo, explicit `source` — still apply).
- **Don't add to the app's surface.** No extra `actions/`, no `agents/`.
