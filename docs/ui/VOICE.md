# UI Voice

How Rome's interface sounds. This governs every string a guardian reads in the dashboard, in apps, and in the desktop shell: labels, secondary text, dialog bodies, empty states, and status lines.

Three rulebooks meet here, and they do not overlap.

| Question | Rulebook |
|---|---|
| Should this string exist at all? | [`secondary-text.md`](secondary-text.md) |
| How does it sound once it earns its place? | This file |
| How does prose in `docs/` read? | [`authoring/WRITING.md`](../authoring/WRITING.md) |

`WRITING.md` governs documentation, not product copy. Where the two disagree, this file wins for anything rendered in a UI. The prose of this file follows `WRITING.md`, like every other doc.

## The register

Rome is plain and calm. It describes what the system does and what that costs. It does not perform warmth, and it does not apologize.

Warmth comes from plain words and complete explanations, not from adjectives, exclamation marks, or sympathy.

<!-- vale Rome.Contractions = NO -->
> Prefer: "No relay credential is stored, so incoming webhooks are not delivered to this instance."
> Over: "Oops — looks like your webhook relay isn't set up yet!"
<!-- vale Rome.Contractions = YES -->

## Two settings

The voice never changes. The register has two settings, and one question picks between them: **has the thing already failed?** `[llm]`

| Setting | Applies to | Shape |
|---|---|---|
| **Standard** | Everything the guardian chose to open: settings, toggles, section descriptions, confirmations, empty states, onboarding | Full sentences with terminal periods. Up to three. Explanations run as long as the facts require. |
| **Economical** | Copy reporting a failure: error messages, validation text, failed-request notices, degraded-status lines | Short phrases rather than sentences. No terminal period on a fragment. One clause when one clause carries it. |

The split is not severity. A destructive confirmation takes the standard setting, because the guardian is deciding and needs the facts to decide with. An error is economical because the decision is already behind them, the outcome is fixed, and more words add nothing.

> Prefer: "Failed to load apps" (economical — the request already failed)
> Over: "We were unable to load your apps at this time."

> Prefer: "The app's data is deleted permanently and cannot be recovered." (standard — a confirmation, not a failure)
> Over: "Cannot be undone." — the economical shape on a decision, which leaves out what cannot be undone.

Where a surface reports a state the guardian did not choose but nothing failed — an unconfigured service, an empty panel — the setting is standard. Those need a cause, and a cause does not fit in a phrase. `[llm]`

## Person

The interface is the subject. The guardian appears as the owner of a thing or the beneficiary of an outcome, never as the party at fault for a state. `[llm]`

> Prefer: "No relay credential is stored, so incoming webhooks are not delivered to this instance."
> Over: "You have not stored a relay credential, so you are not receiving webhooks."

Use "you" and "your" for possession and benefit. Use the imperative for an instruction. Do not use "you can" when the sentence works without it. `[llm]`

> Prefer: "Applies to the public Rome URL. Your own dashboard access is not affected."
> Over: "You can control who reaches your app from the public Rome URL."

**Rome names itself only when Rome is the actor.** A restart, a check, a deletion Rome performs, or a statement about what Rome stores. Everywhere else the feature or the effect is the subject. `[llm]`

> Prefer: "Rome restarts to apply the upgrade." (Rome performs the restart)
> Over: "Rome hides this app and Rome stops its agents." (the toggle does this, not Rome)

## Contractions

<!-- vale Rome.Contractions = NO -->
Spell out negative contractions. Write "cannot", "does not", "is not". Readers scanning a screen misread "can't" as "can", and Rome's negations usually carry the consequence of a destructive action. `[mech]`
<!-- vale Rome.Contractions = YES -->

Positive contractions are allowed.

<!-- vale Rome.Contractions = NO -->
> Prefer: "The app's data is deleted permanently and cannot be recovered."
> Over: "The app's data is deleted permanently and can't be recovered."
<!-- vale Rome.Contractions = YES -->

## Sentence shape

On the standard setting, write complete sentences with terminal periods. Fragments belong to labels, badges, and the economical setting, not to the text beneath a label. `[llm]`

On the economical setting, prefer the phrase. Drop the subject when the surface supplies it, and drop the terminal period with the sentence. `[llm]`

> Prefer: "Could not reach the relay"
> Over: "Rome could not reach the relay at this time."

State the reason before the action it justifies. This matches `WRITING.md`'s condition-before-command rule, and Microsoft, Material, and Apple publish the same order. The reader needs the reason more than the action. `[llm]`

> Prefer: "To restrict the dashboard to your tailnet, connect this machine to Tailscale."
> Over: "Connect this machine to Tailscale to restrict the dashboard to your tailnet."

Flag any single sentence over 25 words for splitting. Three sentences is the ceiling for one string. `[mech]`

## What a description carries

On the standard setting, secondary text that survives the audit carries as much of this as is true, in this order. `[llm]`

1. **Effect** — what changes, stated as an outcome rather than a mechanism.
2. **Occasion** — when a guardian would want this, when it is not obvious.
3. **Cost or scope** — what it costs, what it breaks, where it stops applying, or what happens in the off state.

Keep the third element. It separates copy that informs from copy that restates its label.

> Prefer: "Hides pinned-agent names, avatars, and the composer chip. Applies to this browser only."
> Over: "Hides pinned-agent names, avatars, and the composer chip."

**State the cause when a screen reports a state the guardian did not choose.** An empty panel, a disconnected service, or a blocked queue needs the reason it is in that state, not only the effect. Drop the cause only when the screen offers a control that fixes it, in which case name the control instead. `[llm]`

> Prefer: "No relay credential is stored, so incoming webhooks are not delivered to this instance."
> Over: "Webhooks are not being drained to this instance."

**Never invent a cause.** An inaccurate reason is worse than no reason. When the reason is unknown, say the outcome and stop. `[human]`

**Do not state what the reader can trivially deduce.** A description that repeats its label, or a remedy implied by the problem, is deleted rather than reworded. The words it frees are spent on the cost or the scope. `[llm]`

> Prefer: "Only applies when Claude is available."
> Over: "Routes large models to Fable. Only applies when Claude is available." (the toggle label already says where the models go)

## Never

These fail regardless of anything above. `[mech]`

<!-- vale Rome.Marketing = NO -->
- "Oops", "Uh-oh", "Whoops", or any interjection.
- "Sorry". Rome states outcomes, it does not apologize.
- "Please", except when Rome is at fault or when asking the guardian to wait.
- Exclamation marks in any failure, warning, or confirmation.
- Marketing adjectives: seamless, powerful, effortless, simple, quickly, easily.
- Jokes and winks. A guardian reading this string may be losing data.
<!-- vale Rome.Marketing = YES -->

## Worked examples

Each row was verified against the rendered pair.

### Standard

| Label | Copy | Why |
|---|---|---|
| Enabled | When off, the app is hidden and its agents, actions, and hooks stop running. | Effect plus off-state. The switch shows the state, not the blast radius. |
| Uninstall | Remove the app. Its data is preserved for a later reinstall. | The sibling row erases data. Nothing else on screen separates them. |
| Uninstall and erase data | The app's data is deleted permanently and cannot be recovered. | Cost, spelled-out negative, no softening. |
| Upgrade Rome to {{version}}? | Rome restarts to apply the upgrade. Expect a few minutes of downtime, and any work in progress is interrupted. This page reconnects automatically once Rome is back. | Rome is the actor. Cause, then cost, then what needs no action. |
| Webhook relay | No relay credential is stored, so incoming webhooks are not delivered to this instance. | Unchosen state, so the cause leads. No control on this screen fixes it. |
| Access for {{name}} | Applies to the public Rome URL. Your own dashboard access is not affected. | Scope, plus the misreading it prevents. |
| Allowed emails | Grants the full dashboard, not just individual apps. | Cost. Apps carry their own email lists, so the wider grant is the surprise. |
| Fable | Only applies when Claude is available. | Prerequisite. The toggle saves cleanly and does nothing without it. |
| On a schedule | *(no description)* | "These run at a set time" restates the heading. Deleted, not reworded. |

### Economical

| Copy | Why |
|---|---|
| Failed to load apps | The request failed and the outcome is fixed. No subject, no period, no elaboration. |
| Could not log out of Claude. Please try again. | A period survives because a second sentence does. "Please" is licensed here — the software is at fault. |
| These emails look invalid: {{emails}} | Validation. Naming the offending values is the whole job. |
| Failed to load trace (HTTP {{status}}) | The status code is the one fact a phrase should still carry. Diagnostic detail is not elaboration. |
