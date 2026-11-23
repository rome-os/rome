# `@rome-os/app-web-sdk`

The web runtime SDK apps import, plus the `rome` CLI (`bin/rome.js` → `src/cli/`): `dev` and `build` for the app web bundle, and the Rome App Store commands `login`, `whoami`, and `publish` under `src/cli/store/`.

## Styling contract

Color and shadow values vary with theme and mode. The host owns them, and an app inherits them across the shadow boundary. [`@rome-os/ui/styles.css`](../ui/src/styles.css) holds the full list: the names its `@theme inline` block reads but never declares.

Everything else is local. The app's own bundle supplies it, through the imports in [`src/runtime/styles.css`](src/runtime/styles.css).

`@rome-os/ui` is an **optional peer**, not a dependency. The app declares the kit, so the components it imports and the canon that dresses them resolve to the same install — a version skew between the two cannot arise. Optional, because an app can use the SDK runtime and never import its stylesheet. An app that does import it and omits the kit fails to resolve `@rome-os/ui/styles.css`, which is the loud version of the skew it replaces.

## Traps

**The store commands talk to a service, and the user-facing name is the store.** CLI output, help text, and docs say "Rome App Store", never the name of the service hosting it. Nothing checks this.
