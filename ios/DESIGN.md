# iOS interface principles

The rules every screen of the iOS app follows. Each one names the rule and gives the case where it bit. A change to a screen is checked against these before it ships. Copy follows [`docs/ui/VOICE.md`](../docs/ui/VOICE.md), and whether a piece of secondary text exists at all follows [`docs/ui/secondary-text.md`](../docs/ui/secondary-text.md).

## 1. Layers stay distinct

Two surfaces that overlap never share a color, so the guardian can tell at a glance which one is on top.

Example: when the drawer opens, the page behind it takes a deeper tone than the drawer. Bubbles, the composer and the page background are three different colors.

## 2. Native iOS behavior wins

Where iOS has a standard way to do something, the app uses it, so nothing has to be learned twice: sheets, switches, the per-app language setting, gestures and haptics.

Example: Settings and an app are sheets (rule 12), a setting that turns on and off is a switch, the language changes in iOS Settings, and lists have no pull-to-refresh.

## 3. One emphasis per view

A view stresses one thing and quiets the rest. Tone and background carry hierarchy, not bold or decoration.

Example: the selected row gets a highlight, not bold text. A secondary control such as the drawer's `+` is light and thin. Page titles are small and sit on no pill.

## 4. Same kind, same look, same line

Elements of one kind look the same on every screen and line up the same way.

Text around a card (section headers, footers, status lines) aligns with the card's content inset, as in iOS inset-grouped lists.

Example: every page uses the same header row. A section header starts where its card's row text does. Every control floating over content (header buttons, composer, back-to-bottom) uses the same glass.

## 5. Glass looks like glass

Floating controls stay translucent, so the content behind them shows through. Their own text and icons stay clear, but the surface is never made solid to hide what is behind it.

## 6. Stable content, touch first

Content never jumps or flashes. Motion lands exactly on its target, with no overshoot. A finger always wins over a running animation or glide.

Example: the first frame after opening a chat is already the final position. A touch stops a glide at once. Back-to-bottom stops at the bottom without bouncing.

## 7. A new context drops the old focus

Moving to another context clears temporary state, such as the keyboard or an open menu, so nothing carries over.

Example: opening the drawer, going back and opening a sheet all dismiss the keyboard.

## 8. Content first, then refresh

What can be shown at once is shown at once, and fresh data follows in the background. A place the guardian visits often never shows a spinner or a blank page.

Example: chats and the Apps list show their cached content first. App icons are cached on disk, so a relaunch does not reload them.

## 9. Show only what the person can use, and a way out for the rest

A control the person has no right to use is hidden, not refused after a tap. What the phone cannot do yet points to where it can be done, and never disappears silently.

Example: a visitor sees no owner settings. A card the phone cannot draw yet opens that chat on the web.

## 10. Keep the interface simple

No text explains what the screen already shows. A label names a thing once, and a screen adds a line of text only when the guardian needs a fact they cannot see.

Example: the opening screen shows the mascot and "Rome" with no caption, and a page header is its title alone.

## 11. Width decides the layout

A screen adapts to the width it gets, not to the device, so an iPad window of any size and a phone follow the same rules. A conversation never runs wider than one readable column.

Example: on a wide iPad window the drawer is pinned beside the page; narrowed in Split View, it slides out as on a phone, and the open chat stays as it was. Messages, cards and the composer stay in a centered column of 720 pt at most.

## 12. Second-level pages rise as sheets

Chat and Apps are first-level pages: the drawer switches between them, and they sit on the page background. Everything that covers them is a second-level page: Settings, an app, a dashboard page. A second-level page opens from the bottom as a sheet, with rounded top corners, and closes with a drag down or its close button. An app's sheet is the exception: it has no grabber and closes only with its close button, since the app's own page may use a vertical drag. A page opened from inside it, such as Apple Health or iPhone use from Settings, pushes in from the side within the same sheet, and Back returns to the page under it.

A second-level page has its own background, `Palette.secondaryPage`, and its cards use `Palette.secondaryCard` (an icon tile or a track inside one, `Palette.secondaryFill`). In dark it is a gray a step above the black first level, so the sheet's top edge reads against the page behind it; in light it is a light gray, so white cards stand out. Paint a second-level page with `secondaryPageBackground()`, which also gives its header's fade the same color. A small sheet that holds one task at medium height (feedback, sharing, a tool's detail) is not a page: it keeps `Palette.sheet`. A second-level page's header title is 17 pt semibold, a step above the 15 pt of a chat's header.

Example: an app opens from Apps in a sheet over the grid, not pushed over it. In Settings, the Apple Health row pushes the Apple Health page inside the sheet, and the X closes both.
