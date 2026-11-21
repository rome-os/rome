# A followed chat's digest goes to that chat

- **Status**: Accepted
- **Date**: 2026-11-11
- **Supersedes**: the digest decision of [One Concierge with several chats](one-concierge-with-several-chats.md)

## Context

Each follow reports to one [Concierge chat](../domains/chats.md#concierge-chat), and its important alerts already go there. The digest of the same follows went to the main chat, grouped by chat. A guardian who opens a topic chat to keep one topic apart still finds that topic's items in the main chat, and the topic chat never shows a summary of what it follows. The chat a follow reports to is the setting that says where its items belong.

The first decision rejected a digest in every chat, because a topic chat the guardian does not open would hide its items.

## Decision

Each Concierge chat gets the digest of its own follows, as one quiet turn that lists only its items. A chat with nothing new gets no digest, except that the main chat gets an empty one when nothing is new anywhere. A chat that is archived or gone hands its items to the main chat.

## Alternatives

- **The main chat only, grouped by chat.** Rejected because it keeps topics mixed in the one chat the guardian opened topic chats to keep them out of, and the follow's chat would decide where its alerts go but not its digest.
- **A digest in every chat, an empty one included.** Rejected because a topic chat with nothing new would get a message at every digest time, which is the noise topic chats exist to avoid.
- **Each chat's digest plus a line in the main chat about the topic chats.** Rejected because the main chat would mention every topic again, if only in one line each.

## Consequences

A topic chat the guardian does not open keeps its digest unread. The follow list names the chat of each follow, and each digest pushes to the phone without an alert, so the guardian can tell where an item went.

Future diffs must respect:

- A digest item goes to the chat its follow reports to, or to the main chat when that chat is archived or gone.
- A digest turn lists the items of one chat and groups them by nothing else.
- A chat's items are marked delivered only after that chat's own digest turn ran to its end. A failed turn leaves its items owed and does not hold back another chat's.
- Only the main chat gets an empty digest.

The delivery invariants live in [Concierge following](../architecture/concierge-following.md).
