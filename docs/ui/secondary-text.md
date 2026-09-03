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

Ask three questions of every sentence, in order. Stop at the first failure.

1. **Which fact does it carry?** None → drop the sentence.
2. **Is the fact already on the screen?** The label, the control's shape (a toggle, a file input, a destructive button), a badge, or a sibling already shows it → drop the sentence. A badge naming a state does not show its cause.
3. **Is this where the user meets it?** A fact about one control belongs on that control, not on its section → move the sentence.

The string's verdict follows from its sentences:

- Every sentence dropped → `delete`.
- A sentence dropped, moved, or reworded → `rewrite`, with the replacement written out. The replacement passes the three questions on its own and follows `VOICE.md`.
- Every sentence passes → `keep`.

When a string sits between `delete` and `rewrite`, choose `delete`, unless the string carries a cost, a limit, or a cause. Those resolve to `rewrite`: trim to the fact and keep it. Never invent a cause.

> "Remove the app and erase its data. This cannot be undone." — sentence one restates the label. Sentence two is a cost with its subject removed. `rewrite` → "The app's data is deleted permanently and cannot be recovered."

## Never

These openers are `delete` on sight, even when a fact could be salvaged from them. The fact goes into a new string.

- "This section lets you …", "Here you can …", "Use this to …"
- "Manage your …", "Configure your …", "View and edit …"
- Any sentence whose only verb is manage, configure, view, set, control, adjust, or customize, with the label's noun as its object.
- The heading with a period added.

## Repo rules

- A verdict lands in every locale under `packages/web/src/i18n/locales/`. A `delete` removes the key from `en` and `zh-CN`, and a `rewrite` updates `en` and marks `zh-CN` for retranslation.
- A locale key with no call site is `delete`, whatever it says.
- Judge the label that renders beside the string, not the key name. A key called `*.description` may render as a subtitle, a tooltip, or nothing.
- `{{count}}` and other interpolated values count as facts.

## Examples

Each row from this repo was verified against the rendered pair.

| Label | Secondary text | Verdict | Why |
|---|---|---|---|
| Notifications | Manage how you receive notifications. | delete | Forbidden opener. |
| Workspace icon | PNG or SVG, square, up to 2 MB. | keep | Limit. |
| Uninstall | Remove the app. Its data is preserved for a later reinstall. | keep | Difference. "Uninstall and erase data" renders directly below it. |
| Uninstall and erase data | Remove the app and erase its data. This cannot be undone. | rewrite | Sentence one restates the label. → "The app's data is deleted permanently and cannot be recovered." |
| Webhook relay | No relay credential is stored, so incoming webhooks are not delivered to this instance. | keep | State. The "Not configured" badge names the state, not the cause. |
| Fable | Only applies when Claude is available. | keep | Limit. |
| Default region | Existing resources are not moved. | keep | Cost. |
| Access Control | Control who can reach the dashboard. Guardian auth always protects it: allow specific Rome Cloud accounts to sign in, or restrict access to your Tailscale network. Apps marked public or restricted to Rome Cloud email lists stay reachable from the public host. | rewrite | Forbidden opener, then two facts. The state stays: "Guardian auth protects the dashboard whichever option you pick." The public-host fact moves to the app access control. |
| Appearance | Customize the language and look of the dashboard. These preferences are stored on this device. | delete | No call site. |
| On a schedule | These run at a set time. | delete | Restates the heading. |
