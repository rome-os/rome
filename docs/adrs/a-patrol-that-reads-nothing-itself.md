# The patrol reads nothing itself, and code decides when it may speak

- **Status**: Accepted
- **Date**: 2026-11-23
- **Architecture**: [Concierge patrol](../architecture/concierge-patrol.md)

## Context

The guardian asked for a Concierge that notices things on its own and tells them, with restraint: every proactive message must earn its place, and silence is the default. Products that tried this show two ways to fail. A model that guesses what the guardian cares about sends too much and follows up on interests the person does not have. An assistant that reads everything with tools can be steered by what it reads, as when a pushed message or an invite tells it to act. Research on proactive agents finds models raise false alarms on half or more of their proposals, and small models do worse.

The patrol reads personal data, other people's text in calendar invites and mail lines, and the guardian's own chat. Whatever it can call, text in that data can ask it to call.

## Decision

The patrol agent holds no tools and no actions: code gathers everything it reads into its prompt, and Rome refuses to run it with a definition that holds anything. Code, not the model, decides when it may speak at all and whether what it chose may be said: quiet hours, digest times, the daily cap of three proactive messages shared with alerts and digests, the cooldown of a topic, and a pre-check with no model before every run. The model only judges what matters.

## Alternatives

- **Give the patrol read tools, such as `chat_read` and `personal_data_query`, and tell it not to write.** Rejected because read-only would then rest on the prompt, and a prompt is what injected text overrides. It also lets one run read without bound.
- **Let the model decide timing and repetition from the ledger alone.** Rejected because a model asked whether to speak says yes too often, and a rule it may break is no cap. The model still reads the ledger, so it stays silent on what was told, and code holds it to the rule when it does not.
- **Gate alerts and digests by the same daily cap.** Rejected because the digest's times and the alerts' hourly cap are rules the guardian already relies on, and the patrol must not change them. The cap counts their messages and holds only the patrol.
- **Run the patrol on a small model, as triage does.** Rejected because small models raise far more false alarms on proactive proposals, and the pre-check already stops most runs before any model.
- **An internal timer in place of a routine.** Rejected because the guardian wants to see the patrol in the routine list and pause it there.

## Consequences

- A new source for the patrol is a change to the code that gathers its input, reviewed for its tier: understanding only, speakable, or speakable with its source named. The agent never reaches it on its own.
- What the patrol can say is bounded by what code lets through: an open, observed observation of a speakable source, outside its cooldown, with a message left today. A prompt change cannot widen it.
- The patrol cannot look deeper into something it notices within a run. It sets its own wake-up instead, or notices it again on the next run.
- What the patrol writes never becomes another agent's instructions. It may only ask the Concierge to offer a task, and the Concierge writes that task's brief from what the guardian saw on the card.
- A future change that lets the patrol start tasks, or act at all, needs a new decision: this one holds only while it acts through the Concierge's single message.
