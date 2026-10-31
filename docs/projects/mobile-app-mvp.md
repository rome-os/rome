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
- [ ] Install on the user's iPhone (in progress: worker `iphone-install`). The user chose team B2U93L2LK4 and signs in to Xcode → Settings → Accounts themselves first.
- [ ] Start the English localization worker (card proposed: English is the default language, zh-Hans a translation)
- [ ] Try the app on the simulator and list what feels off (keyboard, drawer swipe, Tasks sheet drag, motion)
- [ ] OK to push `feat/ios-app` and open a PR to `main`

## Next

- [ ] Fix whatever the Cloud sign-in run turns up
- [ ] Fix the feel issues from the user's simulator pass
- [ ] Open the PR; get `ios-ci` green
- [ ] TestFlight: Apple Team ID, signing, and upload steps (needs the user; nothing uploaded without a go)

## Small changes (batched)

- [ ] Login wordmark in Funnel Sans (system font today)

## Workers

| Name | Session | Task | Status |
| --- | --- | --- | --- |
| iphone-install | local_480e26b0-5790-427d-ac71-c9461a5a445b | Sign and install the app on the user's iPhone | running |
