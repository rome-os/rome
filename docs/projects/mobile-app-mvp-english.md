# Mobile App MVP: English as the default language

Worker result for the localization task in [`mobile-app-mvp.md`](mobile-app-mvp.md). The iOS app in `ios/` shows English by default and Simplified Chinese on a Chinese system.

- Branch: `claude/epic-vaughan-1e52a1`, cut from `feat/ios-app` at `f13d07d3` (local only, not pushed)
- Commits: `877ea20c` (the change), plus the commit that adds this file

## What changed

- **Source language.** Every UI string in Swift is English source text. `ios/Rome/Localizable.xcstrings` holds 165 keys, each with zh-Hans text equal to the Chinese the app showed before. The project's `developmentRegion` is `en` (known regions `en`, `zh-Hans`, `Base`), so a phone in any other language gets English.
- **Strings built in code.** `TaskTone.label`, `TaskGroupKey.title`, the Tasks row meta, `RelativeTime`, `RoutineText`, `UsageRow` reset text, `APIError` and `AuthError` descriptions, `displayActionName`'s fallback, the approval "Channel" field, and accessibility labels and hints all go through `String(localized:)`. Counts have English plural forms in the catalog ("1 minute ago", "10 minutes ago").
- **Dates.** Weekdays and month-day dates come from `Date.FormatStyle` in the app's language with the guardian's region: "Mon" and "Oct 27" in English, "周一" and "10月27日" in Chinese. Times stay 24-hour `HH:mm` in both.
- **View parameters.** Shared views whose text callers pass as literals (`PageHeader`, `PrimaryButton`, `SecondaryButton`, `CenteredMessage`, `SettingsGroup`, `SettingsRow`, `Composer`, `GlassCircleButton`) take `LocalizedStringKey`. `TopBanner` and `StatusPill` keep `String`, because they also show server text.
- **Wording.** English follows `docs/ui/VOICE.md`. Task words come from the web dashboard's `concierge` strings: Needs you, Working, Doing, Up next, Watching, Done, Show full text, Show less, Show N older, Not synced. Errors use the economical setting: no terminal period, as in "Could not reach your Rome".
- **Demo data.** Sample messages and task titles in `Rome/Demo/DemoBackend.swift` stay in Chinese. The demo instance name is "My Rome" / "我的 Rome".
- **Tests.** The scheme runs tests in English with the US region. Tests that checked Chinese text now check English. New `LocalizationTests` cover four things: every catalog key has translated zh-Hans text with the same `%@` and `%lld` placeholders, the built app's `zh-Hans.lproj` resolves a key and a plural, and English plurals pick the singular form.
- **Docs.** `ios/CLAUDE.md` has a playbook line on adding text, and a trap: a literal is looked up only where Swift types it as `LocalizedStringKey` or `String(localized:)`. `ios/README.md` shows how to capture snapshots in one language with `-AppleLanguages "(zh-Hans)"`, and notes that tests run in English.

## What was checked

- `xcodebuild test` on Mac Catalyst: 32 tests in 9 suites pass, and the 2 live tests skip without a local Rome.
- The scheme's test language is honored. With the scheme set to zh-Hans for one run, the English `RelativeTime` tests failed because the functions returned Chinese. The scheme is back on `en`.
- Every key the compiler extracts from the app (`xcstringstool sync` against the build's `.stringsdata`) is in the catalog with zh-Hans, and the catalog has no unused key.
- The full snapshot pass ran twice, with `-AppleLanguages "(en)"` and `"(zh-Hans)"`: 19 screens in light and dark each. Two English layouts wrapped and were shortened. The web-only card now reads "Shown only on the web", and the routine schedule reads "Daily 09:00 · Next: Tomorrow 08:00". Both screens were captured again after the fix.

Screenshots are in the shared notes folder, outside the repo: `english-snapshots/en/`, `english-snapshots/zh-Hans/`, and side-by-side sheets `s1.png`–`s10.png` (English left, Chinese right, light mode) plus `fix.png` (the two fixed screens).

Not checked: a run on an iPhone simulator or a device in each language. Mac Catalyst uses the same bundle and catalog.

## Open questions

- Two zh-Hans strings are shared by an error and a heading, so they keep one punctuation form. "Concierge is off" reads "Concierge 未开启" and "Could not reach your Rome" reads "连接不上你的 Rome", without the "。" that the `APIError` versions had.
- The Chinese copy is unchanged. Some of it does not follow `VOICE.md`'s economical setting, for example error text with a terminal "。". That would be a separate change.
- An Xcode build in the IDE may re-sort the catalog or add `extractionState` fields. That is expected and safe to commit.
