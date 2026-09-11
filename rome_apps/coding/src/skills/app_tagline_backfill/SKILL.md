---
name: app_tagline_backfill
description: Give apps built on this instance a share-card `tagline` when their `app.yaml` has none. Runs automatically once after Rome upgrades (AUTO mode, list supplied by the caller) or on request from the guardian ("add taglines to my apps", MANUAL mode, confirm before writing). Only touches editable `mode: "source"` apps — never App Store bundles or first-party apps.
tools: [Read, Bash]
---

# App Tagline Backfill

Apps created before `tagline` existed share a card with an empty description.
This skill adds one sentence to each such app, commits it, and reinstalls so
the card is redrawn. It edits nothing else.

## Modes

- **AUTO** — the caller (the coding app's `agent-turn-finished` hook) hands
  you the absolute source roots to process. Nobody is watching: skip the
  confirmation step, process every listed app, and finish with the report.
- **MANUAL** — the guardian asked. Discover the apps yourself (step 1), show
  the draft table (step 3), and write only after they approve or edit it.

## Step 1: Discover (MANUAL only)

```bash
LOCK="$HOME/.rome/${ROME_PROFILE:-default}/apps.lock.json"
node -e '
  const lock = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const [id, e] of Object.entries(lock.apps)) {
    if (e.source.mode === "source" && e.enabled && e.state === "installed") console.log(id, e.source.path);
  }
' "$LOCK"
```

For each printed root, an app qualifies when `<root>/app.yaml` has a `web:`
block and no `tagline:` line:

```bash
grep -q '^web:' "$ROOT/app.yaml" && ! grep -q '^tagline:' "$ROOT/app.yaml" && echo "$ROOT"
```

Skip everything else and say why in the report: `appstore` entries (read-only
bundles, the author owns them), first-party apps (shipped with Rome, already
done), apps without `web:` (no card), apps that already have a tagline.

## Step 2: Draft one sentence per app

Read `name`, `description`, and `README.md` (if present) under the root.
Write the tagline by the same rule `app_creation/REFERENCE.md` gives:

- One sentence, at most 80 characters (40 for CJK). No line breaks.
- Lead with what the user gets. No implementation details, jargon, or
  acronyms. Read it like an App Store subtitle.
- Do not copy `description` — it is written for agents, not people.

Good: `Track every mortgage rate that matters to you, updated daily.`
Bad: `A cron-driven scraper that stores rates in SQLite.` (mechanism, not benefit)
Bad: `Mortgage Monitor` (a name, not a sentence)

## Step 3: Confirm (MANUAL only)

Show a table `id | name | tagline` and wait. Apply any edits the guardian
makes. In AUTO mode go straight to step 4.

## Step 4: Write, commit, reinstall, verify — one app at a time

```bash
cd "$ROOT"
# Insert right after the description. For a block-scalar description (`>-`
# or `|`), insert after its last indented line instead.
python3 - "$ROOT/app.yaml" <<'EOF'
import re, sys
path = sys.argv[1]; text = open(path).read()
line = 'tagline: "REPLACE WITH THE SENTENCE"\n'
m = re.search(r'^description:.*(?:\n[ \t]+.*)*\n', text, re.M)
text = text[:m.end()] + line + text[m.end():] if m else text + line
open(path, 'w').write(text)
EOF
git add app.yaml && git commit -m "chore: add share-card tagline"
```

Then reinstall through the daemon (the same call `app_creation` uses; always
pass `source` explicitly):

```
system:app_management { op: "install", source: { mode: "source", path: "<absolute ROOT>" } }
```

Verify the packed manifest carries the line:

```bash
grep -n '^tagline:' "$ROOT/.rome/artifact/app.yaml"
```

If the install fails, roll that app back and continue with the next one:

```bash
git -C "$ROOT" revert --no-edit HEAD
```

The reinstall triggers the card to be redrawn; nothing else is needed.

## Step 5: Report

List, in this order: apps updated (id and the tagline written), apps
skipped (with the reason), apps that failed (with the error and that the
commit was reverted). In AUTO mode this report is your final message; the
hook stores it. In MANUAL mode show it to the guardian.
