# One Concierge with several chats, not several Concierges

- **Status**: Accepted
- **Date**: 2026-11-05

## Context

The guardian wants Concierge topics, such as the calendar or one project, to live apart from the main Concierge chat, so recurring alerts on one topic do not flood the rest.

The Concierge triages followed events once per batch with a small model, stores what it owes the digest keyed by event, and arms one subscription at the source per followed thing. Its memory is the instance's one memory, and its digest times and quiet hours are one setting. A dashboard visitor on the allow-list already reads and edits that memory, those settings and every chat, so nothing inside one Rome is private from a visitor today.

Products in the same space split two ways. Muse, Claude Duet and Dots run one assistant with shared memory over several chats or channels. Grok Bot runs several bots, each with one job and its own memory. Muse's users name three failures of its model: they forget which task reports where, nothing from a side chat reaches the main chat, and archiving or deleting a side chat leaves its tasks in an unclear place.

The first plan for this feature was several independent Concierges, each with its own follows, triage, digest and settings.

## Decision

Rome has one Concierge per owner, with a main chat and any number of topic chats. Memory, follows, tasks, digest times and quiet hours are shared. Each chat has its own transcript and agent session, and the Concierge reads another of its chats only when a question needs it. Each follow sends its alerts to exactly one chat. The digest goes to the main chat, grouped by chat.

## Alternatives

- **Several independent Concierges.** Rejected because the same event would be triaged once per Concierge, the follow items and subscription release would need counting per Concierge, and one event could be told twice. The isolation it offers does not exist inside one Rome, where memory and settings are shared with every dashboard user anyway.
- **Threads inside the one Concierge chat.** Rejected because a thread is seen from its parent chat and its messages are the parent's, so the main chat would still carry every topic. The guardian wants separate transcripts.
- **Side chats, the dashboard's forks from a turn.** Rejected because a fork copies history up to a turn and belongs to its source, while a Concierge chat starts empty and stands on its own. One word would carry two meanings.
- **Following the same thing from two chats.** Rejected because each event would then be triaged and deduplicated per chat, and "stop following Gmail" would need to ask which follow. Splitting by target or kind covers the real cases: one repository here, another there.
- **One follow sending to several chats.** Deferred, not rejected: Muse supports it and reports almost no use, and the main-chat digest already shows every chat's items. A list of chats in place of one chat changes neither triage nor dedupe.
- **A digest in every chat.** Rejected because a topic chat the guardian does not open would hide its items, the failure Muse's users report. The main chat is the one overview.
- **An owner column on follows and tasks.** Rejected because the owner already lives on the chat, and a second copy could disagree with it. Follow items are the one exception: each keeps its owner so that a stored event is unique per owner, as [a Concierge for each person](a-concierge-for-each-person.md) needs.

## Consequences

Adding a chat adds no triage, no subscription and no dedupe work. The guardian sees every alert's chat in the follow list, and the digest catches what a chat they did not open received.

Future diffs must respect:

- Triage runs once per batch for each owner, whatever number of chats that owner has.
- A follow has one chat. Its alerts go there, or to the main chat when that chat is archived or gone.
- Archiving or deleting a Concierge chat moves its follows and unfinished tasks to the main chat and says so there. The main chat cannot be archived or deleted.
- Only a chat records its owner. Follows and tasks reach their owner through their chat, and no owner means the guardian.
- A rule for "the Concierge chat" applies to every Concierge chat, unless it names the main chat.

The delivery invariants live in [Concierge following](../architecture/concierge-following.md).
