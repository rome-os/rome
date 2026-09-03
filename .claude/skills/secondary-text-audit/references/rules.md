# Secondary-Text Rules

The normative ruleset. The audit reads this file in full before assigning a
single verdict — the categories and exceptions are the rubric, and auditing
from memory of the rule names produces soft verdicts.

## Scope

Applies to any subordinate copy attached to a UI element: section descriptions,
field helper text, hint text, card subtitles, empty-state body copy, tooltip
bodies.

Does **not** apply to primary labels, button labels, or headings. Also outside
scope, and never a finding:

- **Visually hidden descriptions.** A `DialogDescription` with `sr-only`, or any
  string whose only job is to satisfy `aria-describedby`, is assistive-tech
  copy, not secondary text. Radix warns without it. Never delete one.
- **Placeholders.** In-control affordance, judged by different rules.
- **Error and validation messages.** They exist because something failed; the
  delete test does not apply.
- **Long-form prose surfaces.** Docs pages, onboarding walkthrough bodies, and
  release notes are content, not subordinate copy.
- **Dev-only surfaces.** `pages/dev/**` (the component gallery) is internal
  documentation whose whole purpose is to describe what things are.

## Core principle

Secondary text exists to carry information the user needs before acting that
they cannot get from the label, the control's shape, or the surrounding
context. It never exists to describe what something *is*. The label already
does that.

**Default is to omit.** Writing secondary text is the exception and requires
justification under this document. `delete` is the expected majority outcome
for description-style text.

## Authoring protocol

Before writing any secondary text, answer these in order. Stop at the first
"no" and omit the text. When auditing, run the same four tests against existing
text — the tests are the verdict procedure, not just a writing aid.

### 1. Delete test

If this text did not exist, would the user make a wrong decision, get stuck, or
face genuine ambiguity? If no → omit.

The bar is a wrong decision, not a slower one. "The user would have to click to
find out" is not getting stuck.

### 2. Category test

Which ONE of the following does the text carry?

| Category | Carries | Example |
|---|---|---|
| `consequence` | What happens after the action, especially side effects on other people, other data, or billing | "Notifies all 12 members." |
| `constraint` | Format, limit, allowed values, prerequisite | "PNG or SVG, up to 2 MB." / "Requires admin role." |
| `hidden-state` | A default, inheritance, or current condition not visible in the control | "Currently inherited from workspace." |
| `disambiguation` | How this option differs from a sibling that could plausibly be confused with it | "Bot posts as itself; session posts as you." |
| `irreversibility` | Cannot be undone, or undo has a time limit | "Deleted files are not recoverable." |
| `empty-state-guidance` | What to do first, shown only when there is no content | "Send a message from Telegram to see it here." |
| `unfamiliar-term` | The label uses a term the target user genuinely would not know | "Webhook — the URL a service calls when something happens." |
| `unchosen-state` | Why the surface is in a state the user did not pick | "No relay credential is stored, so incoming webhooks are not delivered." |

If the text does not fit exactly one category → omit.

Category qualifiers:

- `disambiguation` is only valid when the sibling **actually exists on the same
  screen**. Check the render, not the intent. A card whose sibling lives on
  another tab does not qualify.
- `empty-state-guidance` must **disappear once content exists**. Text that
  renders in both states is not empty-state guidance; judge it as if the empty
  state did not exist.
- `unfamiliar-term` — prefer a tooltip or one-time onboarding over permanent
  secondary text. Rome's users are non-technical: "webhook", "exit node",
  "bond level" may qualify; "settings", "project", "agent" do not.
- `consequence` covers what happens *after* the action. A restatement of what
  the control does *is* the action, not its consequence.
- `unchosen-state` applies only where the user did not choose the state — an
  empty panel, a disconnected service, a blocked queue. A nearby status badge
  naming the state does **not** make the cause redundant: "Not configured"
  names the state, and the cause tells the user what to go fix. Drop the cause
  only when the surface offers a control that fixes it, and name the control
  instead. Never invent a cause — an inaccurate reason is worse than none.

### 3. Restatement test

Remove every word that also appears in the label or heading, including synonyms
and inflections. Is there substantive information left? If no → omit.

**Run this per sentence, not per string.** A two-sentence description whose
first sentence restates the label and whose second carries a real category is a
`rewrite` that drops sentence one, never a `delete` of both. The payload
usually sits in the second sentence.

> "Remove the app and erase its data. This cannot be undone." — sentence one
> restates the label, sentence two is `irreversibility`. Drop sentence one.
> Do not delete the string.

### 4. Placement test

Is this the earliest moment the user needs it, and the only place they will
look? Text that explains a whole section usually belongs on the specific control
that has the constraint, not the section header.

A section description carrying a constraint that applies to exactly one control
inside it is a `rewrite` (move it) even when the text itself is good.

## Forbidden openers and patterns

Any secondary text matching these is automatically `delete`, regardless of the
tests above. They are restatement in disguise, and the argument that a category
could be salvaged from them is the failure mode this list exists to stop.

- "This section (allows you to / lets you / is used to / is where you) …"
- "Here you can …"
- "Manage your …" / "Configure your …" / "View and edit …"
- "Use this to …"
- Any sentence whose only verb is a generic action verb (manage, configure,
  view, set, control, adjust, customize) with the label's noun as object.
- Marketing adjectives: easily, seamlessly, powerful, simple, quickly.
- Repeating the heading with a period added.

**Exception — none.** If a forbidden-pattern string is the only place a real
constraint or consequence is stated, the verdict is still `delete` for that
string; write the payload as a new sentence in the `Replacement` column and say
so. The pattern never survives, the information does.

## Style rules for text that passes

Tone, register, person, and contractions are not decided here. They live in
[`docs/ui/VOICE.md`](../../../../docs/ui/VOICE.md), and a replacement string
must obey it. The rules below are the ones tied to information content.

`VOICE.md` carries two register settings. Every string this skill judges takes
the **standard** setting: the economical setting covers failure copy, and error
and validation messages are outside this skill's scope entirely. A replacement
written as a bare phrase has reached for the wrong setting.

- One sentence. Two only if the second is a distinct category. Three only when
  the third states what needs no action.
- Lead with the information, not with throat-clearing. "Up to 2 MB" not "Files
  can be up to 2 MB in size."
- **Purpose before action.** When a sentence carries both a reason and the
  keystroke that serves it, the reason goes first — it is the payload, and the
  keystroke is the throwaway. This is `WRITING.md`'s condition-before-command
  rule, and Microsoft, Material, and Apple publish it independently.

  > Prefer: "To restrict the dashboard to your tailnet, connect this machine to Tailscale."
  > Over: "Connect this machine to Tailscale to restrict the dashboard to your tailnet."

- State facts, not permissions. "Notifies all members" not "You may want to know
  this notifies all members."
- No terminal period on fragments; keep periods on full sentences.
- Numbers, units, and conditions are signals of real content. If the text has
  none of: a number, a unit, a condition word (if / when / only / unless /
  until / after), a negation, or a named sibling — re-examine it. It is probably
  description.

The last rule is a prompt to re-examine, not a verdict. `consequence` text often
carries a condition word; `constraint` text often carries a number. Text with
neither is usually description, but "Existing resources are not moved" passes on
its negation alone.

## Verdict rules

Assign exactly one of `keep`, `rewrite`, `delete`.

- Category `none` → `delete`. No exceptions.
- Matches a forbidden pattern → `delete`, even if a category could be argued.
- Fails the restatement test → `delete`.
- Fails the placement test but carries a valid category → `rewrite` (state the
  new location in the replacement).
- Has a valid category but is padded, hedged, or leads with context →
  `rewrite`.
- Passes everything → `keep`.

Do not soften verdicts. When uncertain between `delete` and `rewrite`, choose
`delete`; the primary label almost always suffices.

`rewrite` requires a `Replacement`. `delete` leaves it empty. A `rewrite` whose
replacement would itself fail these rules is a `delete`.

## Repo-specific rules

- **Every verdict lands in every locale.** Copy lives in
  `packages/web/src/i18n/locales/<locale>/*.json`. A `delete` removes the key
  from `en` *and* `zh-CN`; a `rewrite` updates both. A verdict applied to `en`
  alone leaves the other locale rendering the deleted text.
- **A locale key with no call site is dead copy**, whatever its verdict would
  have been. Report it as `delete` with the reason `unrendered` — the string
  ships in the bundle and misleads the next author.
- **Judge the rendered pair, not the key name.** A key named `*.description`
  may render as a card subtitle, a tooltip body, or nothing. The label that
  matters is the one rendered beside it, which the extractor guesses from the
  sibling key — verify it when the row carries `label-inferred`.
- **Interpolated values count as content.** `{{count}} members will be notified`
  carries a number even though the extractor sees a placeholder.

## Worked examples

| Label | Secondary text | Verdict | Why |
|---|---|---|---|
| Notifications | Manage how you receive notifications. | delete | Forbidden pattern; restatement. |
| Notifications | Applies to email only. In-app alerts are always on. | keep | `constraint` + `hidden-state`; not inferable. |
| Team members | View and manage the people in your workspace. | delete | Forbidden pattern. |
| Team members | Removing a member revokes their API keys immediately. | keep | `consequence` + `irreversibility`. |
| Workspace icon | Upload an icon for your workspace. | delete | Restatement of label + control shape. |
| Workspace icon | PNG or SVG, square, up to 2 MB. | keep | `constraint`. |
| Connections | This section lets you connect third-party services that Rome apps can use. | rewrite | Buried `hidden-state`. → "Apps can only use services connected here." (Or delete if the page has an empty state saying this.) |
| Default region | Choose the region for new resources. | delete | Restatement. |
| Default region | Existing resources are not moved. | keep | `consequence`, non-obvious. |
| Danger zone | Actions here are irreversible. | keep | `irreversibility`, and it's the section's whole point. |
| Danger zone | This section contains destructive actions for your workspace. | delete | Restatement of "Danger zone" with more words. |

### Worked examples from this repo

Each row below was verified against the rendered pair, not the key name.

| Label | Secondary text | Verdict | Why |
|---|---|---|---|
| Uninstall | Remove the app. Its data is preserved for a later reinstall. | keep | `disambiguation` — "Uninstall and erase data" renders directly below it, and nothing else says which one keeps the data. |
| Uninstall and erase data | Remove the app and erase its data. This cannot be undone. | rewrite | Sentence one restates the label word for word. Sentence two is real `irreversibility`, but "Cannot be undone." alone strands the reader on *what* cannot be undone. → "The app's data is deleted permanently and cannot be recovered." |
| Webhook relay | No relay credential is stored, so incoming webhooks are not delivered to this instance. | keep | `unchosen-state`. A "Not configured" badge renders beside it, and trimming to the effect alone ("Webhooks are not delivered") deletes the only thing telling the reader what to fix. No control on this surface stores a credential. |
| Upgrade Rome to {{version}}? | Rome restarts to apply the upgrade. Expect a few minutes of downtime, and any work in progress is interrupted. This page reconnects automatically once Rome is back. | keep | Three sentences, three jobs: cause, cost, and what needs no action. The restart is not restatement of the title — it is the mechanism that explains the downtime. |
| Access Control | Control who can reach the dashboard. Guardian auth always protects it: allow specific Rome Cloud accounts to sign in, or restrict access to your Tailscale network. Apps marked public or restricted to Rome Cloud email lists stay reachable from the public host. | rewrite | Opens with a generic verb on the label's noun, then buries two payloads in 42 words. Split by placement: `hidden-state` → "Guardian auth protects the dashboard whichever option you pick"; the public-host carve-out belongs on the app access control, not this section header. |
| Appearance | Customize the language and look of the dashboard. These preferences are stored on this device. | delete | Unrendered — no call site anywhere. It would also fail on the forbidden opener; the surviving `hidden-state` payload ("stored on this device") is worth re-adding on the control that owns it, as new text. |
| Model selector | Show a chat composer selector for the large model mapping. | delete | Generic verb on the label's own noun. The toggle label "Enable model selector in chat" already says where it appears. |
