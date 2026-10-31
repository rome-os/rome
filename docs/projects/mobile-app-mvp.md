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
- [x] Install on the user's iPhone: installed and launched on Eric Liu's iPhone (iPhone 18 Pro, iOS 27.0.1), Debug build of b72cb7d8 (with English as the default language), team B2U93L2LK4, bundle id `cc.romeos.mobile.dev`. Device steps are in `ios/README.md`.
- [x] English as the default language, zh-Hans a translation: merged from `claude/epic-vaughan-1e52a1` after an independent review found no serious defects (result: [`mobile-app-mvp-english.md`](mobile-app-mvp-english.md))
- [x] Reinstall the merged build on the user's iPhone (b72cb7d8, tests passed first)
- [x] Try the app on the iPhone and list what feels off (first pass, 2026-10-31: see "Feel fixes, round 1")
- [ ] OK to push `feat/ios-app` and open a PR to `main`

## Feel fixes, round 1 (from the user's iPhone pass)

- [x] Chat top bar: drop the black bar; the bar is clear, and its three items sit on the iOS glass background (`525b6072`: Liquid Glass on iOS 26+, material before; the task chat header matches)
- [x] Drawer: a swipe on the uncovered chat area closes it; the divider no longer shakes while it closes (`4ff00a65`: the drag read the finger in the moving card's own space; it now reads screen space, and a tap also closes)
- [x] Settings: slides up from the bottom with an X at top right (no back button); opening it leaves the drawer as it is (`6f8a56ef`: a sheet over the open drawer; instances push inside it)
- [x] Task chat: no jumping while scrolling during a running turn (`24442a78`, `4f1692cd`, `f631e692`: follows the bottom only while the guardian is there, same-second rows no longer swap, older pages wait for the scroll to rest; checked on demo data and a local Rome)
- [x] Task chat: after Stop, the "Running" spinner stops (`f3c1fcbb`: the spinner follows the running turn only, the header says "Stopped", and the store re-checks active turns after the interrupt; checked on a local Rome)

Result: [`mobile-app-mvp-feel-1.md`](mobile-app-mvp-feel-1.md).

## Next

- [ ] Fix whatever the Cloud sign-in run turns up
- [ ] Open the PR; get `ios-ci` green
- [ ] TestFlight: Apple Team ID, signing, and upload steps (needs the user; nothing uploaded without a go)

## Small changes (batched)

- [ ] Login wordmark in Funnel Sans (system font today)
- [ ] Drawer "Apps", "Memory", "Activity" are not in the string catalog (English on both languages)
- [ ] Demo instance names in `DemoBackend.instances` stay Chinese on an English phone (debug only)
- [ ] Tests cover the Chinese weekly schedule text and Chinese date formats again (tests now run in English only)
- [ ] Chinese error strings keep a full stop the English dropped ("没有网络连接。", "会话已过期。")

## Workers

| Name | Session | Task | Status |
| --- | --- | --- | --- |
| iphone-install | local_480e26b0-5790-427d-ac71-c9461a5a445b | Sign and install the app on the user's iPhone | done: reinstalled b72cb7d8 after the English merge. Mac Catalyst unit tests passed on it (32 tests), `devicectl` install and launch succeeded (process running). Team B2U93L2LK4, automatic signing, `cc.romeos.mobile.dev`. Open: none |
| ios-feel-fixes | local_a0f3f229-481e-440c-9bde-fb0f72bddd0a | Feel fixes, round 1 | working |
| make-english-the-ios-app | local_066dd861-f965-4eff-89db-ee9aa13d5d0c | English default, zh-Hans translation | done, merged, archived; worktree and branch removed |
