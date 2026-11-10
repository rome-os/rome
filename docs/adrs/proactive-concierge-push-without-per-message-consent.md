# Proactive Concierge messages push without per-message consent

- **Status**: Accepted, amended 2026-11-07 (replies push, but not in a chat the phone shows) and 2026-11-09 (every message pushes to the person the chat serves, unless their dashboard is active)
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

*2026-11-07.* A guardian who sends a message and locks the phone missed the reply: a turn the guardian started never pushed. Now the reply to the guardian's own message pushes its first message with an alert, under the same rules: once per turn, the Concierge's own words, quiet hours, the guardian's own chats. Only a message the guardian wrote, signed in, counts: a message said as an agent account or an automated source, and a loopback caller acting as the guardian, do not push. Nor do the reminder, the quota recovery and the "chat retired" notice.

No turn pushes while the guardian's phone app shows its chat. The phone marks its live-events socket with the `x-rome-client: phone` upgrade header and holds the `chat.watch:<chatId>` topic for the one chat on its screen. Only that watch counts: the phone also follows other chats' data (topic chat names, the main chat), and counting those would swallow their pushes while the app is open. This holds for proactive turns too: what the phone shows needs no push. The dashboard never counts, since a browser cannot set that header, so a guardian reading on a computer still gets the push on the phone. A message the phone shows does not use up the turn's push: if the guardian leaves the chat before the answer to an acknowledgement, the answer pushes. Such a later push says the fixed line, never that message's words, because the Concierge gives a secret in a later message. A socket holds one watch, outside its subscription cap, and the phone sends it first on connecting, so a phone that follows many chats still holds it. The phone moves the watch as the chat on screen changes, and says goodbye as it leaves the foreground: it drops the watch and closes the socket, and the count drops at once. A phone killed or cut off without the goodbye counts until the socket's ping drops it, and a reply in that window does not push. That gap is accepted. A reply's first message can now show on the lock screen too, so the Concierge is told to keep any secret, even one the guardian asked for, out of it and give it in a later message.

## Amendment: every message pushes to the person the chat serves, unless their dashboard is active

*2026-11-09.* Three problems. While the guardian chatted in the web dashboard, every reply also rang their phone a moment later, for a reply they had just read ([#1910](https://github.com/rome-os/rome/issues/1910)). A turn pushed only its first message, so the answer after an acknowledgement never reached a locked phone. And a visitor's Concierge never pushed, while a visitor's `send_notification` rang the guardian's phone with the visitor's text ([#1937](https://github.com/rome-os/rome/issues/1937)).

**Every message pushes.** Each message of a turn with a push level pushes, not only the first. In one chat, messages within 15 seconds of the chat's last push merge into one push, sent when those 15 seconds end and showing the latest message. A push rings only when the chat's last push is more than 2 minutes old. Otherwise it arrives silently. A digest stays silent. The reminder, the quota recovery and the "chat retired" notice still never push.

**The body.** A push shows the message's own words. Since every message can reach the lock screen, the Concierge marks a message that holds a secret as private (`say` with `private`), and a private message pushes the fixed line, as a forward with no intro and a card do. The Concierge is told this, and to send fewer filler messages, since each one can ring the phone.

**Recipients.** A push goes to the person the chat serves: the guardian for the guardian's chats, and a visitor for theirs. The instance names a visitor by their Rome Cloud account in the `/api/notify` request's `recipient`. With no `recipient`, the push is for the guardian, as before. Rome Cloud sends to the recipient only if they may use the instance. A Rome Cloud that does not know the field refuses the request, so a visitor's push never falls back to the guardian's devices, and the instance logs the outcome. The reply to a visitor's own message pushes, as the guardian's does. The guardian gets no push from a visitor's chats. `send_notification` pushes to the person who acted, the guardian or a visitor, whoever owns the chat: a visitor in a chat shared with the guardian or another visitor rings only themselves. Only a call no person made, such as a routine's, goes to the calling chat's owner, and with no chat to the guardian. A visitor's call never reaches the guardian.

**Holds, per person.** A person's push is held back while their phone app shows the chat, while one of their web dashboards on this instance is active, or in their own quiet hours. A hold is checked when the message is said and again when its push goes out: a message held when said is dropped, even if the hold ends before its merge window does. The phone's watch counts for the person signed in on the phone, the guardian or a visitor. A dashboard sends an `active` signal on its live-events socket on keyboard, pointer or touch input while its tab is visible and its window focused, at most once every 30 seconds, and counts as active for 1 minute after the last one. It sends `away` as the tab is hidden, the window loses focus or the page closes, and then counts as away at once. A socket that closes stops counting at once. An open tab alone counts for nothing, since it can stay open long after the person left. A dashboard page inside the phone app's web view never counts as a dashboard: it sends no signals, since closing that view may not fire `pagehide`, and the next push would be held back while the phone is locked. The guardian's activity holds back only the guardian's pushes, and a visitor's only that visitor's. While a dashboard is active, all of that person's pushes from the instance are held back, in every chat, digest included: the dashboard shows every chat's unread state. `send_notification` is never held back.

This replaces the 2026-11-07 rule that a guardian reading on a computer still gets the push: the dashboard's watch still never counts, and its activity does. A held-back message is dropped. Nothing queues it, and nothing pushes when the dashboard goes idle or the phone leaves the chat, but the chat's next message pushes. A person who walks away without the tab losing focus is still counted as present for up to 1 minute, and a message in that window does not push. That gap is accepted, as is the one for a phone cut off without its goodbye.

## Alternatives

- **Route proactive messages through `send_notification`.** Rejected because that action's rule is that the agent pushes only when asked, and a proactive message is exactly the one nobody asked for. Relaxing the rule for the Concierge would leave every other agent's push to the model's judgment, while the decision of when to push is a fact about the turn the instance already knows.
- **A per-guardian setting that turns proactive pushes on.** Rejected because the phone's notification permission is already that switch. A second switch on the instance would leave the guardian reasoning about two settings for one behavior, the failure the [notification body ADR](sender-supplied-notification-body-over-contentless-push.md) names for a preview toggle.
- **Push only important alerts.** Rejected because a task chat that finished or asks a question is as much news as a followed event, and the guardian wants the digest on the phone too. The digest arrives without an alert, which keeps its cost low.

## Amendment to the notification body record

This record amends [the notification body record](sender-supplied-notification-body-over-contentless-push.md), which holds that a caller-supplied tap payload reopens it. A request now also carries routing data that only the instance sets: `level`, whether the push alerts, and `chatId`, the chat a tap opens. Neither is shown, so the body stays the only content the guardian reads, and no agent input reaches either field. The instance also builds the body of these pushes itself, as a preview of the Concierge's own words. Rome Cloud stays the single place that enforces the body. The agent-facing action is unchanged: it supplies a body alone.

## Consequences

The guardian learns of a proactive message wherever they are, and taps it to open the chat it was said in. Nothing in the agent decides whether to push, so a model cannot forget the push or push a reply the guardian asked for.

A forwarded task answer can hold a one-time code, and the Concierge's instructions alone cannot keep it off the lock screen. A task's title and a chat's name can come from the same output. So a forward pushes the Concierge's intro, and a forward with no intro or a card pushes a fixed line, never the forwarded text, the title or the name. The Concierge is told that every message can show on the lock screen, and to mark one that holds a secret private, as `send_notification` tells its callers.

A message does not push while its person's phone app shows its chat or while they are active at a web dashboard. A dashboard merely open on a computer does not hold it back. A chat pushes at most once every 15 seconds, and rings at most once every 2 minutes. A proactive turn that writes its message outside `say` and is then reminded pushes nothing, since the reminder carries no push.

Future diffs must respect:

- The instance decides when a message pushes, from how its turn started, whether its person's phone shows the chat, whether that person is active at a web dashboard, and their quiet hours, never from the text of its input or output.
- Only the phone app's socket counts as watching, only through its `chat.watch:` topic, and only for the person signed in on it. A diff that lets a data subscription hold back a push reopens this record.
- A dashboard holds back a push only through its activity signals: recent input on a visible, focused tab, for the person signed in on it. A diff that lets an open tab alone, the phone app's web view, another person's dashboard, or a dashboard's chat or watch subscription hold back a push reopens this record. A push held back this way is dropped, never sent later.
- A Concierge push goes only to the person the chat serves, and a `send_notification` push to the person who acted. A visitor's Concierge, and a visitor's `send_notification`, never reach the guardian's devices, and the guardian's never reach a visitor's. A visitor's push names its recipient, and a Rome Cloud that cannot honor the name refuses it rather than sending it to the guardian.
- In one chat, messages within 15 seconds of the last push merge into one push showing the latest, and a push rings only after 2 minutes without one. A diff that pushes every message apart, or rings every push, reopens this record.
- The body is only ever the message's own words, or the fixed line for a private message, a forward with no intro, or a card.
- Quiet hours suppress the push and keep the message in the chat. Nothing queues the push for later.
- `send_notification` keeps its rule. The agent-facing action and this push stay separate paths.
- The push follows the [notification delivery invariants](../architecture/notification-delivery.md#invariants): the body is only ever the Concierge's own words, never forwarded or quoted text, and it never reaches a log.
