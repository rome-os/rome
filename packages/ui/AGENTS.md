# `@rome-os/ui`

The shared React component kit, published to npm. Consumers reach every JS and TS export through `dist/`, which `tsc` produces and git does not track. The stylesheets (`./styles.css`, `./markdown.css`) are the only exports pointing at `src/`.

## Playbook

- Before changing exports, dependencies, or a component's stylesheet, read [`docs/ui-kit.md`](../../docs/ui-kit.md).
- Before touching token wiring or `src/styles.css`, read [`docs/design-system.md`](../../docs/design-system.md).
- After editing a `.ts` or `.tsx` file here, run `pnpm --filter @rome-os/ui build` before trusting a consumer's test run.

## Traps

**A `.ts` or `.tsx` edit here is invisible to consumers until the kit is rebuilt.** Every JS and TS entry in `exports` targets `dist/` — the barrel, each component subpath, and `./cn`. Only `pnpm install`'s `prepare` and an explicit build refresh it, and nothing in `packages/web`'s dev server or test script does. A stale `dist/` surfaces as a behavioral bug in the consumer with no matching cause in the source — the symptom that sent us hunting for a phantom `tailwind-merge` 2.x pin was web's radius-merge tests failing against a `dist/cn.js` built before the numbered radius scale was registered.

**A custom typography role merges correctly only once `TYPOGRAPHY_ROLES` lists it, and the list must match the stylesheet exactly.** The merger knows Tailwind's stock font-size scale and nothing else, so an unregistered role classifies as a text *color* and a caller's color utility deletes it, leaving the element at inherited typography. The reverse is slower: a name left in the list after the stylesheet drops it keeps claiming the font-size group, so reusing that name as a color token lets two conflicting colors survive a merge. Neither direction produces a build or type error. `src/typography-roles.ts` holds the one list and `cn.ts` feeds it to the merger, so edit the stylesheet and the list in the same commit — `src/cn.test.ts` and `src/typography-roles.test.ts` assert set equality against it.

**The floating family's Radix versions are pinned exactly, and they move together.** `react-dialog`, `react-dropdown-menu`, `react-popover`, `react-select`, `react-tooltip`, and `react-context-menu` each pin `@radix-ui/react-dismissable-layer` to an exact version, and that package keeps the open-layer registry plus the saved `document.body.style.pointerEvents` in module scope. Let the `^` ranges drift apart and a menu and a dialog end up on two copies of it, after which a dialog opened from a menu restores the body style the other copy saved (`none`) and the whole page stops taking clicks. Bump all six in one commit, to versions whose `react-dismissable-layer` pin agrees (check `node_modules/.pnpm/@radix-ui+react-*/…/package.json`), and re-run `packages/web`'s suite, where the menu-to-dialog flows are what catch it. `packages/web` declares `react-dialog` directly for the file-browser action sheet — keep it on the same version.

**`tailwind-merge` stays on 3.x.** v2 knows only Tailwind 3 utilities, so on our Tailwind 4 hosts it leaves conflicting pairs both intact. The winner then falls out of CSS order instead of the caller's last-wins intent, silently breaking the override contract every component depends on. `src/cn.test.ts` pins the cases. `packages/web` and the app scaffold re-export `cn` from here, so no older merger remains to align back to.
