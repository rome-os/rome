# ios/

The native iOS app (SwiftUI, iOS 17). It is an Xcode project, not a pnpm workspace member, so `pnpm typecheck` and `pnpm test:unit` never touch it. Screens live in `Rome/Features`, the API client and wire models in `Rome/Networking`, sign-in in `Rome/Auth`, and design tokens in `Rome/Design`.

## Playbook

- Before building, testing or running the app, read [`README.md`](README.md); it covers the simulator, Mac Catalyst, demo data and a local Rome.
- When changing a screen, run the snapshot pass in [`README.md`](README.md#snapshots) and look at both the light and dark images.
- When reading a new wire field, add it to `Rome/Networking/Models.swift` as optional, so an older server keeps decoding.
- When adding text, use `romeFont(_:_:)` from `Rome/Design/Typography.swift`, never `.font(.system(size:))`, so it scales with Dynamic Type.
- When adding a color, add a light and dark pair to `Palette` in `Rome/Design/Theme.swift`; the values come from the design boards.
- When building, pass `-derivedDataPath` under `/tmp/rome-*`, as the `README.md` commands do, so a build never lands in `~/Library/Developer/Xcode/DerivedData` under a name nobody can trace back.
- When removing a worktree or archiving a worker, delete its `/tmp/rome-*` build folders and snapshot folders too, and shut down any simulator it booted (`xcrun simctl shutdown all`). Each build folder holds a few hundred MB. Keep `/tmp/rome-device` while the phone build is current, because a reinstall reuses it.
- When adding text, write it in English, following [`docs/ui/VOICE.md`](../docs/ui/VOICE.md), and add its Simplified Chinese to `Rome/Localizable.xcstrings`. `LocalizationTests` fails on a key without zh-Hans text. Build once, then run `xcrun xcstringstool sync` with the build's `.stringsdata` files to list new keys.

## Traps

**A WebSocket from `URLSessionWebSocketTask` sends no `Origin`, and the server refuses a cookie session on the socket without one.** The REST calls still work, so the app looks fine but never receives a live event. `APIClient.socketRequest` sets `Origin` to the instance's own origin; keep it.

**The server never announces the guardian's own message on `chat.session:<id>`.** A pending bubble waits for a fetch, not an event. `TranscriptStore` marks it sent when the POST returns and reloads the newest page.

**A stored `approval_card` part always says `pending`.** Only `GET /approvals/:id` knows whether it was answered, so a card shows its buttons only after that record arrives.

**Pushing a second task chat over the first reuses the same view.** Its `@State` store keeps the first chat. The route destination sets `.id(chatId)`.

**A literal reaches the catalog only where Swift types it as `LocalizedStringKey` or `String(localized:)`.** `Text("Done")` is looked up; `Text(flag ? "Running" : tone.label)` is a `String` and shows as written, and so does a literal passed to a `String` parameter. Give a view's text parameters the type `LocalizedStringKey`, and wrap literals headed for a `String` in `String(localized:)`.

**A view at the end of a `LazyVStack` is not proof that the bottom is on screen.** The stack keeps it alive while it is off screen, so its `onAppear` and `onDisappear` lag behind the scroll, and a list that trusts them pulls the guardian back to the bottom. `TranscriptList` reads the scroll phase and `onScrollVisibilityChange` instead, and before iOS 18 the marker's frame against the visible area.

**Message times are whole seconds.** Rows written in the same second tie, so sorting by time alone gives a random order that can change on each load. `TranscriptStore` orders rows the way the server does: by turn, then time, then the order they arrived.

**Two `onGeometryChange` readings of the same type on one view do not both fire.** The second never ran in `TranscriptList`. Read both values in one closure.

**Mac Catalyst runs the app but cannot capture a system sheet.** Snapshot runs draw the Tasks sheet in a stand-in frame; the sheet on a phone is the system one.
