# Concierge recovers from provider failures without asking

- **Status**: Accepted
- **Date**: 2026-11-05

## Context

Each [Concierge chat](../domains/chats.md#concierge-chat), the main chat or a topic chat, is long-lived and delegates work to task chats. Its stored messages and task list let a replacement provider thread recover the work. A provider failure need not strand that chat, but an automatic move must remain visible.

## Decision

Only a Concierge chat, the main chat or a topic chat, retries or changes models automatically after a recognized subscription-provider failure. Every move records a visible notice, and the recovery prompt requires a check before an action repeats.

## Alternatives

- **Mark every failure globally.** Rejected because that changes model availability for routines and other chats.
- **Switch immediately on temporary failures.** Rejected because these failures are common and short. One delayed retry keeps the thread.
- **Try the other provider first for a single-model limit.** Rejected because a same-provider model change keeps the thread.
- **Switch back automatically.** Rejected because that discards a working thread again. The guardian can switch by hand.

## Consequences

Rate limits, overload, server errors and network failures get one retry after about 30 seconds on the same model and thread. A single-model limit or capacity failure tries another model on the same provider first. If either recovery fails on a recognized provider error, Rome can move to the other subscription once. A chain runs at most two automated turns.

Quota, spend limits and sign-in failures move directly to the other eligible subscription. Concierge treats `You've hit your limit` as a provider quota failure. If the other provider is unavailable, that wording can try another model on the same provider. Concierge's extra word matches do not change global quota state.

Context limits, invalid requests, output limits, refusals, interruptions, shutdowns, structured-output failures, turn limits and unknown errors never trigger recovery. Neither does an API-key source or an API-key balance error. A target must be signed in, have quota, need no reauthentication and use a subscription, not an API key or Rome credits.

A move cannot return to a model the same chat left automatically within ten minutes. Concierge never switches back merely because availability returns. Its manual model menu remains available when the product model selector is off. A turn that finishes during a retry wait neither cancels the retry nor starts another recovery chain. The retry checks history before doing any work.

Future diffs must respect:

- Ordinary chats, task chats, routines, summons, side chats, handoffs and subagents still fail closed.
- Every automatic move records its reason independently of the agent speaking. A retry alone records no switch notice.
- A same-provider move or retry keeps the thread once a turn on it has succeeded. A thread whose first turn failed is not on record yet, so its recovery starts a new thread and reads the chat's stored messages. A cross-provider move loses the thread, not Rome's transcript, and carries a continuation notice.
- Avoiding repeated work relies on the recovery prompt. It requires history and task-list reads, verification, and a guardian question before an unconfirmed side effect repeats.
- This exception and an explicit guardian selection are the only inputs that move an existing session to another model.
