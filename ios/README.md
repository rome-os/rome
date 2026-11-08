# Rome for iOS

A native SwiftUI app for Rome. Chat (the Concierge) is the home screen; the Tasks sheet lists what the Concierge is working on, and each task opens its chat, where approvals and questions are answered. Sign-in goes through Rome Cloud, and the app opens an instance on its own: the one this device used last, else the only running one, else the first running one.

## Build and run

Open `Rome.xcodeproj` in Xcode and run the `Rome` scheme on an iPhone simulator, or from the command line:

```bash
xcodebuild -project Rome.xcodeproj -scheme Rome -destination 'platform=iOS Simulator,name=iPhone 17' build
```

If Xcode reports that CoreSimulator is out of date, finish Xcode's first launch once: `sudo xcodebuild -runFirstLaunch`, then `xcodebuild -downloadPlatform iOS` if no iOS runtime is installed.

Device builds need a team: copy `Config/Local.xcconfig.example` to `Config/Local.xcconfig`, which sets `DEVELOPMENT_TEAM` to Rome's own team, Amantru, Inc (`4YWXB26F39`). Debug and Release both sign with it, because pushes are sent with that team's APNs key and reach only apps it signed. Debug builds use the bundle id `cc.romeos.mobile.dev` and the name "Rome Dev"; Release builds are the TestFlight app (see "Release to TestFlight").

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

A phone keeps an installed app's team. A build signed by another team is refused with "MismatchedApplicationIdentifierEntitlement", so delete the app from the phone first; that also deletes its sign-in. The first launch right after installing from a new team can fail with "Application failed preflight checks"; launch again.

## Release to TestFlight

Release builds are the TestFlight app: bundle id `cc.romeos.mobile`, name "Rome", HTTPS to `https://romeos.cc` only, and no demo data, snapshot runner, debug environment variables or Mac Catalyst. Debug builds are `cc.romeos.mobile.dev`, named "Rome Dev", so both can sit on one phone. `MARKETING_VERSION` is in `Config/Base.xcconfig`.

TestFlight ships under Rome's own Apple Developer team, not a personal one. The archive command passes that team on the command line, so it signs with it whatever `Config/Local.xcconfig` says. The build number is the archive time in UTC, `YYYYMMDDHHMM`. It always increases whatever branch you archive from, so no upload needs a manual edit.

1. Archive (local only, safe to run):

   ```bash
   xcodebuild -project Rome.xcodeproj -scheme Rome -configuration Release -destination 'generic/platform=iOS' -archivePath /tmp/rome-archive/Rome.xcarchive -allowProvisioningUpdates DEVELOPMENT_TEAM=<ROME_TEAM_ID> CURRENT_PROJECT_VERSION=$(date -u +%Y%m%d%H%M) archive
   ```

2. Upload to App Store Connect. **This publishes a build: run it only with the lead's go.** `Config/ExportOptions.plist` uses the `app-store-connect` method with the `upload` destination, so exporting is the upload:

   ```bash
   xcodebuild -exportArchive -archivePath /tmp/rome-archive/Rome.xcarchive -exportOptionsPlist Config/ExportOptions.plist -exportPath /tmp/rome-archive/export -allowProvisioningUpdates
   ```

   Xcode needs an Apple ID in Rome's team signed in under Xcode → Settings → Accounts, with the App Manager role or higher. The App Store Connect app record for `cc.romeos.mobile` must exist first.

   That sign-in can lapse without warning. The export then fails with "No Accounts". To export without it, use a team App Store Connect API key instead. Add these to both the archive and the export command:

   ```bash
   -authenticationKeyPath ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8 -authenticationKeyID <KEY_ID> -authenticationKeyIssuerID <ISSUER_ID>
   ```

   The key needs the Admin role, because the export creates or uses the cloud-managed distribution certificate. Its `.p8` stays outside every repository, at that path with mode 600. App Store Connect offers the file for download only once.

   No certificate needs to be on the Mac beforehand. The first archive creates an Apple Development certificate for the team in the keychain, and the export signs with the team's Apple Distribution certificate, which Xcode keeps in the cloud. The upload ends with "Uploaded package is processing"; App Store Connect then processes the build before TestFlight lists it.

   The archive is signed with the development profile, so its app reads `aps-environment` = `development` even in Release. The export re-signs it with `production`. To check that before uploading, export once with `destination` set to `export` in a copy of `ExportOptions.plist`, then read the entitlements of the app in the `.ipa`.

3. Delete `/tmp/rome-archive` when the build shows up in App Store Connect.

To check a Release build without signing: `xcodebuild -project Rome.xcodeproj -scheme Rome -configuration Release -destination 'generic/platform=iOS' -derivedDataPath /tmp/rome-release CODE_SIGNING_ALLOWED=NO build`.

## Push notifications

The Push Notifications capability is on for both builds: `Config/Rome.entitlements` sets `aps-environment` from `ROME_APS_ENVIRONMENT` in `Config/Base.xcconfig`, `development` for Debug and `production` for Release. The same value tells Rome Cloud whether the token is for the APNs sandbox or production. Mac Catalyst builds sign without it, so the ad-hoc signed test and snapshot runs still launch.

The app asks for permission from a card in Chat, never at launch, and registers its token with Rome Cloud (`POST /api/devices`) on every launch while signed in. On a simulator, send a push to the Debug build with a payload file:

```bash
xcrun simctl push booted cc.romeos.mobile.dev push.json
```

```json
{"aps": {"alert": {"title": "Rome", "body": "Your report is ready"}}, "rome": {"instanceId": "<instance id>", "chatId": "<chat id>"}}
```

While the app is open the push shows no banner; the chat updates from live events. A tap opens the instance named in `rome.instanceId`, then its Concierge.

## Debug modes

Debug builds read these environment variables (set them in the scheme's Run options):

| Variable | Effect |
|---|---|
| `ROME_DEMO=1` | Opens built-in demo data: every task state, an approval, a question, a failed task. Also available by long-pressing "Rome" on the sign-in screen. |
| `ROME_DEMO=update` | Opens the demo data on a Rome one release behind, so the update page shows; "Update now" finishes after a few seconds. |
| `ROME_DEMO=many-apps` | Opens the demo data with a screenful of apps, for the Apps grid. |
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

The scheme runs tests in English (US region), whatever the Mac's language. `LocalizationTests` checks that every key in `Rome/Localizable.xcstrings` has Simplified Chinese text.

`LiveIntegrationTests` runs only when `TEST_RUNNER_ROME_LOCAL_ORIGIN`, `TEST_RUNNER_ROME_LOCAL_USER` and `TEST_RUNNER_ROME_LOCAL_PASSWORD` are set. It reads every surface the app reads and sends one real message to the Concierge.

## Snapshots

With `ROME_SNAPSHOT_DIR` set, a debug build opens the demo data, walks every screen in light and dark, writes one PNG per screen, and quits. Run it on Mac Catalyst:

```bash
xcodebuild -project Rome.xcodeproj -scheme Rome -destination 'platform=macOS,variant=Mac Catalyst' -derivedDataPath /tmp/rome-cat CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual build
ROME_SNAPSHOT_DIR=/tmp/rome-shots /tmp/rome-cat/Build/Products/Debug-maccatalyst/Rome.app/Contents/MacOS/Rome
```

The app follows the system language: English, or Simplified Chinese on a Chinese system. To capture one language, pass it to the app:

```bash
ROME_SNAPSHOT_DIR=/tmp/rome-shots-zh /tmp/rome-cat/Build/Products/Debug-maccatalyst/Rome.app/Contents/MacOS/Rome -AppleLanguages "(zh-Hans)"
```

`ROME_SNAPSHOT_ONLY=04-chat,06-tasks` limits the run to some screens. With the local Rome variables and `ROME_SNAPSHOT_LIVE=1`, it instead sends a real request and captures the Concierge starting and finishing a task.
