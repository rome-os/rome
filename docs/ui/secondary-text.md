# Secondary Text

Secondary text is the copy under a label: section descriptions, field helper text, hints, card subtitles, empty-state bodies, and tooltip bodies. This file decides whether such a string exists. How it sounds is [`VOICE.md`](VOICE.md).

Out of scope, and never a finding: labels, button text, headings, placeholders, error and validation messages, visually hidden descriptions that exist for `aria-describedby`, long-form pages such as docs and release notes, and `pages/dev/**`.

## The rule

Secondary text carries a fact the user needs before acting and cannot see on the screen. Everything else is omitted. The label says what a thing is, so a description that says it again is deleted, not reworded.

## Facts that qualify

| Kind | Carries | Example |
|---|---|---|
| **Cost** | What the action changes beyond the control itself: other people, other data, billing, or that it cannot be undone | "Notifies all 12 members." / "Deleted files are not recoverable." |
| **Limit** | Format, size, allowed values, or a prerequisite | "PNG or SVG, up to 2 MB." / "Only applies when Claude is available." |
| **State** | A default, an inheritance, or the cause of a state the user did not choose | "Inherited from the workspace." / "No relay credential is stored, so incoming webhooks are not delivered." |
| **Difference** | How this option differs from a sibling rendered on the same screen | "Bot posts as itself. Session posts as you." |
| **First step** | What to do when there is no content, shown only then | "Send a message from Telegram to see it here." |

A term the user would not know ("webhook", "exit node") is explained in a tooltip, not in secondary text.

## The test

Ask four questions of the text, in order. Stop at the first failure.

1. **Is its verb a generic one on the label's noun?** Manage, configure, view, set, control, adjust, customize, "lets you", "here you can", "use this to", or the heading with a period added → the opener goes, and a fact behind it survives on its own. This question comes first because these are the strings an auditor talks into `keep` by reading a fact into the verb.

   > Label: "Notifications". Text: "Manage how you receive notifications." — "manage" on the label's noun, nothing behind it. `delete`.
   > Label: "Connections". Text: "This section lets you connect services that apps can use." — "lets you" on the label's noun, with a fact behind it. `rewrite` → "Apps can only use services connected here."

2. **Which fact does it carry?** None → drop it.

   > Label: "Default region". Text: "Choose the region for new resources." — no fact, only what the control is. Dropped.
   > Label: "Default region". Text: "Existing resources are not moved." — a cost. Passes.

3. **Is the fact already on the screen?** The label, the control's shape (a toggle, a file input, a destructive button), a badge, or a sibling already shows it → drop it. A badge naming a state does not show its cause.

   > Label: "Upload icon", a file input. Text: "Upload an icon for your workspace." — the label and the input already show it. Dropped.
   > Label: "Webhook relay", beside a "Not configured" badge. Text: "No relay credential is stored, so incoming webhooks are not delivered." — the badge names the state, and the cause is nowhere else. Passes.

4. **Is this where the user meets it?** A fact about one control belongs on that control, not on its section → move it.

   > Section: "Access Control". Text: "Apps marked public stay reachable from the public host." — a limit on the app access control, one section away. Moved there.
   > Field: "Workspace icon". Text: "PNG or SVG, up to 2 MB." — a limit on this field, on this field. Passes.

When unsure whether something is a fact, it is not, unless it is a cost, a limit, or a cause. Never invent a cause.

> "Remove the app and erase its data. This cannot be undone." — the first half restates the label, the second is a cost with its subject removed. `rewrite` → "The app's data is deleted permanently and cannot be recovered."

## Repo rules

- A verdict lands in every locale under `packages/web/src/i18n/locales/`. A `delete` removes the key from `en` and `zh-CN`, and a `rewrite` updates `en` and marks `zh-CN` for retranslation.
- A locale key with no call site is `delete`, whatever it says.
- Judge the label that renders beside the string, not the key name. A key called `*.description` may render as a subtitle, a tooltip, or nothing.
- `{{count}}` and other interpolated values count as facts.
