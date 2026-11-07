# A small model triages followed events, and the Concierge decides what to say

- **Status**: Accepted
- **Date**: 2026-11-04
- **Architecture**: [Concierge following](../architecture/concierge-following.md)

## Context

A followed service sends far more events than the guardian wants to hear about. A busy repository sends dozens of pushes and checks an hour, and an inbox gets newsletters, receipts and mail from people. Which of them matter depends on the guardian: a CI failure on their own pull request matters, a bot's comment does not, and "only PRs that touch billing" cannot be written as a field.

The common practice is a rule filter: drop mail not addressed to the guardian, drop bots, keep a fixed list of kinds. The first version did that. In one night 47 mails arrived and the filter dropped all of them, so the guardian heard nothing and could not see why.

The Concierge runs one long conversation on a large model. A turn per event would cost a large-model run each time, fill the conversation, and leave the Concierge to sort the same noise every time.

## Decision

The connection drops only spam, trash, kinds the follow has off and repeats. A small model with no tools reads each batch of events with the follow's preference in the guardian's words and what was told recently, and marks each event important, digest or ignore. Important items reach the Concierge in a quiet turn, and it decides whether to tell the guardian now. Every important and digest item also goes into the next digest.

## Alternatives

- **Filter with rules in the connection or core.** Rejected because rules cannot hold a preference in the guardian's words, and a wrong rule drops events silently, as it dropped every mail for a night.
- **Give every event to the Concierge.** Rejected because each event would cost a large-model turn and a place in the conversation, and the guardian's chat would fill with noise the Concierge then has to stay silent about.
- **Let triage decide delivery and post the message itself.** Rejected because the chat would then have two speakers, and the Concierge would not know what had been told. The Concierge already knows the conversation, so it decides what is worth saying now.
- **Let triage decide alone, with no digest for what the Concierge left untold.** Rejected because an important item the Concierge chose not to tell would then never reach the guardian. The digest lists every kept item, so a silent turn loses nothing.
- **Rate-limit and dedupe in the routine engine for every consumer.** Rejected for now because no other consumer needs it. Batching and the hourly cap stay inside following until a second consumer does.

## Consequences

The guardian states what they want in chat, and triage reads it as written. A dropped event is logged with the reason triage gave, so "why did it not tell me?" has an answer.

Every batch costs one small-model run, at most one per batch window. Every important batch costs one Concierge turn, capped per hour. When triage fails, its events go to the digest rather than being dropped.

Future diffs must respect:

- No rule in the connection or core decides whether an event matters.
- Every message to the guardian is a Concierge turn.
- Every important and digest item reaches a digest, whether or not the Concierge told it.
