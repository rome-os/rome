---
name: app_verification
description: Verify a newly created or newly installed Rome app after `coding:app_creation` or `coding:workflow_creation` finishes installing it. Use only as a second-pass verifier: receive the app id, source root, expected behavior, and local dashboard/API base URL from the creator, then visit the installed app, exercise its safe paths, and report pass/fail evidence. Do not use for scaffolding, implementation, or editing.
tools: [Read, Bash]
---

# App Verification

Use this skill after app creation has finished commit and
`system:app_management { op: "install", ... }`. Your job is to verify the installed app
from runtime evidence, not from the creator's memory, assumptions, or
unverified claims.

The parent/creator should pass only the verification handoff:

- `appId`
- `<app-root>` absolute path
- packed artifact path, normally `<app-root>/.rome/artifact` (daemon-managed
  output of a `mode: "source"` install)
- dashboard base URL and internal API base URL, if known
- the user's original intent and the expected happy path
- any required credentials or external connections already known to be missing
- safe sample inputs for actions/API calls, if the app needs inputs

If any of those are missing, infer what you can from `<app-root>` and the local
Rome runtime. Ask the parent only when the missing information would make the
verification misleading.

## Verification contract

You are a verifier, not the author. Default to read-only inspection plus safe
runtime probes. Do not edit the app, commit, install, or paper over failures. If
you find a defect, report the exact symptom, evidence, and the smallest likely
fix area.

Before testing behavior, establish the app shape:

1. Read `<app-root>/app.yaml`, `.rome_store/rome_store.yaml` when present, `README.md`, and relevant files under `src/`.
2. Identify declared surfaces: `web`, `api`, `actions`, `agents`, `skills`,
   `hooks`, and `db`.
3. Confirm the expected behavior from the handoff maps to those surfaces.

## Required checks

### 1. Build and install evidence

From `<app-root>`:

```sh
pnpm build
git status --short
test -d .rome/artifact
test -f .rome/artifact/app.yaml
```

The build must pass. The working tree should be clean unless the handoff
explicitly says verification is happening before the final commit. The packed
artifact must exist: a `mode: "source"` install builds and packs into
`.rome/artifact` before installing, so its presence is evidence the install ran —
and its absence means the app was never installed from this source root.

If the app was changed after the last install, the verification fails: runtime
behavior would not match source.

### 1b. Share-card tagline

From `<app-root>`:

```sh
grep -n '^tagline:' app.yaml
```

The manifest must carry a non-empty `tagline` — it is the only text the
app's social share card shows and the `og:description` beside it; without one
the card still renders (icon, name, link) but its description line is empty. A missing, empty, or still-placeholder tagline (the
scaffold's commented-out example, or "<Name> in one sentence") is a **fail**:
report "add a one-sentence `tagline` to app.yaml and reinstall" so the creator
fills it in per [`app_creation/REFERENCE.md`](../app_creation/REFERENCE.md)
(≤ 80 chars / 40 CJK, benefit-first, like an App Store subtitle). Length and
line-count are enforced by the installer, so only presence needs checking.

### 2. Installed app visibility

Visit the running Rome dashboard, using the base URL from the handoff or the
local default if obvious:

- `/apps` should list the app.
- `/apps/<appId>` should load the app detail/mounted UI.
- The app name, description, icon, `.rome_store` metadata, and README/App Store listing should match
  the product that was built.

Use browser automation when available so you can catch page-level failures,
blank screens, and console errors. If browser automation is unavailable, use
HTTP probes and state the coverage gap.

### 3. Web UI smoke

If `app.yaml` declares `web`, open `/apps/<appId>` and verify:

- the mounted UI renders non-blank content
- no fatal console errors or failed app bundle requests appear
- primary controls are visible and usable
- loading, empty, error, and content states are represented where applicable
- the UI still looks coherent after a page refresh

For apps with persisted user data, create or use a safe test record, refresh,
and confirm the state still appears.

### 4. API and action behavior

If the app declares `api`, call the expected route(s), usually under
`/api/apps/<appId>/...`, with safe inputs. Verify the response status and body
shape match the app contract.

If the app declares `actions`, run the happy-path action(s) with safe sample
inputs. Prefer read-only or fixture inputs. For write/external side effects,
verify dry-run/status behavior or report the required manual/credential check
instead of causing unintended effects.

For workflow apps, `POST /api/apps/<appId>/run` with the agreed input must
return a result, and the dashboard "Run now" flow should expose the same result.

### 5. Specialized surfaces

Verify only the surfaces the app actually declares:

- `db`: migrations/schema are present; data written by the app survives refresh
  or restart-level reload when feasible.
- `agents`: a safe smoke prompt reaches the intended agent and uses declared
  tools/skills without "unknown agent", "unknown action", or schema errors.
- `skills`: each listed skill directory has a valid `SKILL.md` with frontmatter
  and a trigger-focused description.
- `hooks`: the hook is registered after app reload/install and handles a safe
  sample event or has a clear manual verification path.
- `routines`: if the handoff says scheduling was part of the request, confirm
  the routine targets the installed app action and has the intended cadence.

## Other aspects worth verifying

Call these out in the report when relevant, even if you cannot fully exercise
them automatically:

- permission boundaries and approval behavior for write/external actions
- missing or unconnected external toolkits and credentials
- dark mode and small-screen layout for web apps
- accessibility basics: keyboard path, labels, focus visibility, contrast
- destructive-action safeguards and confirmation flows
- app reload behavior after `POST /apps/reload`
- dependency declarations in the app's own `package.json`
- product fit: the app owns durable user state or multiple operations; otherwise
  it may have been better as a workflow

## Report format

Return a concise verdict:

```text
Verdict: pass | fail | blocked
App: <appId>
Evidence:
- <check>: <result and command/URL used>
- ...
Issues:
- <severity>: <symptom, evidence, likely file/surface>
Gaps:
- <anything not verified and why>
Suggested additional verification:
- <manual or follow-up checks that matter for this app>
```

Use `pass` only when the installed app was visited or probed at runtime and the
declared surfaces work on their safe happy paths. Use `blocked` when the local
runtime, credentials, or required inputs are unavailable.
