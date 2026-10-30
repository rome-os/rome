# Web Startup

What the dashboard downloads and requests before its first screen, and the rules that keep that small. The browser reaches the dashboard through the [edge](access-control.md#request-flow), which serves the built files straight from disk, so everything here is decided when the bundle is built or when the entry runs.

```
index.html ─► entry chunks ─► renderApp ─► i18n ready ─► React render
   │                              ├─► auth probe + settings
   ├─► language chunk preload     └─► chat route chunk + session reads
   └─► (chat address) chat route
        chunks preload, after entry
```

## First screen

The first screen is the scripts `index.html` loads: React, the router, the shared vendor chunk and the entry chunk. They hold the shell (sidebar, auth gate, toasts) and nothing a route needs. Every route is a lazy chunk, `/chat` included. `scripts/check-web-bundle-budget.mjs` measures the first screen on a finished build and fails CI when its gzip size passes the budget, or when it contains shiki, mermaid, katex, monaco or noVNC.

## Invariants

- A route's code stays out of the entry chunk. A static import of a page, widget or library that only one route uses moves it back into the first screen, and the budget check fails.
- A lazy chunk that fails to load reloads the page once for the new `index.html` (a deploy replaced the hashed file), then shows a reload screen. `lazyWithReload` and `ChunkErrorBoundary` own that. Any other error passes through to the next boundary.
- Nothing renders translated text before the active language has loaded. `renderApp` waits for `i18nReady`. The English and Chinese resources are separate chunks, and the visitor downloads only the one they use plus the English fallback. Tests and Storybook register both up front through `i18n/register-all-locales.ts`, which keeps `t()` synchronous there.
- The auth gate paints a neutral skeleton while the probe is pending. The skeleton names no page, link or count, so a signed-out visitor sees nothing of the app before the redirect to sign-in.
- Fonts are served from the dashboard's own origin (`src/fonts.css`, licences in `public/fonts/LICENSES.txt`). The body face is preloaded from the HTML. No page loads a stylesheet or font from a third-party host.

## Entry prefetch

`renderApp` starts the work the first screen needs before React renders, so it overlaps the language download:

- The auth probe and the settings read fill the react-query caches `AuthGate` and `useSettings` read.
- On a chat address, the chat route's chunks download and the open session's reads start. The chat's own `getSession` and first-page `listSessionMessagePage` adopt those reads once (`primeChatOpenReads` in `lib/chat-api.ts`), so the request is not repeated. The page size must equal the one the chat asks for.

A prefetch that fails changes nothing. The consumer that mounts later asks again and sees the real error, including the 401 of a signed-out visitor.

The build also writes an inline script into `index.html` that adds preload links (`route-preload-plugin.ts`, configured in `rsbuild.config.ts`). The active language's chunk goes out with the entry scripts, because every route needs it and it is small. On a chat address the chat route's chunks go out once the entry scripts have finished downloading, so they use the time the entry spends running instead of splitting a slow connection with it. Other addresses do not download the chat code.
