# Proactive Concierge messages push without per-message consent

- **Status**: Accepted
- **Date**: 2026-11-06
- **Architecture**: [Notification delivery](../architecture/notification-delivery.md)

## Context

The [Concierge](../architecture/concierge.md) speaks without being asked: it tells the guardian of an important event it [follows](../architecture/concierge-following.md), reports a task chat that finished or needs them, and sends the digest at its digest times. Each such message lands in a Concierge chat, which the guardian sees only while a Rome surface is open. The guardian wants every one of them on their phone as a push.

The agent-facing `send_notification` action already pushes, and its rule is consent per message: the agent calls it only when the guardian asks for a notification. Under that rule a proactive message never pushes, since nobody asked for that message.

A push costs attention. A digest is expected at its time, while an important alert is not. Quiet hours already hold important turns, and the guardian set them through the Concierge. The phone has its own consent step: a device receives push only after the guardian allows notifications in the app and the device registers with [Rome Cloud](../concepts/rome-cloud.md).

## Decision

The instance pushes the first message of every Concierge turn the guardian did not start — a task event, a followed event, a digest — with no consent per message. Consent is the guardian allowing notifications on the phone. A digest pushes without an alert, every other proactive turn with one, and nothing pushes in quiet hours. A turn the guardian started never pushes, and neither does the reminder turn after it.

## Alternatives

- **Route proactive messages through `send_notification`.** Rejected because that action's rule is that the agent pushes only when asked, and a proactive message is exactly the one nobody asked for. Relaxing the rule for the Concierge would leave every other agent's push to the model's judgment, while the decision of when to push is a fact about the turn the instance already knows.
- **A per-guardian setting that turns proactive pushes on.** Rejected because the phone's notification permission is already that switch. A second switch on the instance would leave the guardian reasoning about two settings for one behavior, the failure the [notification body ADR](sender-supplied-notification-body-over-contentless-push.md) names for a preview toggle.
- **Push only important alerts.** Rejected because a task chat that finished or asks a question is as much news as a followed event, and the guardian wants the digest on the phone too. The digest arrives without an alert, which keeps its cost low.

## Consequences

The guardian learns of a proactive message wherever they are, and taps it to open the chat it was said in. Nothing in the agent decides whether to push, so a model cannot forget the push or push a reply the guardian asked for.

A forwarded task answer can hold a one-time code, and the Concierge's instructions alone cannot keep it off the lock screen, so a forward or a card pushes the Concierge's intro or the task's title instead of the forwarded text. The Concierge is told that its first message in such a turn can show on the lock screen, as `send_notification` tells its callers.

A turn the guardian did not start pushes even when the guardian has the chat open. One turn pushes once, however many messages it says. A proactive turn that writes its message outside `say` and is then reminded pushes nothing, since the reminder carries no push.

Future diffs must respect:

- The instance decides when a turn pushes, from how the turn started, never from the text of its input or output.
- One push per turn, the turn's first message. A diff that pushes each message reopens this record.
- Quiet hours suppress the push and keep the message in the chat. Nothing queues the push for later.
- `send_notification` keeps its rule. The agent-facing action and this push stay separate paths.
- The push follows the [notification delivery invariants](../architecture/notification-delivery.md#invariants): the body is only ever the Concierge's own words, never forwarded or quoted text, and it never reaches a log.
