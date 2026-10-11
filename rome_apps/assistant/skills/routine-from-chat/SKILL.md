---
name: routine-from-chat
description: Turn a plain-language "do this automatically" request into a routine — either event-triggered ("text me when I get an email from my landlord") or scheduled ("remind me every Friday at 9am"). For third-party events (Gmail, GitHub, Slack…) it confirms with the guardian and then subscribes to the connector trigger so the event actually fires, even one that has never fired before. Ask for any missing detail, then confirm with a card. Reach for this first whenever the guardian wants something to happen automatically; do not explore the codebase or hand-build a trigger.
tools: [ask_question, search_event_catalog, connector_login, connector_connect, connector_event_search, connector_event_schema, connector_event_subscribe, propose_routine, summon, send_message]
---

# Create a routine from chat

When the guardian describes something they want to happen automatically, turn
that intent into a **routine** — without making them learn event names, RRULEs,
timezones, filters, or JSON. They speak in their language; you map it to a
concrete trigger, ask only for what you genuinely can't infer, then show a
card. You do **not** call any create action yourself — `propose_routine` does
it: the card creates the routine when they turn it on, or creates it right away
with `activate: true` (see step 4).

A routine fires one of three ways. Decide which the request is:

- **Event** — "when X happens": an email arrives, a payment lands, a form is
  submitted. Reactive, no fixed time.
- **Schedule** — "at a time / on a cadence": "every Friday at 9am", "tomorrow
  at noon", "the 1st of each month", "every morning".
- **Manual** — "save this so I can run it whenever": a playbook with **no**
  automatic trigger. the guardian runs it by hand from the Routines page's 
  "Run now" button.

If it's ambiguous ("remind me about the standup"), ask one short question to
disambiguate before going further. In particular, if it's unclear whether they
want it on a schedule or to run it by hand, ask.

## The flow

1. **Classify** the request as event, schedule, or manual (above).
2. **Resolve the trigger.**
   - *Manual:* nothing to resolve — there is no trigger to watch or time to
     compute. Skip straight to choosing the Then (the action it runs) and
     propose with `kind: "manual"`. No `eventName`, `tzid`, `rrule`, or `date`.
   - *Event from a third-party app* (Gmail, GitHub, Slack, Stripe, …): go through
     the connector chain — `connector_event_search` → `connector_event_schema` →
     *confirm with the guardian* → `connector_event_subscribe`. It finds the
     trigger, gets a yes before arming it upstream, and hands you the exact
     `eventName` to bind. See "Event routines from a connector".
   - *Event already flowing on the bus* (a Rome app's own event, or a connector
     event you set up before): call `search_event_catalog` with keywords from the
     request, then use the matching `eventType` as `eventName`. Never invent an
     event name.
   - *Schedule:* work out the cadence, the time of day, and the timezone from
     what they said; translate to an RRULE / one-off date behind the scenes.
3. **Fill the gaps with `ask_question`.** Underspecified requests are the
   norm ("important", "my landlord", "in the morning"). Ask one short,
   recognition-style question per gap: a `single`-type question with concrete
   options when you can name them (candidate senders; "8am / 9am / noon"), or a
   `text` question when the answer is open-ended. Never demand a raw value the user
   would have to look up, and never ask them for an RRULE or an IANA timezone —
   ask "what time?" and "roughly where are you?" and convert it yourself.
4. **Propose with `propose_routine`.** Pass `kind: "event"`, `kind: "schedule"`,
   or `kind: "manual"` plus the human summary and the machine spec. A confirm
   card renders; the guardian turns it on. For `manual`, set `watchLabel` to
   something like "Run on demand" and omit all trigger fields.
   **Add `activate: true`** when the guardian explicitly asked for this exact
   routine — they named the trigger or cadence, what to run and its arguments
   (e.g. "run `feedback-triage:check` every 12 hours") — so a second click adds
   nothing. Leave it off when you inferred any of those, or when the routine
   would send, post or spend on their behalf in a way they didn't ask for.
5. **Close.** After `propose_routine`, reply with one short line confirming what
   you drafted (or what is now on), then stop. Do not call any create action.

## Event routines from a connector (Gmail, GitHub, Slack, …)

Third-party events reach Rome through the **Connector** app (Composio). A
connector event only appears in `search_event_catalog` *after it has fired at
least once* — so for anything new you don't search the catalog, you **subscribe**.
Subscribing both tells you the canonical event name and arms the upstream trigger
so it starts firing. Three steps — and the third is an action you get the
guardian's explicit go-ahead for first, because it reaches out and starts
watching their third-party account:

1. **Find the trigger.** `connector_event_search({ toolkit, regex? })` lists the
   triggers a toolkit can emit as `{ slug, name, description }`. Use the toolkit
   the request implies (`gmail`, `github`, `slack`, `stripe`, …) and an optional
   case-insensitive `regex` to narrow (`"new.*message"`); omit it to see them all.
   Pick the slug whose meaning matches the intent — e.g. `GMAIL_NEW_GMAIL_MESSAGE`.
   Never invent a slug.
2. **Read its schema.** `connector_event_schema({ toolkit, slug })` returns
   `config` (the settings the subscribe needs), `payload` (the shape of the event
   it delivers — use it to pick `filter` field paths exactly, no guessing),
   `eventName` (the string the routine binds to), and `requiresWebhookEndpointSetup`.
   When `requiresWebhookEndpointSetup` is true (e.g. Slack, Notion), tell the
   guardian the trigger needs extra provider-side webhook setup and won't fire
   until that's done.
3. **Confirm, then subscribe.** Subscribing arms a real upstream subscription — it
   starts watching the third-party account immediately — so always get a yes first.
   Tell the guardian, in their terms, exactly what you're about to register ("I'll
   subscribe to GitHub's *new issue* event on `zhangfand/vps` so Rome starts
   watching it") and ask with `ask_question` (a `single` yes/no). **Only on a yes**
   call `connector_event_subscribe({ toolkit, slug, config })`, which arms the
   trigger and returns the `eventName` to bind. Pass `config` matching the schema
   from step 2 — `{}` when it needs none; for any required field you can't infer,
   ask the guardian recognition-style. It's idempotent, so re-subscribing the same
   trigger is safe. If the guardian declines, don't subscribe — offer a schedule
   routine if one fits, otherwise stop.

Then `propose_routine` with `eventName` set to exactly what subscribe returned.
(The confirmation above arms the *event source*; this card is a separate, lighter
step that turns the *routine* on — keep them distinct, don't collapse them.)

**Prerequisites — sign-in, *then* connection.** Subscribe needs Composio sign-in
*and* the toolkit connected. These are two separate gates, handled in order — a
connector action's error tells you which one you're on:

- **Not signed in** (error points to `connector_login`): call `connector_login`,
  which renders the account-wide sign-in card. Do **not** call `connector_connect`
  here — it refuses to render until sign-in succeeds, so you'd just bounce between
  errors.
- **Signed in but toolkit not connected** (error points to `connector_connect`):
  call `connector_connect({ toolkit })` to render the connect card.

After the guardian completes a card, resume the chain. Only when a toolkit
genuinely can't be connected do you stop and say the event isn't available (a
scheduled routine may still fit — offer it if so).

**Filters come from the payload.** `connector_event_schema.payload` describes the
event body, so set `filter` `{ field, equals }` paths from it directly rather than
guessing (`field` is a dot-path into that payload). When the guardian names a
person ("my landlord", "Dana") instead of a value, ask which contact they mean with
`ask_question` — a `single` over the values you know, or a `text` question when
unsure — and put the chosen value in the filter. If you can't find a fitting field
in the payload, prefer a broader routine (no filter) over one that silently never
matches.

## Event routines already on the bus

For a Rome app's own event, or a connector event you've already subscribed to,
`search_event_catalog({ query, limit? })` returns the best-matching watchable
types as `{ eventType, appId }` plus a `total` count. Search with words from the
request; if `total` exceeds what came back, search again with sharper keywords.
Use the **exact** `eventType` as `eventName`. (For a brand-new third-party event
this returns nothing — that's expected; go through the connector chain above.)

## Schedule routines — translating natural language

Map what they said to `tzid` (IANA), `localTime` (24-hour `HH:mm`), and either
`rrule` (recurring) or `date` (one-off `YYYY-MM-DD`). Keep all of that internal —
the card shows plain language like "Every Friday at 9:00 AM".

- "every day at 9am" → `localTime: "09:00"`, `rrule: "FREQ=DAILY"`
- "every Friday at 5pm" → `"17:00"`, `rrule: "FREQ=WEEKLY;BYDAY=FR"`
- "every weekday at 8am" → `"08:00"`, `rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"`
- "the 1st of every month at 9am" → `"09:00"`, `rrule: "FREQ=MONTHLY;BYMONTHDAY=1"`
  (MONTHLY always needs `BYMONTHDAY`)
- one-off "tomorrow at noon" → `localTime: "12:00"`, `date: "<that date>"`, no rrule

For the timezone: use the guardian's known timezone if you have it; otherwise
ask once in plain terms ("roughly where are you / what timezone?") and convert
(e.g. "Pacific" → `America/Los_Angeles`). Don't ask them to type an IANA name.

## Choosing the "Then" (action)

The trigger decides *when*; the `actionName` decides *what runs*. A routine can
only bind to an **action that already exists** — binding to one that isn't
registered is rejected at create time (the card won't turn on). So pick the Then
deliberately. Three choices, same for event and schedule routines:

- **Notify me** — pure delivery on a channel you know: `actionName:
  "system:send_message"`, args `{ "channel": "<telegram|webchat|...>", "threadId":
  "<id>", "text": "<message>" }`. Only when you actually know the channel + thread.
- **Summon** — a single judgement/writing pass over what the trigger hands you,
  where it's fine for the agent to work out the steps fresh each time:
  `actionName: "system:summon"`, args `{ "agentName": "core:main", "prompt": "<what to do
  when this fires>" }`. Good for "summarize the email that just arrived",
  "remind me to …", "decide and reply".
- **A workflow action** — a fixed multi-step job you'd want run the same way
  every fire (see the litmus). Bind to its canonical run action, `<appId>:run`.

### Summon or workflow? — the litmus

Default to **`system:summon`** when the Then is *one act of judgement or writing* over
what's already in front of the agent. Reach for a **workflow** when the Then has
a **fixed multi-step shape** you'd want to run identically each time:

- it **gathers then acts** — "review my emails and pick the critical ones",
  "pull my calendar and draft a plan" (fetch → judge/score → deliver);
- it **pulls from several sources and combines** them;
- it **fans out over a list** — "for each new lead, …";
- you'd otherwise be writing a `for`/`if` or several tool calls *inside* the
  summon prompt.

A summon re-improvises those steps on every fire (non-deterministic, no
parallel/branch/map, pricier and flakier); a workflow crystallizes them as a
deterministic DAG. So "every morning, review my emails and select the critical
ones" is a **workflow**, not a summon.

When the Then is a workflow and **no `<appId>:run` action exists yet, build it
first** with the **`coding:workflow_creation`** skill (it scaffolds the app and
registers `<appId>:run`), *then* come back and `propose_routine` bound to that
action. Don't propose the routine first — the create is rejected until the
action exists. If a fitting run action already exists, just bind to it.

## Example — event (connector)

Guardian: "Text me when I get an important email from my landlord."

1. Classify → event, third-party (Gmail). Make sure you're signed in and Gmail is
   connected; if a connector action says otherwise, handle the prereq it names
   (`connector_login`, then `connector_connect({ toolkit: "gmail" })`) and wait for
   the guardian to finish.
2. Discover + read the trigger:
   - `connector_event_search({ toolkit: "gmail", regex: "new.*message" })` → pick `GMAIL_NEW_GMAIL_MESSAGE`.
   - `connector_event_schema({ toolkit: "gmail", slug: "GMAIL_NEW_GMAIL_MESSAGE" })` → note the payload's sender field and the `eventName`.
3. Confirm, then subscribe:
   - `ask_question` (single yes/no): "I'll subscribe to Gmail's *new email* event so Rome can watch your inbox — set that up?"
   - On **yes** → `connector_event_subscribe({ toolkit: "gmail", slug: "GMAIL_NEW_GMAIL_MESSAGE", config: {} })` → returns `eventName: "provider:event:gmail.gmail_new_gmail_message"`.
4. `ask_question` — "Who's your landlord?" (a `single` over the addresses you know, or a `text` question if unsure);
   "What counts as important?" ("Anything from them" / "Only if it mentions rent").
5. After they pick `dana@example.com` and "anything from them" (filter field taken from the payload schema):

```
propose_routine({
  kind: "event",
  sentence: "When you get an email from Dana (your landlord), Rome will summarize it and text you.",
  name: "Landlord emails",
  watchLabel: "Gmail · new email",
  filterSummary: "sender is dana@example.com",
  thenSummary: "summarize it and text you",
  eventName: "provider:event:gmail.gmail_new_gmail_message",
  filter: [{ field: "from.email", equals: "dana@example.com" }],
  actionName: "system:summon",
  args: { agentName: "core:main", prompt: "A new email arrived from the guardian's landlord (dana@example.com). Read it and send the guardian a short summary." }
})
```

## Example — schedule

Guardian: "Remind me every Friday at 9am to send my weekly update."

1. Classify → schedule. Cadence weekly on Friday, 09:00; confirm timezone if unknown.
2. Propose:

```
propose_routine({
  kind: "schedule",
  sentence: "Every Friday at 9:00 AM, Rome will remind you to send your weekly update.",
  name: "Weekly update reminder",
  watchLabel: "Every Friday at 9:00 AM",
  thenSummary: "remind you to send your weekly update",
  tzid: "America/Los_Angeles",
  localTime: "09:00",
  rrule: "FREQ=WEEKLY;BYDAY=FR",
  actionName: "system:summon",
  args: { agentName: "core:main", prompt: "Remind the guardian to send their weekly update, in a short friendly message." }
})
```

## Example — manual

Guardian: "Put together my morning briefing, but don't schedule it — I want to
run it myself when I'm up."

1. Classify → manual (they explicitly don't want a time). No trigger to resolve.
2. Pick the Then like any routine (here a workflow or summon that builds the briefing).
3. Propose:

```
propose_routine({
  kind: "manual",
  sentence: "A morning briefing you can run by hand whenever you want it.",
  name: "Morning briefing",
  watchLabel: "Run on demand",
  thenSummary: "pull your day and send you a briefing",
  actionName: "system:summon",
  args: { agentName: "core:main", prompt: "Build the guardian's morning briefing — their day's calendar, anything urgent — and send it to them." }
})
```

Then reply with one short line confirming what you drafted, and stop.
