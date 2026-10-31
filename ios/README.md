# Rome for iOS

A native SwiftUI app for Rome. Chat (the Concierge) is the home screen; the Tasks sheet lists what the Concierge is working on, and each task opens its chat, where approvals and questions are answered. Sign-in goes through Rome Cloud, and the app opens an instance on its own: the one this device used last, else the only running one, else the first running one.

## Build and run

Open `Rome.xcodeproj` in Xcode and run the `Rome` scheme on an iPhone simulator, or from the command line:

```bash
xcodebuild -project Rome.xcodeproj -scheme Rome -destination 'platform=iOS Simulator,name=iPhone 17' build
```

If Xcode reports that CoreSimulator is out of date, finish Xcode's first launch once: `sudo xcodebuild -runFirstLaunch`, then `xcodebuild -downloadPlatform iOS` if no iOS runtime is installed.

Device builds need a team: copy `Config/Local.xcconfig.example` to `Config/Local.xcconfig` and set `DEVELOPMENT_TEAM`. Debug builds use the bundle id `cc.romeos.mobile.dev`.

### On a physical iPhone

Signing is automatic, so Xcode must have an Apple ID for that team under Xcode → Settings → Accounts. A development certificate in the keychain is not enough: without the account the build fails with "No Accounts". `xcrun devicectl list devices` gives the phone's identifier; the phone needs Developer Mode on.

```bash
xcodebuild -project Rome.xcodeproj -scheme Rome -configuration Debug -destination 'id=<device-id>' -derivedDataPath /tmp/rome-device -allowProvisioningUpdates build
```

```bash
xcrun devicectl device install app --device <device-id> /tmp/rome-device/Build/Products/Debug-iphoneos/Rome.app
```

```bash
xcrun devicectl device process launch --device <device-id> --terminate-existing cc.romeos.mobile.dev
```

Installing works on a locked phone, but launching does not: it fails with "Locked", so unlock the phone first.

## Debug modes

Debug builds read these environment variables (set them in the scheme's Run options):

| Variable | Effect |
|---|---|
| `ROME_DEMO=1` | Opens built-in demo data: every task state, an approval, a question, a failed task. Also available by long-pressing "Rome" on the sign-in screen. |
| `ROME_LOCAL_ORIGIN`, `ROME_LOCAL_USER`, `ROME_LOCAL_PASSWORD` | Signs in to a Rome on this Mac with a local test guardian instead of Rome Cloud. |

To run a local Rome for this, start core with its own profile so it does not touch `~/.rome/default`:

```bash
ROME_PROFILE=ios-test pnpm --filter @rome/core start
```

The API listens on `http://127.0.0.1:4141`. Create the guardian once with `POST /api/onboard/create-account` and turn on Concierge with `PUT /api/settings {"experimentalConcierge":true}`.

## Tests

Unit tests use Swift Testing. They run on a simulator, or on Mac Catalyst when no simulator is available:

```bash
xcodebuild test -project Rome.xcodeproj -scheme Rome -destination 'platform=macOS,variant=Mac Catalyst' CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual
```

`LiveIntegrationTests` runs only when `TEST_RUNNER_ROME_LOCAL_ORIGIN`, `TEST_RUNNER_ROME_LOCAL_USER` and `TEST_RUNNER_ROME_LOCAL_PASSWORD` are set. It reads every surface the app reads and sends one real message to the Concierge.

## Snapshots

With `ROME_SNAPSHOT_DIR` set, a debug build opens the demo data, walks every screen in light and dark, writes one PNG per screen, and quits. Run it on Mac Catalyst:

```bash
xcodebuild -project Rome.xcodeproj -scheme Rome -destination 'platform=macOS,variant=Mac Catalyst' -derivedDataPath /tmp/rome-cat CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual build
ROME_SNAPSHOT_DIR=/tmp/rome-shots /tmp/rome-cat/Build/Products/Debug-maccatalyst/Rome.app/Contents/MacOS/Rome
```

`ROME_SNAPSHOT_ONLY=04-chat,06-tasks` limits the run to some screens. With the local Rome variables and `ROME_SNAPSHOT_LIVE=1`, it instead sends a real request and captures the Concierge starting and finishing a task.
