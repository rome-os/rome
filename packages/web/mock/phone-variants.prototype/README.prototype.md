# Phone redesign prototype

Three phone layouts of the dashboard below 768px, on the real mock dashboard, switchable with `?variant=a|b|c`. Desktop is unchanged in every variant. This is not for merge.

## Try it

```sh
env -u NODE_ENV pnpm --filter rome-web dev:mock
```

Open http://localhost:3200/chat/mock-chat-build-app?variant=b in a phone-sized window (Chrome DevTools, iPhone 12/13/14, 390×844). The dashed magenta bar at the top switches variants (‹ ›, or the arrow keys). The choice sticks across pages. `&switcher=0` hides the bar.

Re-shoot everything with the mock server running:

```sh
node packages/web/mock/capture-phone-variants.prototype.mjs packages/web/mock/phone-variants.prototype
```

`NODE_ENV=production` in the shell breaks the mock dev server, so it has to be unset.

## The variants

| | A — today | B — scaled | C — phone-native |
| --- | --- | --- | --- |
| Text | controls 14px, notes 13px, title 18px | controls 16px, notes 14px, section 17px, title 20px | controls 17px, notes 15px, section 17px semibold, large title 28px bold |
| Controls | painted 28–32px, an invisible 44px tap area around them (#584) | painted 44px; xs buttons, chips and the switch (48×28) too | painted 44px, same as B |
| Navigation | menu button, slide-over sidebar | menu button, slide-over sidebar, 56px header | bottom tabs: Chat, Apps, Activity, Routines, More (More opens the sidebar). No top header outside chat; the page title heads the screen |
| Activity | cards with actions beside the text; filter pills scroll sideways | actions wrap under the text when it would get narrower than 12rem; pills wrap | actions stack as a full-width row; pills become a native picker |
| Routines | name and actions on one row | actions wrap under the name when needed | name on its own line; Run fills a second row with the switch and menu |
| Settings | title and a sideways tab strip | the same, scaled | `/settings` is a list of sections; each section is its own screen with a "‹ Settings" back link |
| Chat | as today | scaled | no menu button; the composer sits 16px above the tab bar |

The text and control sizes are overrides of the kit's own tokens (`--text-*`, `--control-h-*`) in `mock/phone-variants.prototype.css`. The layout forks are inline `usePhoneVariant()` branches in the shell and the three pages.

## Side-by-side sheets (A | B | C)

`sheet-chat.png`, `sheet-activity.png`, `sheet-routines.png`, `sheet-settings.png`, `sheet-settings-connections.png`, and `sheet-nav.png` (navigation opened). The single shots are `<variant>-<route>.png`.

## Measured at 390×844 touch (`metrics.json`)

| | A | B | C |
| --- | --- | --- | --- |
| Sideways scroll, all routes | 0 | 0 | 0 |
| Controls whose 44px reach is not their own | 0 | 0 | 0 |
| Taps on a control's own box that reach a neighbour | 0 | 0 | 0 |
| Painted control height, median (Activity / Routines) | 32 / 28px | 44 / 44px | 44 / 44px |
| Most common text size (Activity) | 13px, 62% | 14px, 62% | 15px, 61% |
| Truncated labels on Routines | 7 | 4 | 4 |
| Composer bottom vs tab bar top (chat) | — | — | 772 / 788px |

C's tab labels are 11px, the only text under 13px in any variant.
