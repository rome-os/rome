# Mobile App MVP: instance always on the latest release

Worker result for "Instance always on the latest version" in [`mobile-app-mvp.md`](mobile-app-mvp.md). The decision came from the user: the app always requires the instance's latest release. The instance API stays backward compatible, so the app's and the instance's versions never need to match.

- Branch: `feat/ios-app` (local only, not pushed)
- Commits: `1e0d7f18` (API calls and demo data), `4cef5d7d` (decision and upgrade tracking), `588bd463` (update page and wiring), `8868c7e5` (snapshots), plus the commit that adds this file

## What changed

- **When it checks.** The app calls `GET /api/system/upgrade/check` at these times:
  - each time an instance opens: on launch, after sign-in, and after an instance switch;
  - when the app returns to the foreground.
- **When it blocks.** It blocks only when `upgradeAvailable` is true and the latest version differs from the current one. The page covers everything, the sign-in screen included. It shows current → latest and one primary "Update now". There is no dismiss or skip. A menu on the instance name keeps "Switch instance" and "Sign out".
- **When it does not block.** A check that cannot decide never blocks: `unversioned_build`, `pantheon_unconfigured`, `pantheon_unreachable`, any other server error, or no network. The app works as usual, and Settings shows a quiet "Can't check for updates" line under the Version row.
- **Updating.**
  - "Update now" sends `POST /api/system/upgrade {target: latest}`.
  - On `409 target_not_latest` the app checks again. It shows the new latest with "A newer release just came out" and waits for the guardian to confirm again.
  - Once Rome Cloud accepts, the page says "Updating to X…" and that the guardian can leave the app. The app polls `GET /api/build-info` every 5 seconds. Failed requests while the instance restarts are expected.
  - When the version equals the target, the app opens the instance fresh, so Chat, Tasks and the live socket all come from the new process.
  - After 40 minutes it shows "The update is taking too long" with Try again. Try again checks once more:
    - instance up to date → open it;
    - still behind → the update page again;
    - instance still unreachable → wait again.
- **Resuming.** The app remembers the target and start time for each instance, so a relaunch mid-upgrade goes straight back to waiting. If Rome Cloud reports the instance as not running at launch (it is mid-restart), the page keeps waiting and tries to open the instance on each poll. I did not use the status snapshot route: it reports the separate countdown cutover, not the upgrade that `POST /system/upgrade` starts.
- **Code.** `UpdateGate` in `Rome/Features/Update/InstanceUpdater.swift` holds the rules as pure functions, and `InstanceUpdater` holds the state. `AppModel` owns the updater, and `RootView` shows `UpdateScreen` over everything while it blocks.
- **Demo data.** `ROME_DEMO=update` opens the demo on a Rome one release behind (0.41.3 → 0.42.0). The demo instance comes back on the new release about 8 seconds after "Update now". New snapshot names: `20-update-required`, `21-update-updating`, `22-update-failed`.
- **Docs.** `ios/CLAUDE.md` gained a playbook line: the app always requires the instance's latest release, relies on the instance API staying backward compatible, and never pins an instance version. `ios/README.md` lists `ROME_DEMO=update`.
- **Strings.** 13 new English keys, each with zh-Hans.

## What was checked

- **Unit tests:** 45 pass on the iPhone 17 simulator (iOS 27.2); the live tests were skipped. New tests:
  - `UpdateGateTests` covers four rules:
    - It blocks only on a newer release, and never when the flag says yes but the versions match.
    - Each "cannot decide" error and a network failure never block.
    - Polling ends only on the target or at the timeout.
    - The `target_not_latest` refusal is recognized.
  - `InstanceUpdaterTests` covers four flows:
    - `unversioned_build` does not block.
    - Behind → Update now → waiting → the target answers → done, and the remembered target is cleared.
    - A newer release asks again.
    - A relaunch with a remembered target resumes waiting.
- **Simulator, demo data:**
  - The page shows on launch. Update now leads to waiting and then a working Chat.
  - A relaunch mid-upgrade goes back to waiting.
  - The account menu and the Switch instance sheet work, in dark mode too.
- **Local Rome** (throwaway profile `ios-update-test`, deleted afterwards): the check answered `503 unversioned_build`, the app opened Chat without blocking, and Settings showed "Can't check for updates".
- **Catalyst snapshots:** the three new screens, light and dark.

Screenshots are in the shared notes folder, outside the repo: `forced-update-snapshots.png`.

Not checked:
- A real Rome Cloud upgrade: `POST /system/upgrade`, the restart, the 40-minute window, and a 409 from Rome Cloud. The demo and the unit tests stand in for them.
- Whether Rome Cloud reports an instance as not running during the restart. The app handles both cases.

## Open questions

- Chat shows for a moment (one check round trip) before the update page covers it on a behind instance. Holding Chat back until the check answers would delay every launch, and the check can take up to 15 seconds when Rome Cloud is slow. I left it as it is.
- `upgradeAvailable` comes from Rome Cloud. If Rome Cloud ever says yes for a release this device cannot reach, the guardian is blocked until it can. This is by design ("never skip"), but worth knowing.
