# iOS interface principles

The rules every screen of the iOS app follows. Each one names the rule and gives the case where it bit. A change to a screen is checked against these before it ships. Copy follows [`docs/ui/VOICE.md`](../docs/ui/VOICE.md), and whether a piece of secondary text exists at all follows [`docs/ui/secondary-text.md`](../docs/ui/secondary-text.md).

## 1. Layers stay distinct

Two surfaces that overlap never share a color, so the guardian can tell at a glance which one is on top.

Example: when the drawer opens, the page behind it takes a deeper tone than the drawer. Bubbles, the composer and the page background are three different colors.

## 2. Native iOS behavior wins

Where iOS has a standard way to do something, the app uses it, so nothing has to be learned twice: sheets, switches, the per-app language setting, gestures and haptics.

Example: Settings is a sheet, a setting that turns on and off is a switch, the language changes in iOS Settings, and lists have no pull-to-refresh.

## 3. One emphasis per view

A view stresses one thing and quiets the rest. Tone and background carry hierarchy, not bold or decoration.

Example: the selected row gets a highlight, not bold text. A secondary control such as the drawer's `+` is light and thin. Page titles are small and sit on no pill.

## 4. Same kind, same look, same line

Elements of one kind look the same on every screen and line up the same way.

Example: every page uses the same header row. Section titles align with the card edge. Every control floating over content (header buttons, composer, back-to-bottom) uses the same glass.

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
