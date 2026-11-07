# Mobile App MVP

The native iOS app in `ios/`: Chat (Concierge) as the home screen, the Tasks sheet, task chats with approvals and questions, the drawer, Settings, Search and Routines. Design: the claude.ai artifact "Rome iOS v1 设计稿"; scope and decisions: the Claude Doc "Rome iOS v1 设计文档".

- Branch: `feat/ios-app` (local only, not pushed)
- Worktree: `.claude/worktrees/mobile-app-mvp`
- Lead: session "★ Mobile App MVP lead"

## Done

- [x] App built on all 7 design boards, light and dark (`ed3f1654`, `ec53a107`, `00fc76f9`)
- [x] 26 unit tests pass (Mac Catalyst); 2 live tests pass against a local Rome
- [x] Real flow checked against a local Rome: send → reply → task created → result back in Chat
- [x] Runs in the iPhone 17 simulator (demo data)
- [x] `ios/README.md`, `ios/CLAUDE.md`, root `CLAUDE.md` line, `.github/workflows/ios-ci.yml`

## Waiting on the user

- [x] Rome Cloud sign-in on the simulator works end to end (confirmed by the user)
- [x] Install on the user's iPhone: installed and launched on Eric Liu's iPhone (iPhone 18 Pro, iOS 27.0.1), Debug build of eab3914d (round 1 feel fixes and the always-latest instance update), team B2U93L2LK4, bundle id `cc.romeos.mobile.dev`. Device steps are in `ios/README.md`.
- [x] English as the default language, zh-Hans a translation: merged from `claude/epic-vaughan-1e52a1` after an independent review found no serious defects (result: [`mobile-app-mvp-english.md`](mobile-app-mvp-english.md))
- [x] Reinstall the merged build on the user's iPhone (b72cb7d8, tests passed first)
- [x] Routines and Search from the drawer open in place, no push over Chat: they are root pages the drawer switches between, with the drawer button at top left (a no-animation push did not work on iOS 27)
- [x] Try the app on the iPhone and list what feels off (first pass, 2026-10-31: see "Feel fixes, round 1")
- [ ] OK to push `feat/ios-app` and open a PR to `main`

## Feel fixes, round 1 (from the user's iPhone pass)

- [x] Chat top bar: drop the black bar; the bar is clear, and its three items sit on the iOS glass background (`525b6072`: Liquid Glass on iOS 26+, material before; the task chat header matches)
- [x] Drawer: a swipe on the uncovered chat area closes it; the divider no longer shakes while it closes (`4ff00a65`: the drag read the finger in the moving card's own space; it now reads screen space, and a tap also closes)
- [x] Settings: slides up from the bottom with an X at top right (no back button); opening it leaves the drawer as it is (`6f8a56ef`: a sheet over the open drawer; instances push inside it)
- [x] Task chat: no jumping while scrolling during a running turn (`24442a78`, `4f1692cd`, `f631e692`: follows the bottom only while the guardian is there, same-second rows no longer swap, older pages wait for the scroll to rest; checked on demo data and a local Rome)
- [x] Task chat: after Stop, the "Running" spinner stops (`f3c1fcbb`: the spinner follows the running turn only, the header says "Stopped", and the store re-checks active turns after the interrupt; checked on a local Rome)

Result: [`mobile-app-mvp-feel-1.md`](mobile-app-mvp-feel-1.md). Review round 1 fixes: `f661266a`, `2c003182`, `6fe4f10c`, `5122af04`, `2e8a8b3f`.

## Instance always on the latest version

Decision (user, 2026-11-04): the app always requires the instance's latest release; the instance's API stays backward compatible, so the app's and the instance's versions never need to match.

- [x] Block the app with a full-screen "Update your Rome" page while the instance is not on the latest release, with one "Update now" action; track the upgrade until the new version answers (`1e0d7f18`, `4cef5d7d`, `588bd463`, `8868c7e5`: never blocks when the check cannot decide; resumes waiting after a relaunch; checked on demo data and a local Rome that answers `unversioned_build`. Result: [`mobile-app-mvp-forced-update.md`](mobile-app-mvp-forced-update.md))

## Push notifications

Agreed design: the instance decides when to push and sends `{body, level, chatId}` to Rome Cloud; Rome Cloud adds the instance id and delivers through APNs with Amantru's team key; the app asks permission at a good moment, registers its token, and routes a tap to the right instance and Concierge.

- [x] App side (`e0f99310`, `592fd834`, `2edf23e7`, `924b9349`): Debug signs with team `4YWXB26F39` like Release; `aps-environment` development/production; a quiet "Turn on" card in Chat (Not now waits 7 days); token registered with Rome Cloud `POST /api/devices` on each launch, refusals retried quietly; `DELETE` before sign-out clears credentials; no banner in the foreground; a tap switches to its instance and opens Concierge, also from a cold launch; Settings row On / Off / Not set. 72 Mac Catalyst tests pass; card and Settings snapshots light and dark. Result: [`mobile-app-mvp-push.md`](mobile-app-mvp-push.md)
- [x] Simulator: card, system prompt, Not now, no banner in the foreground, tap routing (same instance, other instance, cold launch) with `xcrun simctl push`. It found a crash on every tap, now fixed (`84e5661b`); trap in `ios/CLAUDE.md` (`a599033b`)
- [x] Rome Cloud side (`amantru/rome-cloud#276`, deployed to romeos.cc) and instance side (`rome-os/rome#1796`, released in 1.1.183) merged; a real proactive push end to end on the user's iPhone 18 Pro with the Debug build against production, confirmed by the user (2026-11-07)
- [ ] TestFlight build with push (needs `feat/ios-app` pushed and a new archive)
- [ ] Local end-to-end test with a sandbox-only APNs key: "Rome Push Local Test", Key ID `GL5Q9DS43J`, team `4YWXB26F39` (created 2026-11-06 at the user's OK). The `.p8` is outside every repo, in `~/.config/rome-push/` (mode 600). Needs a local Pantheon (`.env` with `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_P8`), a local instance linked to it, and Rome Dev pointed at it. **Delete the key in Apple Developer › Keys and the local file after testing.** Cleanup 2026-11-07: local `.p8`, `~/.config/rome-push/`, the Caddy CA volume, local Pantheon (PM2, database, `.env`) and the pushtest stack removed; push worker sessions archived, their worktrees and branches deleted. Key `GL5Q9DS43J` revoked in Apple Developer the same day. Still open: the user removes the local CA profile from the iPhone 15.
- [ ] Concierge topic chats: open the push's `chatId` (parsed, not used yet)

## Topic chats

- [x] Drawer: the coming-soon entries are gone; under Chat and Routines, a divider and a "Topic chats" section with + (44 pt) and each topic chat with its unread count. + opens a blank chat in Chat's style; nothing is created until the first send, which starts the chat and then sends to it; the chat then shows in the drawer with the name the server gives it. Each chat's Tasks lists its own tasks; a push for a topic chat opens it (`a4376ba1`, `f07c0ff5`, `80f71ff5`, `97f037a6`). 100 Mac Catalyst tests pass; snapshots `05-drawer`, `24-topic-chat`, `25-topic-blank` light and dark; checked on the Simulator against a local Rome (create from +, send, named in the drawer, reopen, a push opens it). Screenshots: notes folder `topic-chats/`.

## Composer and replies (batch I–O)

- [x] I–L by the iOS app worker (`71aa41a9`, `1281aafc`, `42684366`, `5ade4aaa`): glass composer; + menu (camera, library), up to 4 photos as thumbnails in the composer, JPEG long edge 2048 and ≤ 2.5 MB, sent as the turn's `files`; image paste (the field is now a UIKit text view, since SwiftUI's paste hook needs iOS 27); every Concierge reply in a bubble, folded past about 15 lines. 139 Mac Catalyst tests pass; checked on the Simulator against a local Rome. Snapshots: notes folder `photos-glass-bubbles/`. Independent review: no crashes, concurrency or auth problems; 10 fixes sent back (big-image memory, failed loads never retrying, a photo sent late, `+` in file names, parser edge, main-thread decoding, fold by measured height, light-mode composer contrast). Due after M–O, before drafts.
- Uploads need no server change: the server saves each file in the chat's project folder and appends `- File N: [name](</projects/…>)` to the stored message text; the app parses those lines and loads the photos from `GET /api/projects/asset?path=…`. Not live-checked: paste and the camera.
- [x] M–O (`78475787`, `aa394b09`, `9a49aac3`, `17a60455`; part of M landed in `c7f25614` by a lead mistake): the mascot (drawn from the web icon's paths) on the launch and opening screens, "Rome" and three pulsing dots, blink/glance/nod, still under Reduce Motion, the launch logo and the live one line up exactly; `Palette.drawerPage` behind the open drawer, blended by drawer progress, replacing the scrim; starter "Summarize this week's AI news". 145 Mac Catalyst tests pass. Snapshots: notes folder `mascot-drawer-starter/`. Nit: faint gray edge on the launch SVG's eyes (a PDF asset would fix it).
- [x] Review fixes for I–L (`8e544e1b`), installed on both iPhones (153 Mac Catalyst tests passed first)

## Update page and chat titles

Done (`2ddca7b8`, `63d70b78`, `ebffb0b3`, `5400b50d`): 170 Mac Catalyst tests pass; snapshots of each update state and the headers in notes folder `update-page-headers/`. Tasks | … capsule 78 pt instead of 92. Edge fade behind the plain title (`b5d5296f`).

- [x] Update page in the opening screen's style: mascot, versions named ("Your Rome is on X. The latest is Y."), while updating the animated mascot plus a status line that follows the real state (asking Rome Cloud, downloading Y, restarting, almost done), "This can take a few minutes…" (user, 2026-11-06). Queued after the appearance setting.
- [x] Topic and task chat headers: the title is one line of small text, no glass pill; side buttons keep their glass; main Chat unchanged (user, 2026-11-06). Queued.

## Composer drafts

- [x] Done (`e243ef56`, `662da7fb`; Appearance `9a3b3703`, `32b6bf7b`): 167 Mac Catalyst tests pass; checked on the Simulator (kill + relaunch restores text and photo; Dark switches an open sheet at once and sticks). Screenshots: notes folder `review-drafts-appearance/`. Independent review: Appearance clean; 7 draft fixes sent back (a restored failed send comes back after clearing, a task chat's failed send lost on leaving, a blank topic chat's first send unprotected, older failed sends dropped, a possible double send after a lost reply, disk writes per keystroke on the main thread, path edge cases). Fixed (178 Mac Catalyst tests pass): restored slots move into live; task chat stores live on Workspace; a blank topic chat's first send is saved before the create call; unsent slots merge; restore drops what the transcript already has; disk work debounced on one serial queue; ids percent-encoded, demo and Local Rome drafts kept.
- [x] One local draft per chat (instance + chat: main, topic, task chats): text and photos, saved on each edit, restored on reopen and after a relaunch; cleared when a send succeeds, kept when it fails; wiped on sign-out; a blank topic chat's draft goes with it if never sent. No drawer marker (user, 2026-11-06). Queued to the iOS app worker after batch I–O.

## Appearance

- [x] Settings › Appearance: Automatic (default), Light, Dark. Ember only, no more themes; stored on the phone for the whole app, independent of the web dashboard (user, 2026-11-06). Queued to the iOS app worker after drafts.

## Login and Settings

- [ ] Login page with the mascot: centered where the launch logo sits, "Rome" and the sign-in line below, an occasional blink; stopped / no-instance states use the mascot instead of the power icon (user, 2026-11-06). Queued after the update page.
- [ ] Settings: the X at top right stays fixed while the list scrolls (user, 2026-11-06). Queued.

## Images

- [x] (`c3c074be`, `e185e725`; 186 Mac Catalyst tests pass; Simulator: viewer, pinch zoom, swipe down, Share; snapshots in notes folder `images-viewer/`) Tap any photo to open it full screen (zoom, swipe down to close, swipe between a message's images, share); Markdown images in replies show in the bubble (internal ones through the asset endpoints, external https without credentials). Plain links to image files stay links, like the web (user, 2026-11-06: the simpler option). Queued after the draft fixes.

## Scroll to bottom

- [x] (189 Mac Catalyst tests pass; momentum tap checked on the Simulator; screenshots in notes folder `back-to-bottom/`. Follow-up sent: the button and the composer are too see-through in light mode) A round glass down-arrow button above the composer once the guardian is more than two screens above the bottom; tapping scrolls to the newest row, also while the list is still gliding (user, 2026-11-06). Queued after images.

## Next

- [ ] Fix whatever the Cloud sign-in run turns up
- [ ] Open the PR; get `ios-ci` green
- [ ] TestFlight: Apple Team ID, signing, and upload steps (needs the user; nothing uploaded without a go)
    - [x] Rome's own Apple Developer organization account: Amantru, Inc, Team ID `4YWXB26F39`; the user is an Admin (2026-11-05). `cc.romeos.mobile` was already registered there as "Rome Mobile".
    - [x] App Store Connect app record: "Rome – Personal Agent OS" (App ID 6831429506), company name Amantru, Inc, English (U.S.), SKU `rome-ios`, Full Access. "Rome" and "Rome OS" were taken; the home-screen name stays "Rome".
    - [x] Release prep that needs no account: export compliance key, version and build number rule, icon check, Release build without demo and debug entries, archive and export steps in `ios/README.md` (`c3f8f893`, `3491a51c`, `f7dd2dee`: Release is `cc.romeos.mobile` "Rome", Debug `cc.romeos.mobile.dev` "Rome Dev"; build number is the UTC archive time; privacy manifest added; icon already fine. Result: [`mobile-app-mvp-release-prep.md`](mobile-app-mvp-release-prep.md))
    - [x] Switch signing to the new team, archive, upload (the user's go, 2026-11-05): version 1.0.0, build 202611060248, from `8454fb61`, team `4YWXB26F39`, `cc.romeos.mobile`. The upload was accepted and Xcode reported "Uploaded package is processing"; App Store Connect itself was not checked, because it needs the user's sign-in. No certificate needed setting up: Xcode made the team's development certificate and signed for distribution in the cloud.
    - [ ] Team members join as internal testers

## Small changes (batched)

- [ ] Login wordmark in Funnel Sans (system font today)
- [x] Drawer "Apps", "Memory", "Activity" are not in the string catalog (removed with the coming-soon entries)
- [ ] Demo instance names in `DemoBackend.instances` stay Chinese on an English phone (debug only)
- [ ] Tests cover the Chinese weekly schedule text and Chinese date formats again (tests now run in English only)
- [ ] Chinese error strings keep a full stop the English dropped ("没有网络连接。", "会话已过期。")

## Workers

| Name | Session | Task | Status |
| --- | --- | --- | --- |
| iphone-install | local_480e26b0-5790-427d-ac71-c9461a5a445b | Sign and install the app on the user's iPhone | done: phone build eab3914d (53 tests passed, installed and launched; team B2U93L2LK4, `cc.romeos.mobile.dev`). First TestFlight upload: 1.0.0 (202611060248) from a clean export of `8454fb61`, 53 Mac Catalyst tests passed first, team `4YWXB26F39`, `cc.romeos.mobile`; accepted and processing per Xcode. Open: confirm in App Store Connect that processing finished |
| ios-feel-fixes | local_a0f3f229-481e-440c-9bde-fb0f72bddd0a | Feel fixes, round 1; then instance forced update | round 1 done; forced update working |
| make-english-the-ios-app | local_066dd861-f965-4eff-89db-ee9aa13d5d0c | English default, zh-Hans translation | done, merged, archived; worktree and branch removed |
