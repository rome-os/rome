# Mobile App MVP: push notifications

Worker result for "Push notifications" in [`mobile-app-mvp.md`](mobile-app-mvp.md). Agreed design: the instance decides when to push and sends `{body, level, chatId}` to Rome Cloud. Rome Cloud adds the instance id and delivers through APNs with Amantru's team key. The app asks for permission at a good moment, registers its token with Rome Cloud, and routes a tap to the right instance and its Concierge. The instance and Rome Cloud parts are separate workers.

- Branch: `feat/ios-app` (local only, not pushed)
- Commits: `e0f99310` (signing and capability), `592fd834` (push code, strings, README), `2edf23e7` (tests), `924b9349` (snapshot), `676cef5e` (this file), `84e5661b` (tap crash fix), `a599033b` (`ios/CLAUDE.md` traps)

## What changed

- **Signing.** Debug ("Rome Dev", `cc.romeos.mobile.dev`) now signs with the Amantru team `4YWXB26F39`, like Release, because APNs delivers a team's pushes only to apps that team signed. The gitignored `Config/Local.xcconfig` on this Mac says so, and so do `Local.xcconfig.example` and `ios/README.md`.
- **Capability.** `Config/Rome.entitlements` sets `aps-environment` from `ROME_APS_ENVIRONMENT` in `Config/Base.xcconfig`: `development` for Debug, `production` for Release. It applies to iPhone SDKs only (`CODE_SIGN_ENTITLEMENTS[sdk=iphone*]`), so the ad-hoc signed Mac Catalyst test and snapshot builds still launch. Both Info.plists carry the same value as `RomeAPNsEnvironment`, so the app tells Rome Cloud `sandbox` or `production` from the same setting that signs it.
- **Permission.** The app never asks at launch. Once Concierge is open, Chat shows a quiet card under the header: "Get notified when Rome has something for you", with Turn on and Not now.
  - Turn on shows the system prompt.
  - Not now hides the card for 7 days.
  - The card never shows once the guardian has decided (on or off).
- **Registration.** When permission is on, each launch calls `registerForRemoteNotifications`. The token goes to Rome Cloud `POST /api/devices` with `Authorization: Bearer <device credential>` and the body `{provider: "apns", platform: "ios", token, apns_environment, bundle_id}`.
  - It is sent once per launch and again if the token changes. It waits for Cloud sign-in, and goes out on every instance open.
  - A refusal (401, 403, anything else, or no network) stays quiet, and the next launch or sign-in tries again.
  - Unlike the other Cloud calls, a 401 here keeps the credential, because today's Rome Cloud has no such route yet.
  - The token is never logged. The last accepted token is kept in the Keychain, so sign-out can remove it even before the launch's APNs callback.
- **Sign-out.** `DELETE /api/devices {token}` goes first, with a 10 second timeout, and only then does `CloudAuth.signOut` revoke the session and clear the Keychain.
- **Foreground.** `willPresent` passes no options, so a push that arrives while the app is open shows no banner and plays no sound. The live events already update the chat.
- **Tap.** The payload's `rome: {instanceId, chatId?}` is parsed into `PushTarget`.
  - For another running instance the app switches to it through `AppModel.switchInstance`, the path the Instances page uses. The new shell opens on Chat.
  - For the open instance, the shell closes the Tasks and Settings sheets and the drawer, and shows Chat.
  - An unknown or stopped instance leaves the open instance in place and shows its Concierge.
  - `chatId` is parsed and kept for later: the app has no Concierge topic chats yet.
  - A tap that launches the app cold waits in `AppModel` until an instance opens, and launch prefers the tapped instance. A tap while signed out waits through sign-in.
- **Settings.** Under "Other", a Notifications row shows On, Off or Not set. Not set starts the permission flow. On and Off open the app's notification page in the Settings app.
- **Delegate.** `AppDelegate` implements the completion-handler forms of `UNUserNotificationCenterDelegate` on the main actor. The async forms crashed the app on every tap: under Swift 6 they hand UIKit its completion off the main thread, and UIKit aborts (`84e5661b`; the trap is in `ios/CLAUDE.md`).
- **Code.** `Rome/Notifications/PushModels.swift` holds the pure rules: payload, route, environment, body and the 7-day rule. `Rome/Notifications/PushCenter.swift` holds the state behind two protocols, `DeviceRegistry` (`CloudAuth` conforms) and `NotificationSystem`. `AppDelegate` in `RomeApp.swift` owns `AppModel` and receives the token and taps.
- **Strings.** 7 new English keys, each with zh-Hans.

## What was checked

- **Build.** Debug builds for the iPhone 17 simulator. Its simulated entitlements carry `application-identifier 4YWXB26F39.cc.romeos.mobile.dev` and `aps-environment development`. The Mac Catalyst build carries no `aps-environment`. Release build settings resolve to `production`, team `4YWXB26F39`, `cc.romeos.mobile`.
- **Unit tests.** 72 pass on Mac Catalyst; the live tests were skipped. New tests in `RomeTests/PushTests.swift`:
  - Payload parsing: with and without `chatId`, an empty `chatId`, a push with no `rome` or no instance.
  - Routing: same instance, another running instance, an unknown instance, a stopped instance.
  - Registration body for sandbox and production, the Debug test build registering for sandbox with its own bundle id, the hex token, and the request (path, method, Bearer header).
  - The prompt rule: only while undecided, Not now waits exactly 7 days, Not now survives a relaunch, and authorized never offers.
  - `PushCenter`: registers only after permission and once per token; retries after a refusal; waits for Cloud sign-in; sign-out sends `DELETE` before clearing, also for a token from an earlier launch and when the `DELETE` fails.
- **Snapshots** (Mac Catalyst, light and dark): `23-chat-push-offer` (new) shows the card; `11-settings` shows the Notifications row.
- **Simulator** (iPhone 17, demo data): see "Simulator checks" below.

## Simulator checks

iPhone 17 simulator (iOS 26.5), Debug build, demo data (`ROME_DEMO=1`, set in the simulator's launchd so a launch from a notification gets it too). Pushes sent with `xcrun simctl push`.

- **Card.** It shows on first open of Chat with the real, undecided permission, in light and dark.
- **System prompt.** Turn on shows the system prompt, and Allow hides the card.
- **Not now.** The card goes away. `pushPromptDismissedAt` is saved, and the card stays away after a relaunch.
- **Foreground.** With permission on, a push while Chat is open shows no banner and plays no sound. The same push with the app in the background shows its banner.
- **Tap, same instance.** With the Tasks sheet open, the app went to the background, a push for `demo-1` arrived, and opening it brought the app back with the sheet closed and Chat in front.
- **Tap, other instance.** A push for `demo-2` switches through `AppModel.switchInstance`. Demo data has no Rome Cloud credential, so it ends on sign-in ("Sign-in did not finish"), exactly as switching from the Instances page does in demo mode.
- **Cold launch.** With the app terminated, opening a push launched it. SpringBoard delivered the tap, and the app opened on Chat.
- **Crash found and fixed.** Before `84e5661b` every opened push aborted the app 0.3 seconds after the tap arrived (crash report: `AppDelegate.userNotificationCenter(_:didReceive:)` → UIKit assertion). After the fix there were no new crash reports across the same-instance, other-instance and cold-launch taps.
- **Settings row.** It shows Not set (dark). A tap shows the system prompt, and after Don't Allow the row shows Off. Tapping Off opened the Settings app, but at its root, not at Rome Dev's notification page; worth a look on the phone.
- **Tests after the fix.** 72 pass on Mac Catalyst.

Screenshots are in the shared notes folder, `push-simulator/`.

## Open

- Rome Cloud's side (`amantru/rome-cloud`: Bearer registration, `bundle_id`, `DELETE /api/devices`, the `rome` payload data) is not merged. Until it ships, registration is refused and retried quietly on each launch. No real registration was sent; the tests use a stub registry.
- On the first device build, Xcode registers `cc.romeos.mobile.dev` with the Push Notifications capability in the Amantru team (`-allowProvisioningUpdates`) and needs the phone registered there. The phone build in `/tmp/rome-device` was signed with the old team. It is replaced on the next install, and Keychain items do not carry over, so the guardian signs in again.
- Concierge topic chats: `chatId` is parsed but not used until the app has them.
- Switching instances from a tap is checked only through demo data, which cannot open a second instance. The first real check needs Rome Cloud and two running instances.
- On the phone: check that Off in Settings opens Rome's notification page, not the Settings root.

## Stale chat after opening a push (from the iPhone run)

The user's report: the push arrived, a tap opened Concierge, and the chat still showed the old content while the web dashboard had the new message.

- **What was wrong.** Coming back to the foreground told the stores to refetch only when the socket received its first frame. The local server always sends `subscribed`, so on a healthy socket this worked: a local resume test showed the missed message before any change. A socket that is slow, refused or never opens sends no frame, and nothing refetched. That fits the phone, whose socket goes through Rome Cloud. Separately, a store on two topics reloaded twice per reconnect.
- **Fix** (`5edca3ef`, `37695337`):
  - Resume asks every listener to refetch right away. A connection after a drop or a pause asks again as the server confirms each held topic, which covers what was sent between the fetch and the subscription.
  - A 401 on the socket upgrade goes to the session refresh instead of retrying with the old cookie.
  - Stores share one reload per burst, plus one for requests that come while it runs.
  - A tapped push for the open instance refetches Concierge itself, because the tap can arrive before the app is active, or over the open app with no pause at all.
- **Tests** (`85a5a7d1`): resume with no frame refetches; resume without a pause does not; a reconnect after a drop owes each held topic once, also after a failed attempt; a healthy connection owes nothing; a burst reloads once; requests during a reload add exactly one; a resumed chat shows a message stored while away; the task list refreshes once per burst. 82 pass on Mac Catalyst.
- **Simulator**, against a local Rome (`ROME_PROFILE=ios-test`), each with a message posted while the app was in the background:
  - Healthy socket, resume from the icon: the missed message shows.
  - Socket refused by a proxy that passes REST and answers 503 to the upgrade, resume from the icon: the missed message shows (one messages fetch, one task-list fetch).
  - The same refused socket, a push for instance `local` opened from Notification Center: the missed message shows (two messages fetches: resume and tap).
- **Not confirmed.** Why the phone's socket gave no frame is not known; the fix does not depend on it. If the phone's live updates also stop while the app stays open, the socket through Rome Cloud needs a look of its own. A topic chat is ruled out: both phone-run pushes carried `chatId: "concierge"`, the main chat.
