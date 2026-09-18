---
name: app-lifecycle
description: Install, reinstall, uninstall, enable, or disable Rome apps, including deployment after app edits and the first-party build and restart procedure.
---

# App lifecycle

Read `system:app_management` with `read_action` before calling it through `execute_action`. For new app scaffolding, also read `coding:app_creation`.

## Install or reinstall a standalone app

Use this path for a custom app under `~/.rome/<profile>/projects/apps/<id>/` or another standalone checkout outside the Rome monorepo.

1. Call `system:app_management` with the app repository as the source:

   ```json
   {
     "op": "install",
     "source": { "mode": "source", "path": "<absolute app repo path>" }
   }
   ```

2. Pass the same source object on every reinstall after edits. The daemon rebuilds and repacks each time.
3. After the call succeeds, validate the app immediately. Do not poll deployment files or the `active` symlink.

The daemon derives the app ID from `app.yaml`, runs the workspace's build, and packs it into `<repo>/.rome/artifact`. It installs the bundle and awaits the runtime reload before returning. The guardian can also use Install/Upgrade on the Apps dashboard.

The `bundle` source mode accepts an already-packed artifact, not a raw source workspace. A raw workspace fails with "not a packed artifact".

For a Rome App Store install, discover the listing with `system:app_store_search` and follow the `appstore` source schema in `system:app_management`.

## First-party apps

First-party apps under the monorepo's `rome_apps/<appId>/` ship with Rome. The action cannot install or uninstall them. Only enable/disable applies through the action.

1. After editing a first-party app, run `pnpm build:apps` in the Rome monorepo to build and pack the artifacts.
2. Restart Rome to load the changes. Boot installs the packed artifacts and reinstalls an app when its artifact hash changes.
3. Validate the app after startup completes.

Do not pass a monorepo member as a `source` install. The daemon refuses to run pnpm in it. Do not bypass that protection by passing a raw source workspace as a `bundle`.

## Uninstall a custom app

Call `system:app_management` with:

```json
{ "op": "uninstall", "appId": "<app id>", "purge": false }
```

The default, `purge: false`, removes the lockfile entry and installed bundle but keeps the app's database tables and data. Reinstalling restores access to that state.

Use `purge: true` only when the guardian requests deletion of the app's data as well. It drops the app's tables and data directory.

## Enable or disable an app

Call `system:app_management` with:

```json
{ "op": "set_enabled", "appId": "<app id>", "enabled": false }
```

Use `enabled: true` to enable the app. This does not reinstall it. The manager updates the lockfile and awaits the catalog subscribers before returning.

## Runtime guarantees

- `AppManager` is the sole writer of `~/.rome/<profile>/apps.lock.json`. Each lifecycle operation runs to a terminal state.
- Install activates a content-addressed bundle atomically, records its `installedHash`, and awaits the catalog subscriber chain that reloads runtime artifacts.
- The `pnpm app:*` CLI sends HTTP requests to the running main process. It uses the same manager, not a separate lifecycle path.
- At startup, Rome probes each installed lockfile entry against its active bundle. It marks non-system failures broken and replays catalog events to load the runtime.
