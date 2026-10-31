# Mobile App MVP: feel fixes, round 1

Worker result for "Feel fixes, round 1" in [`mobile-app-mvp.md`](mobile-app-mvp.md). It fixes the five things the user found on their iPhone in the iOS app in `ios/`.

- Branch: `feat/ios-app` (local only, not pushed)
- Commits: `525b6072` (top bar), `4ff00a65` (drawer), `6f8a56ef` (Settings), `24442a78`, `4f1692cd`, `f631e692` (task chat scrolling), `f3c1fcbb` (Stop), plus the commit that adds this file

## What changed

1. **Clear top bar.** The Chat and task chat headers no longer sit on a solid bar. They float over the transcript, which scrolls under them with a soft edge. The drawer button, the title and the Tasks button each sit on their own glass: Liquid Glass (`glassEffect`) on iOS 26 and later, `.ultraThinMaterial` with a hairline before that. The task chat's back, title and "more" items match. The shared pieces are `glassSurface(_:interactive:)`, `floatingTopBar` and `softTopScrollEdge()` in `Rome/Design/Components.swift`.
2. **Drawer.** While the drawer is open, a sideways drag anywhere closes it and follows the finger, and a tap on the uncovered chat closes it too. The old close drag read the finger in the chat card's own space while the card moved under it. The motion fed back into itself, so a swipe barely moved the drawer and its edge shook. Drags now read in screen space, lock to the axis they start on (a vertical scroll never moves the drawer), and spring back if the system cancels them.
3. **Settings as a sheet.** The account row in the drawer opens Settings as a sheet that slides up from the bottom, with an X at top right and no back button. The instances page pushes inside the sheet and has a back button. The drawer stays open under the sheet, so opening and closing Settings are one motion each, and closing it returns to the open drawer. Switching instances closes the sheet. `Route.settings` and `Route.instances` are gone; the sheet has its own `SettingsRoute`.
4. **Task chat scrolling.** I found four causes:
   - The list decided it was at the bottom from a 1 pt marker under the last row. The lazy stack keeps that marker alive off screen, so after the guardian scrolled up, each new reply pulled them back down. On iOS 18 and later the list now follows the bottom only while the guardian is there. A drag turns following off, coming to rest at the bottom turns it on again, and otherwise the rows in view stay still (`defaultScrollAnchor(_:for: .sizeChanges)`). A "New messages" pill brings them back down. iOS 17 keeps the old marker behavior.
   - Message times are whole seconds, and the store sorted by time alone from a dictionary. Rows written in the same second came out in a random order and could swap places on every reload while a turn ran. The store now orders like the server: a turn's rows together, turns by when they started, then time, with same-second rows in the order first received.
   - An older page could land under a moving finger and push the rows in view down. It now waits until the scroll is at rest. A reload no longer resets the pages already loaded, so the spinner at the top doesn't come back. The brief card waits for the oldest page instead of putting the brief style on a later message.
   - Row insert animations and the running-line animation moved the whole list. They are gone.
5. **Stop.** The header spinner ran whenever the task was in its "doing" state, so it kept spinning after a stopped turn. It now runs only while the chat runs a turn. After Stop the header says "Stopped" with a still dot, and a task between turns shows a still dot. If no socket event arrives after `POST /chat/turns/:id/interrupt`, the store asks for the active turns at 0.5, 1, 2 and 4 seconds until the turn is gone, then reloads.

Demo data: a reply in a demo task chat now streams seven messages of mixed length, which Stop can end early. Demo pages now come back newest-first with a cursor, as the server's do. This lets scrolling during a running turn be tried without a server.

## What was checked

- **Unit tests:** 35 pass on the iPhone 17 simulator (iOS 27.2). The live tests were skipped. New `TranscriptStoreTests` cover these cases: the older page waits until it is placed, a reload keeps loaded pages, the brief waits for the oldest page, same-second rows keep the server's order across reloads, and Stop ends running with no live event. The last two fail on the old code.
- **Simulator, demo data, real gestures**, light and dark, with screen recordings measured frame by frame:
  - Top bar: the transcript scrolls under the glass items.
  - Drawer: an edge drag opens it, and a drag on the chat closes it. The drawer edge tracks the finger and settles with no reversal. A tap on the chat also closes it, and a swipe that starts low on the chat closes it too.
  - Settings: it slides up over the open drawer. Back works on the instances page, and the X closes the sheet to the open drawer.
  - Task chat: replies push up from the bottom while I stay there. When I scroll up and hold, the view doesn't move while replies arrive, and the pill shows. When I drag back and forth during arrivals, the view moves only with the finger. An older page placed during a slow drag to the top didn't move the view.
- **Local Rome** (`ROME_PROFILE=ios-feel-test`, a throwaway profile and test guardian, removed afterwards; never `~/.rome/default`). The Concierge started a real task. In its task chat, an 8-round turn streamed replies while I scrolled, with the same results as the demo. A 20-round turn stopped with Stop: the server logged the interrupt, `/turns` came back empty, and the header changed from "Running" to "Stopped" with no spinner.
- **Catalyst snapshot pass** for Chat, the drawer, a running task chat, Settings and the instances page, light and dark.

Screenshots are in the shared notes folder, outside the repo, under `feel-1/`.

Not checked:
- The iOS 17–25 fallbacks (material instead of Liquid Glass, and the scroll behavior before iOS 18) ran on no device or simulator, because only iOS 27 runtimes are installed. They compile, and the material path is the same code the app used before.
- The user's phone. The lead installs it.

## Open questions

- In the Tasks sheet on the local Rome, the Concierge's task showed "No tasks yet" while its task chat existed. This is outside this round and not investigated.
- The server orders a task's posted messages (from `send_message`, with no turn id) after the turn's own final reply when that reply started earlier. The app now shows the same order as the server and the web, so a summary like "All 15 steps were posted" can sit above the steps. This is a server ordering question, not an app one.
