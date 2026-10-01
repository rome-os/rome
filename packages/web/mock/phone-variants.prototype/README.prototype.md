# Phone redesign prototype

Four phone layouts of the dashboard below 768px, on the real mock dashboard, switchable with `?variant=a|b|c|d`. D is the version the person picked: C without the tab bar, with chat as home and a swipe right to open the sidebar, as in the Claude mobile app. Desktop is unchanged in every variant. This is not for merge.

## Try it

```sh
env -u NODE_ENV pnpm --filter rome-web dev:mock
```

Open http://localhost:3200/chat/mock-chat-build-app?variant=d in a phone-sized window (Chrome DevTools, iPhone 12/13/14, 390×844). The dashed magenta bar at the top switches variants (‹ ›, or the arrow keys). The choice sticks across pages. `&switcher=0` hides the bar.

Re-shoot everything with the mock server running:

```sh
node packages/web/mock/capture-phone-variants.prototype.mjs packages/web/mock/phone-variants.prototype
```

`NODE_ENV=production` in the shell breaks the mock dev server, so it has to be unset.

## The variants

| | A — today | B — scaled | C — phone-native | D — C, swipe sidebar |
| --- | --- | --- | --- | --- |
| Text | controls 14px, notes 13px, title 18px | controls 16px, notes 14px, section 17px, title 20px | controls 17px, notes 15px, section 17px semibold, large title 28px bold |same as C |
| Controls | painted 28–32px, an invisible 44px tap area around them (#584) | painted 44px; xs buttons, chips and the switch (48×28) too | painted 44px, same as B |same as C |
| Navigation | menu button, slide-over sidebar | menu button, slide-over sidebar, 56px header | bottom tabs: Chat, Apps, Activity, Routines, More (More opens the sidebar). No top header outside chat; the page title heads the screen |no tab bar. `/` opens chat. A swipe right anywhere drags the sidebar out under the finger, and the page slides right under a dimming scrim. On release it opens past 35% or on a quick flick; a swipe left or a tap on the dimmed page closes it. The menu button stays as a visible fallback |
| Activity | cards with actions beside the text; filter pills scroll sideways | actions wrap under the text when it would get narrower than 12rem; pills wrap | actions stack as a full-width row; pills become a native picker |same as C |
| Routines | name and actions on one row | actions wrap under the name when needed | name on its own line; Run fills a second row with the switch and menu |same as C |
| Settings | title and a sideways tab strip | the same, scaled | `/settings` is a list of sections; each section is its own screen with a "‹ Settings" back link |same as C, with the top header kept |
| Chat | as today | scaled | no menu button; the composer sits 16px above the tab bar |as C, but the composer sits on the safe-area edge since there is no bar |

The text and control sizes are overrides of the kit's own tokens (`--text-*`, `--control-h-*`) in `mock/phone-variants.prototype.css`. The layout forks are inline `usePhoneVariant()` branches in the shell and the three pages.

## Side-by-side sheets (A | B | C | D)

Sheets are A | B | C | D. `d-swipe-half.png` freezes D's sidebar half way through a real touch swipe. `sheet-chat.png`, `sheet-activity.png`, `sheet-routines.png`, `sheet-settings.png`, `sheet-settings-connections.png`, and `sheet-nav.png` (navigation opened). The single shots are `<variant>-<route>.png`.

## Measured at 390×844 touch (`metrics.json`)

| | A | B | C | D |
| --- | --- | --- | --- | --- |
| Sideways scroll, all routes | 0 | 0 | 0 | 0 |
| Controls whose 44px reach is not their own | 0 | 0 | 0 | 0 |
| Taps on a control's own box that reach a neighbour | 0 | 0 | 0 | 0 |
| Painted control height, median (Activity / Routines) | 32 / 28px | 44 / 44px | 44 / 44px | 44 / 44px |
| Most common text size (Activity) | 13px, 62% | 14px, 62% | 15px, 61% | 15px |
| Truncated labels on Routines | 7 | 4 | 4 | 4 |
| Composer bottom vs tab bar top (chat) | — | — | 772 / 788px | — |

D's swipe, driven with real touch events (CDP `Input.dispatchTouchEvent`) at 390×844:

| Gesture | Result |
| --- | --- |
| Swipe right from mid-screen | sidebar fully open (left edge 0), page pushed 256px, no sideways scroll |
| Mostly vertical drag | scrolls; sidebar stays shut |
| Short, slow drag (50px) | snaps back shut |
| Swipe left on the open sidebar | closes |
| Tap the dimmed page | closes |
| Swipe on a sideways scroller not at its start | scrolls the scroller; sidebar stays shut |
| Swipe on a sideways scroller at its start | opens the sidebar |
| Swipe on the diagram's pan area (`touch-action: none`) | left to the diagram; sidebar stays shut |

On iOS Safari, a swipe that starts right at the left screen edge is Safari's "back" gesture, so the page never sees it. Start a little in from the edge. The Expo app's WebView has no back gesture, so there the edge works too.

C's tab labels are 11px, the only text under 13px in any variant.
