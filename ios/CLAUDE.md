# ios/

The native iOS app (SwiftUI, iOS 17). It is an Xcode project, not a pnpm workspace member, so `pnpm typecheck` and `pnpm test:unit` never touch it. Screens live in `Rome/Features`, the API client and wire models in `Rome/Networking`, sign-in in `Rome/Auth`, and design tokens in `Rome/Design`.

## Playbook

- Before building, testing or running the app, read [`README.md`](README.md); it covers the simulator, Mac Catalyst, demo data and a local Rome.
- Before designing or changing a screen, read [`DESIGN.md`](DESIGN.md), the interface principles every screen follows.
- Before changing the transcript, a list, a store or anything that runs while a chat streams, read [`PERFORMANCE.md`](PERFORMANCE.md), and measure the change with `ROME_PERF`.
- When changing a screen, run the snapshot pass in [`README.md`](README.md#snapshots) and look at both the light and dark images.
- When reading a new wire field, add it to `Rome/Networking/Models.swift` as optional, so an older server keeps decoding.
- When adding text, use `romeFont(_:_:)` from `Rome/Design/Typography.swift`, never `.font(.system(size:))`, so it scales with Dynamic Type.
- When adding a color, add a light and dark pair to `Palette` in `Rome/Design/Theme.swift`; the values come from the design boards.
- When you need the Simulator, boot it headless (`xcrun simctl boot`) and drive and watch it through the Claude app's Simulator panel; don't open Simulator.app (`open -a Simulator`), which pops a window over the user's desktop.
- When building, pass `-derivedDataPath` under `/tmp/rome-*`, as the `README.md` commands do, so a build never lands in `~/Library/Developer/Xcode/DerivedData` under a name nobody can trace back.
- When removing a worktree or archiving a worker, delete its `/tmp/rome-*` build folders and snapshot folders too, and shut down any simulator it booted (`xcrun simctl shutdown all`). Each build folder holds a few hundred MB. Keep `/tmp/rome-device` while the phone build is current, because a reinstall reuses it.
- When adding text, write it in English, following [`docs/ui/VOICE.md`](../docs/ui/VOICE.md), and add its Simplified Chinese to `Rome/Localizable.xcstrings`. `LocalizationTests` fails on a key without zh-Hans text. Build once, then run `xcrun xcstringstool sync` with the build's `.stringsdata` files to list new keys.
- When writing user-facing copy, call the main conversation Chat, never Concierge, in zh-Hans too (Chat, never Concierge or 管家). Code and type names keep Concierge.
- When changing `Rome/Info.plist`, change `Config/Info-Debug.plist` the same way. Debug builds read the second one, which adds plain HTTP to a local Rome; Release must stay HTTPS only.
- When reading the instance's API, rely on it staying backward compatible. The app works with any instance at or above `UpdateGate.minimumInstanceVersion`. Below it, the update page blocks. Above it, a newer release is only offered, through a banner and a drawer line. Raise the minimum only when the app starts calling an API that a newer release brought, to the first `v1.*` tag that has it.

## Traps

**A WebSocket from `URLSessionWebSocketTask` sends no `Origin`, and the server refuses a cookie session on the socket without one.** The REST calls still work, so the app looks fine but never receives a live event. `APIClient.socketRequest` sets `Origin` to the instance's own origin; keep it.

**The server never announces the guardian's own message on `chat.session:<id>`.** A pending bubble waits for a fetch, not an event. `TranscriptStore` marks it sent when the POST returns and reloads the newest page.

**A turn that fails in the middle leaves no reply, only its trace.** The instance stores a model error as a reply (an `error` part) only when the model could not be resolved before the turn ran. A failure after that (a provider limit, a crash) is in the trace message's `turnStatus: "error"` and `terminalError`. `TranscriptBuilder` draws a line from the trace unless a stored error part has the same turn, so a failure never shows twice and never shows nothing.

**A task's question or approval in the Chat is drawn from its part's `card`, never from the task chat.** The instance fills `card` into every `task_chat` part that shows one, each time it hands the message out, and `chat_card_settled` replaces it live (`TaskAskCard`). A part with no `card` (an older instance) draws as one quiet "no longer available" line; there is no paging fallback. A card takes an answer only when it is the task's newest, has no outcome, and `ConciergeTask.waitId` names it with the task `needs_you` (`TaskAskMode`).

**A stored `approval_card` part always says `pending`.** Only `GET /approvals/:id` knows whether it was answered, so a card shows its buttons only after that record arrives.

**Pushing a second task chat over the first reuses the same view.** Its `@State` store keeps the first chat. The route destination sets `.id(chatId)`.

**A literal reaches the catalog only where Swift types it as `LocalizedStringKey` or `String(localized:)`.** `Text("Done")` is looked up; `Text(flag ? "Running" : tone.label)` is a `String` and shows as written, and so does a literal passed to a `String` parameter. Give a view's text parameters the type `LocalizedStringKey`, and wrap literals headed for a `String` in `String(localized:)`.

**A view at the end of a `LazyVStack` is not proof that the bottom is on screen.** The stack keeps it alive while it is off screen, so its `onAppear` and `onDisappear` lag behind the scroll, and a list that trusts them pulls the guardian back to the bottom. `TranscriptList` reads the scroll phase and `onScrollVisibilityChange` instead, and before iOS 18 the marker's frame against the visible area.

**Message times are whole seconds.** Rows written in the same second tie, so sorting by time alone gives a random order that can change on each load. `TranscriptStore` orders rows the way the server does: by turn, then time, then the order they arrived.

**Two `onGeometryChange` readings of the same type on one view do not both fire.** The second never ran in `TranscriptList`. Read both values in one closure.

**Mac Catalyst runs the app but cannot capture a system sheet.** Snapshot runs draw the Tasks sheet in a stand-in frame; the sheet on a phone is the system one.

**The async forms of `UNUserNotificationCenterDelegate` crash the app when a notification is tapped.** Under Swift 6 the generated thunk returns UIKit's completion off the main thread, and UIKit aborts in `_performBlockAfterCATransactionCommitSynchronizes`. A banner in the foreground still works, so the crash shows only on a tap. `AppDelegate` implements the completion-handler forms on the main actor.

**A simulated push is opened from Notification Center with a swipe to the right, not a tap.** On the simulator a tap on the lock-style list only expands the stack. Pull Notification Center down from the top edge, then swipe the notification right.

**A screen that waits for the live socket to say it is back stays stale when the socket never comes back.** After a return to the foreground the socket may be slow, refused, or a leftover that looks open and delivers nothing; SwiftUI's scene phase may not even report the trip. `AppDelegate` reads UIKit's lifecycle notifications, `ForegroundGate` decides (any background trip, or a second inactive), and `LiveEventsSocket.resume()` asks listeners to refetch right away and rebuilds the socket whether or not it was paused. Stores share one reload per burst of requests (`resync()`).

**The swipe home starts on the transcript and reads as a drag away from the bottom.** So does Notification Center pulled down over the app. Rows refetched on return then land below the screen, which looks like a stale chat. `TranscriptList` goes by whether the bottom was on screen when the app resigned active, and a tapped push always shows the newest rows.

**A fling's glide wins over `ScrollViewReader.scrollTo`.** The tap reaches the button and `scrollTo` runs, but the list keeps decelerating the other way, so a tap mid-glide seems to do nothing. A Simulator tap after a slow drag does not show it; a real fling does. `ScrollHandle` stops the `UIScrollView`'s deceleration before scrolling, and older pages wait until the jump lands, because content that grows under the scroll animation moves its target.

**A page that stays mounted keeps its animations running.** Chat stays in the tree, faded out, under the other sections, and a `TimelineView(.animation)` draws every frame there for no one. Pass `paused: offScreen`; see [`PERFORMANCE.md`](PERFORMANCE.md).

**A system switch ignores the Simulator panel's `tap`.** The tap has no duration, and a `Toggle` waits for a touch that lasts. Use `touch_path` with two samples at the same point about 120 ms apart; the simulator log (`xcrun simctl spawn booted log show`) tells whether the app received anything.
