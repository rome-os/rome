# Mobile App MVP: release prep that needs no account

Worker result for "Release prep that needs no account" under TestFlight in [`mobile-app-mvp.md`](mobile-app-mvp.md). TestFlight will ship under Rome's own Apple Developer organization account, which does not exist yet. Everything here works without it. Once the Team ID arrives, the release is: pass the team, archive, and upload with the lead's go.

- Branch: `feat/ios-app` (local only, not pushed; nothing uploaded)
- Commits: `c3f8f893` (Release apart from Debug), `3491a51c` (privacy manifest), `f7dd2dee` (archive and upload steps), plus the commit that adds this file

## What changed

- **Bundle ids and names.** Release is `cc.romeos.mobile`, shown as "Rome". Debug stays `cc.romeos.mobile.dev`, shown as "Rome Dev". Both are set in `ios/Config/Base.xcconfig` with `[config=…]` conditions.
  - Keychain: the app stores its items with the service `cc.romeos.mobile` and no access group. iOS then uses each app's own default group, so the two builds keep separate sign-ins and never read each other's items. No entitlement is needed.
  - OAuth: the redirect `cc.romeos.mobile:/oauth/callback` goes through `ASWebAuthenticationSession` with the callback scheme `cc.romeos.mobile`. That works the same in both builds and needs no URL type registered. Rome Cloud sees one redirect URI.
- **Export compliance.** `ITSAppUsesNonExemptEncryption = NO` is in both Info.plist files. The app uses HTTPS only.
- **Versions.** `MARKETING_VERSION = 1.0.0`. The build number is 1 for local builds. The archive command sets it to the UTC archive time, `YYYYMMDDHHMM` (`CURRENT_PROJECT_VERSION=$(date -u +%Y%m%d%H%M)`). A timestamp always increases whatever branch is archived, while a commit count can go down on another branch. No upload needs a manual edit. The target no longer overrides the version and build settings, so the xcconfig is the one place for them.
- **Icon.** No change needed: the one 1024×1024 PNG has no alpha channel and an opaque white background, and Xcode builds the smaller sizes from it.
- **Release hygiene:**
  - Demo data, the snapshot runner, the debug environment variables (`ROME_DEMO`, `ROME_LOCAL_*`, `ROME_SNAPSHOT_*`) and the sign-in screen's demo menu are all behind `#if DEBUG`.
  - Mac Catalyst is on for Debug only. Release is iPhone only.
  - Release always uses `https://romeos.cc`. The xcconfig sets it again after including `Local.xcconfig`, so a local override cannot reach Release.
- **Local networking: Debug only.** I moved `NSAllowsLocalNetworking` into a Debug-only `ios/Config/Info-Debug.plist`. No real user needs it: the app opens instances only through Rome Cloud, and it accepts an instance origin only over https. Plain HTTP is used only by the debug `ROME_LOCAL_*` path to a Rome on this Mac or the LAN. `ios/CLAUDE.md` now says to change both plists together.
- **Privacy manifest.** `ios/Rome/PrivacyInfo.xcprivacy`:
  - No tracking and no tracking domains.
  - One required-reason API: UserDefaults with reason CA92.1, for the app's own settings (last instance, pending upgrade, hints).
  - The data types listed in the next section.

  I checked the Release binary for other required-reason symbols (system boot time, file timestamps, disk space, active keyboards) and found none.
- **Steps.** `ios/README.md` has a new "Release to TestFlight" section:
  - an archive command that passes `DEVELOPMENT_TEAM=<ROME_TEAM_ID>` and the timestamp build number on the command line, so `Local.xcconfig` keeps signing Debug builds with a personal team;
  - the `xcodebuild -exportArchive` upload with `ios/Config/ExportOptions.plist` (`app-store-connect`, destination `upload`, automatic signing, symbols uploaded), marked as needing the lead's go;
  - what Xcode needs signed in.

## App Store Connect privacy questions

What the answers will need, matching the manifest. None of it is used for tracking or advertising. All of it is linked to the guardian's account and used for app functionality:

- **Contact info, email address:** the Rome Cloud account.
- **Contact info, name:** the guardian's name on their Rome.
- **Identifiers, user ID:** the Rome Cloud account and the instance session.
- **User content, other user content:** chat messages, answers to questions, and approval decisions sent to the guardian's Rome.
- **User content, customer support:** text sent with "Send feedback".
- **Not collected:** location, contacts, photos, health, financial info, browsing history, diagnostics, and crash data. The app has no analytics or crash SDK.

Someone who knows how Rome Cloud and the instances store this data should confirm it before submitting. The answers describe where the data goes, not only what the app does.

## What was checked

- **Release device build without signing** (`generic/platform=iOS`, `CODE_SIGNING_ALLOWED=NO`): it compiles.
  - Its Info.plist has `cc.romeos.mobile`, display name "Rome", 1.0.0, `ITSAppUsesNonExemptEncryption = false`, `RomeCloudOrigin = https://romeos.cc`, and no `NSAppTransportSecurity`.
  - `PrivacyInfo.xcprivacy` is in the bundle.
  - The binary holds no demo or debug strings (`ROME_DEMO`, `ROME_LOCAL`, `ROME_SNAPSHOT`, demo instance names, "Open demo data").
- **Unsigned archive:** with the timestamp build number it gives `CFBundleVersion` `202611050342` and a dSYM.
- **Release build on the Simulator:** launched with `ROME_DEMO=1` set, it still starts on the sign-in screen. Long-pressing "Rome" opens no debug menu.
- **Side by side:** Release and Debug installed together on one simulator, shown as "Rome" and "Rome Dev".
- **Unit tests:** 51 pass (Debug, iPhone 17 simulator).

Not checked: a signed archive and the upload. Both need Rome's team.

## Note for the lead

The Debug build is now named "Rome Dev". The next reinstall on the user's phone shows the new name. It is the same app (`cc.romeos.mobile.dev`) and keeps its sign-in.
