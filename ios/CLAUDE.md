# ios/

The native iOS app (SwiftUI, iOS 17). It is an Xcode project, not a pnpm workspace member, so `pnpm typecheck` and `pnpm test:unit` never touch it. Screens live in `Rome/Features`, the API client and wire models in `Rome/Networking`, sign-in in `Rome/Auth`, and design tokens in `Rome/Design`.

## Playbook

- Before building, testing or running the app, read [`README.md`](README.md); it covers the simulator, Mac Catalyst, demo data and a local Rome.
- When changing a screen, run the snapshot pass in [`README.md`](README.md#snapshots) and look at both the light and dark images.
- When reading a new wire field, add it to `Rome/Networking/Models.swift` as optional, so an older server keeps decoding.
- When adding text, use `romeFont(_:_:)` from `Rome/Design/Typography.swift`, never `.font(.system(size:))`, so it scales with Dynamic Type.
- When adding a color, add a light and dark pair to `Palette` in `Rome/Design/Theme.swift`; the values come from the design boards.

## Traps

**A WebSocket from `URLSessionWebSocketTask` sends no `Origin`, and the server refuses a cookie session on the socket without one.** The REST calls still work, so the app looks fine but never receives a live event. `APIClient.socketRequest` sets `Origin` to the instance's own origin; keep it.

**The server never announces the guardian's own message on `chat.session:<id>`.** A pending bubble waits for a fetch, not an event. `TranscriptStore` marks it sent when the POST returns and reloads the newest page.

**A stored `approval_card` part always says `pending`.** Only `GET /approvals/:id` knows whether it was answered, so a card shows its buttons only after that record arrives.

**Pushing a second task chat over the first reuses the same view.** Its `@State` store keeps the first chat. The route destination sets `.id(chatId)`.

**Mac Catalyst runs the app but cannot capture a system sheet.** Snapshot runs draw the Tasks sheet in a stand-in frame; the sheet on a phone is the system one.
