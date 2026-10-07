---
name: import-skill
description: Import a Rome skill from a URL, a pasted SKILL.md, or a plain-language description — validate it against Rome's frontmatter parser, preview the final file, and install it into the user-skills carrier app after the guardian confirms.
tools: [Read, Write, Edit, Bash, Glob, Grep, WebFetch]
---

# Import a skill

Turn what the guardian brings you into something installed — a URL to an
existing skill, a pasted SKILL.md, or a description of one they wish existed.
Brainstorm with them: propose, listen, revise. Don't install anything without
getting a clear go-ahead.

Most of what you're handed is a plain skill for the user-skills carrier. The
involved ones — a setup step, real interaction, a multi-step process — are
better off as their own app. Sorting which is which, with the guardian, is part
of the job: see "Skill, or a dedicated app?" before you install.


## Classify the input

- **URL** → see "Resolving a URL".
- **Pasted SKILL.md** (frontmatter + body, or close to it) → validate, preview.
- **Description** (prose, a wish, a workflow explained) → see "Generating".
- **Empty or ambiguous** → ask one short question. Don't guess.

## Resolving a URL

- `github.com/<owner>/<repo>/blob/<ref>/<path>` → fetch the raw form
  `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`.
- `github.com/<owner>/<repo>/tree/<ref>/<dir>` → list it via
  `https://api.github.com/repos/<owner>/<repo>/contents/<dir>?ref=<ref>` and
  download the SKILL.md plus its auxiliary files.
- Bare repo → look for `SKILL.md` at the root, then under `skills/`.
- Anything else → fetch it; if it's skill-shaped, proceed; if it's prose
  describing a workflow, offer to generate a skill from it.

If the source holds more than one skill (several `SKILL.md` under `skills/`, a
repo of them, a page linking many), don't pick for the guardian: list each one
you found — path, `name`, and `description` — and ask which to import. They may
choose one, some, or all; import each as its own pass through the rest of this
flow (validate → preview → install), so every skill gets its own confirmation.

On a network error or 404, say so and ask for a corrected link.

## Generating from a description

The guardian is the domain expert; you're the author. Ask at most 2–3 focused
questions, only where the description is genuinely open:

- **Trigger** — when should an agent reach for this? (Becomes the description
  line, which is also the search index.)
- **Procedure** — the concrete steps, commands, decision points. "Check the
  logs" isn't an instruction; "run X and look for Y" is.
- **Tools** — which built-ins the steps need.
- **Boundaries** — what it should refuse or hand off.

Draft the SKILL.md yourself and preview it. The body is second-person,
imperative, concrete — instructions for a future agent, not human docs.

## Skill, or a dedicated app? Decide before you install

A skill is pure instructions an agent reads. Some requests are apps wearing a
SKILL.md, and the carrier gives them a worse version of what they asked for.
Once you understand the request, judge it. App-shaped signals — any one means
it wants to be its own app:

- an **init / setup** step before it's usable (credentials, first-run config);
- it needs to **interact** — ask and react, not just run top-to-bottom;
- a real **multi-step process**, its own **data / operations / UI**, or
  **background / scheduled** execution.

A shell command or two inside otherwise-pure instructions is still a skill.
When the signals are real, put the choice to the guardian — don't pick for them:

- **Import as a skill** → the user-skills carrier (the flow below).
- **Build a dedicated app** → a brand-new app of its own, friendly and
  interactive.

Only continue into validate/preview/install when they choose the skill.

## Building a dedicated app

Read the `coding:app_creation` skill with `read_skill` and follow it to scaffold,
build, and install a brand-new app — its OWN app id, **never** user-skills or
the carrier. Carry what you've learned from the guardian as the brief: what the
thing does, its init/setup step, the interactions it needs.

Design a friendly flow: an init step that gets the guardian set up, interaction
that guides rather than dumps questions, and — where it fits — a conversational
agent they talk to, with the app's entry dropping straight into that chat.
(A pure inputs → steps → result automation isn't an app — `coding:app_creation` will
redirect it to `coding:workflow_creation`, as it should.)

## Validate against Rome's parser

Rome parses frontmatter with regexes, not YAML. A violating skill installs but
is silently dropped from the catalog. Enforce on every skill:

1. Starts with a `---` line and has a closing `---`.
2. `name:` is a single lowercase kebab-case line matching the install folder.
3. `description:` is a single line — collapse folded (`>`) or multi-line ones.
4. `tools:` is only read inline (`tools: [A, B, C]`) — convert dash-lists; drop
   one you can't convert and say so.
5. Other keys are ignored, harmless — keep them.

Auto-fix 2–4 and note each fix in the preview. Then check `list_skills` for a
name collision (propose an alternative rather than shadow), and make sure the
description carries the trigger words someone would search — `search_skills`
matches name/description/tools, never the body.

## Preview, then confirm

Show the guardian the complete final SKILL.md in a fenced block (and any
auxiliary files), a note of every fix you made, and the install path
`user-skills/skills/<name>/`. Ask, and wait. Anything short of a clear yes is
feedback — revise and preview again.

## Install into the carrier

Skills install into one carrier app, `user-skills`, at
`<custom app authoring directory from your Runtime Context>/user-skills`
(`~/.rome/<profile>/projects/apps/user-skills`).

<!-- Keep this layout in sync with rome_apps/dream/src/lib/user-skills-carrier.ts,
which scaffolds the same carrier for Dream's skill review. -->

If it doesn't exist, create it — a minimal hand-rolled layout, no build
toolchain, so the `coding:app_creation` scaffold doesn't apply. It must ship a logo and a minimal web UI, or it shows up in the Apps
list as a broken-looking entry. Write the files below exactly; the manifest is
schema-validated (`assetVersion` 12 hex chars, `routing: "client"`, entry
exports `mount`). Backfill these into an existing carrier that's missing them.

```yaml
# user-skills/app.yaml
formatVersion: 2
id: user-skills
name: User Skills
version: 0.1.0
description: Skills imported or generated via the Skills app.
icon: assets/icon.svg
web:
  manifest: web/manifest.json
skills: []
```

```svg
<!-- user-skills/assets/icon.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <rect width="64" height="64" rx="14" fill="#6366F1"/>
  <path d="M33 14 21 32h7l-3 13 12-18h-7l3-13Z" fill="#fff" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
  <circle cx="44" cy="44" r="11" fill="#fff"/>
  <path d="M44 39v10M39 44h10" stroke="#6366F1" stroke-width="2.5" stroke-linecap="round"/>
</svg>
```

```json
// user-skills/web/manifest.json
{
  "entry": "index.js",
  "styles": [],
  "assetVersion": "000000000001",
  "displayName": "User Skills",
  "navLabel": "User Skills",
  "routing": "client"
}
```

```js
// user-skills/web/index.js — hand-written ESM, no build step.
export function mount(root) {
  root.innerHTML = `
    <div style="display:flex;min-height:100%;align-items:center;justify-content:center;font-family:var(--font-sans,sans-serif);color:var(--foreground,#111)">
      <div style="max-width:28rem;text-align:center;padding:3rem 2rem">
        <h1 style="font-size:1.25rem;font-weight:600;margin:0 0 .5rem">User Skills</h1>
        <p style="margin:0 0 1.25rem;font-size:.875rem;color:var(--muted-foreground,#666)">
          This app only carries the skills you import or generate.
          Browse, search, and manage them in the Skills app.
        </p>
        <a href="/apps/skills" id="open-skills" style="color:var(--primary,#6366f1);font-weight:500;text-decoration:none">Open Skills &rarr;</a>
      </div>
    </div>`;
  root.querySelector("#open-skills").addEventListener("click", (e) => {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent("rome:host-navigate", { detail: { path: "/apps/skills" } }));
  });
}
```

Plus `package.json`: `{ "name": "user-skills", "private": true, "type": "module" }`
and an empty `skills/` directory. If you later edit `web/index.js`, bump
`assetVersion` to a new 12-hex string so the browser drops the cached bundle.

Then, for the confirmed skill:

1. Write `skills/<name>/SKILL.md` plus any auxiliary files.
2. Add `skills/<name>` to the `skills:` list in app.yaml.
3. `git add -A && git commit -m "Add skill <name>"`.
4. Install: `system:app_management` with
   `{ "op": "install", "source": { "mode": "source", "path": "<carrier-abs-path>" } }`
   — the daemon builds, packs, and installs in one step.

If a step fails, show the error, fix what you can, and say where things stand.

## Verify

Call `list_skills` and confirm the new name is present. If it isn't, the catalog
dropped it — almost always a frontmatter rule. Fix and re-install once; if it
still doesn't appear, report what you tried. Once you've seen it listed, tell
the guardian it's live: they can invoke it in any chat with `/<name>`, or find
it in the Skills app.
