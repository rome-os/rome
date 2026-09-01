# The notification body is sender-supplied, and the no-secrets guarantee is behavioral, not structural

- **Status**: Accepted
- **Date**: 2026-08-11
- **Architecture**: [Notification delivery](../architecture/notification-delivery.md)

## Context

A push notification is how an [instance](../concepts/deployment.md#instances) reaches its guardian away from every open surface. The agent invokes a user-directed [action](../concepts/actions.md), the instance asks [Rome Cloud](../concepts/rome-cloud.md) to notify, and Rome Cloud fans out to the account's registered devices through their push providers (APNs on iOS, FCM on Android). The payload can render on the lock screen, the least-trusted display surface a phone has. iOS governs lock-screen visibility with the per-device Show Previews setting (Always, When Unlocked, Never), a system control no app owns.

The worth of a notification is its text. A fixed generic alert tells the guardian that something happened, never what — which task finished, which approval blocks, what input is needed. Under a fixed alert, every notification costs an app open to learn anything. The cue worth sending is a summary of one specific situation, and only the sending agent can write it.

The payload also outlives the send. Action arguments persist verbatim with the invocation under the normal execution-history semantics, so a body lands in the durable action record as well as on a lock screen. And a device binding survives logout until rebind or a provider dead-token signal (an APNs 410 or an FCM `UNREGISTERED`), so a stale binding keeps receiving whatever the payload carries.

A guarantee that no secret reaches those surfaces can be structural or behavioral. The structural form is the documented default inside Rome: the central push broker fixes the alert text so an instance cannot place content on a lock screen, which bounds what any payload — including one to a stale binding — leaks to presence, never content. The notify action held that line and turned back sender-supplied content pending a separate privacy design. A reader who meets the plaintext body re-proposes one of those postures — the contentless payload, a broker template, or a Rome-side preview control.

## Decision

A notification request may supply the body — free-form sender content that transits the push provider (APNs or FCM) and may appear on the lock screen — while the title stays fixed and Rome Cloud-owned and Rome Cloud stays the [single content-enforcement point](../architecture/notification-delivery.md#invariants). The guarantee that no secret reaches a lock screen or the execution record is behavioral — the sender writes an attention cue, never a secret — and lock-screen exposure belongs to the device's own lock-screen preview setting (iOS Show Previews, and Android's lock-screen notification controls), with no parallel Rome control.

## Alternatives

- **A fixed broker-generated alert, the broker's original design.** The payload carries no sender content, so non-sensitivity holds by construction. Rejected because a fixed alert carries presence, never content: the guardian learns that something needs attention but not what, so every notification still costs an app open, and the attention cue the notify action exists to deliver cannot exist under it.
- **Sender-influenced text through a broker-owned template, that design's own follow-up sketch.** Rejected because a template set enumerates categories in advance, and the cue is a summary of one specific situation that only the sending agent can write. A category line keeps the app-open cost of the fixed alert, so the template restores the structural guarantee without restoring the notification's worth.
- **A contentless payload the device resolves into content after delivery.** Keeps content off the push provider while showing a real cue. Rejected because on-device resolution is new machinery on both ends — a native resolution layer in the shell plus an authenticated device-side content fetch — while the sender-supplied body rides the existing notify path with no new endpoint or authentication mechanism.
- **A Rome-side preview preference over notification content.** Rejected because the device already hands the guardian a per-device control over exactly this exposure (iOS Show Previews, with Never as an option, and Android's equivalent lock-screen controls). A Rome toggle over the same exposure is a second switch on one policy, and the guardian then reasons about the pair instead of the one setting the device already honors.

## Consequences

The notification carries the agent's own summary, and the guardian triages from the lock screen without opening the app. The content link rides the path that already exists — the same action, the same worker RPC, the same broker endpoint — and Rome Cloud enforces normalization, the length cap, and fallback once, before device lookup and fan-out. A request that supplies no body still gets the default alert, so the zero-argument call keeps working.

Nothing structural keeps a secret out of the payload. The rule is behavioral, there is no runtime filter, and the guarantee is only as strong as the senders behind it. The body transits the push provider's infrastructure and persists verbatim in the execution record, so a secret placed in a body is exposed on a lock screen and retained in history at once. A stale device binding that survives logout receives content rather than presence alone. That widened exposure is why stale-binding lifecycle, caller-origin enforcement, rate limiting, and content safety are prerequisites to any rollout beyond a controlled environment.

Future diffs must respect:

- The body is the only sender-supplied field, and the title stays Rome Cloud-owned. A caller-supplied title, subtitle, or tap payload widens the sender surface and reopens this record.
- Every content path crosses Rome Cloud's single enforcement point before device lookup and fan-out. No send path bypasses it.
- No secrets in the body, and no body in operational logs. A diff may harden the rule with classification or redaction. No diff relaxes the logging rule or treats a disabled preview setting as license to carry a secret.
- Rome adds no parallel preview preference. Lock-screen exposure control stays with the device's own lock-screen preview setting (iOS Show Previews, and Android's equivalent).
- Enabling sender content beyond a controlled development environment picks up the prerequisites named above first: stale-binding lifecycle, caller-origin enforcement, rate limiting, and content safety.
