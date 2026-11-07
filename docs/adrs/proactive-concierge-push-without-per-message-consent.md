# Proactive Concierge messages push without per-message consent

- **Status**: Accepted, amended 2026-11-07 (replies push, but not in a chat the phone shows)
- **Date**: 2026-11-06
- **Architecture**: [Notification delivery](../architecture/notification-delivery.md)
- **Amends**: [The notification body is sender-supplied](sender-supplied-notification-body-over-contentless-push.md)

## Context

The [Concierge](../architecture/concierge.md) speaks without being asked: it tells the guardian of an important event it [follows](../architecture/concierge-following.md), reports a task chat that finished or needs them, and sends the digest at its digest times. Each such message lands in a Concierge chat, which the guardian sees only while a Rome surface is open. The guardian wants every one of them on their phone as a push.

The agent-facing `send_notification` action already pushes, and its rule is consent per message: the agent calls it only when the guardian asks for a notification. Under that rule a proactive message never pushes, since nobody asked for that message.

A push costs attention. A digest is expected at its time, while an important alert is not. Quiet hours already hold important turns, and the guardian set them through the Concierge. The phone has its own consent step: a device receives push only after the guardian allows notifications in the app and the device registers with [Rome Cloud](../concepts/rome-cloud.md).

## Decision

The instance pushes the first message of every Concierge turn the guardian did not start — a task event, a followed event, a digest — with no consent per message. Consent is the guardian allowing notifications on the phone. A digest pushes without an alert, every other proactive turn with one, and nothing pushes in quiet hours. The reminder turn after a turn never pushes.

## Amendment: replies push, unless the phone shows the chat

*2026-11-07.* A guardian who sends a message and locks the phone missed the reply: a turn the guardian started never pushed. Now the reply to the guardian's own message pushes its first message with an alert, under the same rules: once per turn, the Concierge's own words, quiet hours, the guardian's own chats. The reply to an automated sender does not push, nor do the reminder, the quota recovery and the "chat retired" notice.

No turn pushes while the guardian's phone app shows its chat. The phone marks its live-events socket with the `x-rome-client: phone` upgrade header and holds the `chat.watch:<chatId>` topic for the one chat on its screen. Only that watch counts: the phone also follows other chats' data (topic chat names, the main chat), and counting those would swallow their pushes while the app is open. This holds for proactive turns too: what the phone shows needs no push. The dashboard never counts, since a browser cannot set that header, so a guardian reading on a computer still gets the push on the phone. The phone moves the watch as the chat on screen changes, and says goodbye as it leaves the foreground: it drops the watch and closes the socket, and the count drops at once. A phone killed or cut off without the goodbye counts until the socket's ping drops it, and a reply in that window does not push. That gap is accepted. A reply's first message can now show on the lock screen too, so the Concierge is told to keep any secret, even one the guardian asked for, out of it and give it in a later message.

## Alternatives

- **Route proactive messages through `send_notification`.** Rejected because that action's rule is that the agent pushes only when asked, and a proactive message is exactly the one nobody asked for. Relaxing the rule for the Concierge would leave every other agent's push to the model's judgment, while the decision of when to push is a fact about the turn the instance already knows.
- **A per-guardian setting that turns proactive pushes on.** Rejected because the phone's notification permission is already that switch. A second switch on the instance would leave the guardian reasoning about two settings for one behavior, the failure the [notification body ADR](sender-supplied-notification-body-over-contentless-push.md) names for a preview toggle.
- **Push only important alerts.** Rejected because a task chat that finished or asks a question is as much news as a followed event, and the guardian wants the digest on the phone too. The digest arrives without an alert, which keeps its cost low.

## Amendment to the notification body record

This record amends [the notification body record](sender-supplied-notification-body-over-contentless-push.md), which holds that a caller-supplied tap payload reopens it. A request now also carries routing data that only the instance sets: `level`, whether the push alerts, and `chatId`, the chat a tap opens. Neither is shown, so the body stays the only content the guardian reads, and no agent input reaches either field. The instance also builds the body of these pushes itself, as a preview of the Concierge's own words. Rome Cloud stays the single place that enforces the body. The agent-facing action is unchanged: it supplies a body alone.

## Consequences

The guardian learns of a proactive message wherever they are, and taps it to open the chat it was said in. Nothing in the agent decides whether to push, so a model cannot forget the push or push a reply the guardian asked for.

A forwarded task answer can hold a one-time code, and the Concierge's instructions alone cannot keep it off the lock screen. A task's title and a chat's name can come from the same output. So a forward pushes the Concierge's intro, and a forward with no intro or a card pushes a fixed line, never the forwarded text, the title or the name. The Concierge is told that its first message in such a turn can show on the lock screen, as `send_notification` tells its callers.

A turn pushes even when the guardian has the chat open on a computer, but not while the phone app shows it. One turn pushes once, however many messages it says. A proactive turn that writes its message outside `say` and is then reminded pushes nothing, since the reminder carries no push.

Future diffs must respect:

- The instance decides when a turn pushes, from how the turn started and whether the phone shows the chat, never from the text of its input or output.
- Only the phone app's socket counts as watching, only through its `chat.watch:` topic, and only while it is signed in as the guardian. A diff that lets the dashboard, or a data subscription, hold back a push reopens this record.
- Only the guardian's own Concierge pushes. A visitor's Concierge chats are private to the visitor, and the push reaches the guardian's devices.
- One push per turn, the turn's first message. A diff that pushes each message reopens this record.
- Quiet hours suppress the push and keep the message in the chat. Nothing queues the push for later.
- `send_notification` keeps its rule. The agent-facing action and this push stay separate paths.
- The push follows the [notification delivery invariants](../architecture/notification-delivery.md#invariants): the body is only ever the Concierge's own words, never forwarded or quoted text, and it never reaches a log.
