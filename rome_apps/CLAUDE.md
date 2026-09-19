# `rome_apps/`

Each `rome_apps/<appId>/` is a runtime-loaded app (plugin), shipped first-party with Rome. They use the same app model as user-authored apps. The canonical authoring docs below are shared with the in-Rome `app_creation` skill, so the host coding agent and the in-Rome agent follow the same instructions.

## Playbook

- Before creating or scaffolding an app, read [`app_creation/SKILL.md`](coding/src/skills/app_creation/SKILL.md) — pick `$REPO`, `op: "create"`, `git init`, commit, then one-step `op: "install"` with `source: { mode: "source", path: $REPO }`.
- Before deciding *what* to build or *when* to ship, read [`app_creation/AUTHORING.md`](coding/src/skills/app_creation/AUTHORING.md) — the iteration loop, product-design rules, frontend and icon guidelines, the recurring-run pattern, boundaries, validation, and the delivery checklist.
- When you need a file-level API — `app.yaml`, `action.yaml`, agent yaml fields, the `@rome-os/app-runtime` and `@rome-os/app-web-sdk` surfaces, the on-disk layout, the `rome` CLI, storage and UI rules — read [`app_creation/REFERENCE.md`](coding/src/skills/app_creation/REFERENCE.md).
- After editing an installed app's skills or actions, repack and reinstall it. Hot-reload covers `packages/core` only.

## Traps

**An app that paints `--background` cuts a hole in the surface it was mounted on.** Every container the host gives an app — a widget beside a chat, the embedded page at `/apps/:id`, the full-screen host — is a pane on `--surface`. `--background` is the canvas the shell keeps around those panes, so an app root or section that paints it renders a block of canvas colour inside the pane. An app's own root sits on `--surface` and needs no fill of its own; a region that has to recess takes `--surface-muted`. The depth model is in [`docs/ui/semantic-token/surfaces.md`](../docs/ui/semantic-token/surfaces.md).

**An app that reads a host CSS variable it never compiled renders correctly here and nowhere else.** The host mounts each app's web bundle in a Shadow DOM, and custom properties inherit across that boundary. Inheritance cannot be narrowed, so an app reaches every name the dashboard declares on `:root`, not only the ones meant for it. The promise is the theme layer alone — color and shadow values, which track the live theme and mode. Geometry, typography, and the control scale hold the same value under every theme, and the app's own `@import "@rome-os/app-web-sdk/styles"` is what puts them in its bundle. An app that skips that import still looks right in the dashboard, because it is borrowing the dashboard's declarations. Declare the few constants it uses in its own `:host` block instead. `packages/web/src/styles/app-token-contract.test.ts` fails on a `var()` an app cannot resolve from its own CSS, an imported sheet, or the theme contract. Apps authored outside this repo never run it, so the rule also lives in [`app_creation/REFERENCE.md` → Styling](coding/src/skills/app_creation/REFERENCE.md#styling).

**Floating UI escapes the app's Shadow DOM and silently loses its styles.** The host (`packages/web` → `rome-app-host`) mounts each app's web bundle in a Shadow DOM and injects the app's compiled CSS into that shadow root, and CSS in a shadow root only styles nodes inside it. Anything built on a Radix `Portal` — dialog, popover, tooltip, dropdown-menu, select, toast, hover-card, context-menu — defaults to portaling into `document.body`, outside the shadow root. There it picks up only whatever utility classes the host dashboard happened to compile and drops the rest, so the layout looks subtly broken (collapsed spacing, wrong radii) while typecheck, unit tests, and `rome build` all pass. Only a browser catches it.

Every portal-based component passes the SDK-provided container:

```tsx
import { getPortalContainer } from "@rome-os/app-web-sdk";

<DialogPrimitive.Portal container={getPortalContainer()}>…</DialogPrimitive.Portal>
// same for PopoverPrimitive.Portal, TooltipPrimitive.Portal, SelectPrimitive.Portal, …
```

`getPortalContainer()` returns the app's shadow root, so the portal renders back inside the app's styles while still floating above everything. It returns `undefined` before mount (tests, SSR), where the library's `document.body` default is correct, so it is always safe to pass. Kit components (`@rome-os/ui`) resolve that container themselves, so importing one is already correct. The rule bites for app-authored floating UI, including a shadcn or Radix recipe copied into `components/ui/` because the kit does not publish that primitive. In dev the SDK warns (`[rome-app] A pop-up … rendered into document.body …`) when a floating layer escapes — treat that warning as a bug.
