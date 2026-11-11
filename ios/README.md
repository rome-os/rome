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

### On an iPad

The app runs on iPhone and iPad. A phone stays in portrait; an iPad turns to every orientation and works in Split View, Slide Over and Stage Manager windows. Layout goes by width, never by device: on a regular width the drawer is pinned beside the page, and the header's drawer button slides it away and back; on a compact width, such as a narrow iPad window, the drawer slides out as on a phone. Both are one view tree in `MainShell` that only changes frames and offsets, so a window resized across the two keeps the open page and its state. Conversations keep one centered column of `Metrics.readableWidth` (720 pt) at most. Check a screen change on an iPad simulator too, for example `name=iPad Pro 13-inch (M5)`.

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
| `ROME_DEMO=update` | Opens the demo data on a Rome below the app's minimum version, so the update page covers the app; "Update now" finishes after a few seconds. |
| `ROME_DEMO=update-offered` | Opens the demo data on a Rome behind its latest release but new enough for the app: the banner and the drawer's line offer the update. |
| `ROME_DEMO=visitor` | Opens the demo data as a dashboard visitor of a shared Rome. |
| `ROME_DEMO=many-apps` | Opens the demo data with a screenful of apps, for the Apps grid. |
| `ROME_LOCAL_ORIGIN`, `ROME_LOCAL_USER`, `ROME_LOCAL_PASSWORD` | Signs in to a Rome on this Mac with a local test guardian instead of Rome Cloud. |

The stacking game ("Stack up") opens from the update page while a Rome upgrades, or with ten quick taps on Chat's mascot. To reach the update entry without a real upgrade, launch with `ROME_DEMO=update` and tap "Update now": the demo upgrade runs for about 8 seconds, and "Play a game" shows under its status line. The best score stays on the device, across sign-out.

To run a local Rome for this, start core with its own profile so it does not touch `~/.rome/default`:

```bash
ROME_PROFILE=ios-test pnpm --filter @rome/core start
```

The API listens on `http://127.0.0.1:4141`. Create the guardian once with `POST /api/onboard/create-account` and turn on Concierge with `PUT /api/settings {"experimentalConcierge":true}`.


### Against a local Rome Cloud

To test Cloud sign-in, instance listing and visitors against a Rome Cloud on this Mac, build Debug with its origin on the command line, never in a committed file:

```bash
xcodebuild -project Rome.xcodeproj -scheme Rome -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath /tmp/rome-sim ROME_CLOUD_ORIGIN=http://cloud.rome.localhost:3000 build
```

Debug allows plain HTTP to names under `localhost`. The app opens an `http://` instance only while Rome Cloud itself is on `http://`, which is only ever a Cloud on this Mac: Release always signs in with `https://romeos.cc`.

## Apple Health (this iPhone as a device)

Signed in to Rome Cloud, with Settings → iPhone use → Can Rome use this iPhone turned on (it is off by default), the app also connects the phone as a rome-node device, so an agent can read Apple Health with `health.stats` and `health.samples`. The wire protocol, arguments and audit log are in [`docs/rome-node.md`](../docs/rome-node.md#iphone). The code is in `Rome/Node` and the switches, status and recent activity are in Settings → iPhone use.

The device is online only while the app is in front and past the sign-in screen. HealthKit needs the `com.apple.developer.healthkit` entitlement in `Config/Rome.entitlements` and `NSHealthShareUsageDescription` in both Info plists. The text says the Health data you allow goes to your Rome and its AI model. The Apple Health row in Settings → iPhone use opens a page (`Features/Settings/HealthAccessScreen.swift`) that explains what Rome does with Health and where the data goes, and holds the switch. The switch is off until the user turns it on, and a request meets `health_off` until then. Both builds read only. `NSHealthUpdateUsageDescription` is in `Config/Info-Debug.plist` alone, for the Debug seeding below. A build on a physical iPhone or TestFlight also needs the HealthKit capability on the App ID `cc.romeos.mobile` (and `.dev`) in the Apple Developer portal, and the App Store privacy answers need Health and Fitness data (the privacy manifest lists both).

The Simulator's Health is empty. Launch a Debug build with the argument `-RomeSeedHealth` and it writes a week of steps, heart rate, sleep (with overlapping records) and three runs, once per install:

```bash
xcrun simctl launch booted cc.romeos.mobile.dev -RomeSeedHealth
```

It asks for Health access in one system sheet (tap "Turn On All", then "Allow"). To try the actions, sign in on the Simulator, then from a Rome with rome-node run `rome-node device describe <iphone>` and `rome-node device run <iphone> health.stats --args '{"type":"stepCount","interval":"day","start":"2026-11-03","end":"2026-11-09"}'`. The phone must be unlocked and the app in front.

## Instance versions

The app works with any instance at or above `UpdateGate.minimumInstanceVersion` (in `Rome/Features/Update/InstanceUpdater.swift`), the oldest release with every API the app calls. An instance below it gets the update page over the whole app, with no way past it but updating. An instance at or above it that is behind its latest release only gets an offer: a pill above Chat's composer, which stays closed for that release once closed, and a line in the drawer until it is current. Visitors get the same update flow as the guardian, the update itself included.

Raise the minimum only when the app starts calling an API a newer release brought, to the first release tag (`v1.*`) that has it. Anything else the app reads from an older supported instance is optional and degrades quietly.

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
