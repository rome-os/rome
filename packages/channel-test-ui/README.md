# @rome/channel-test-ui

A browser UI for channel scenario tests. It reads the traces that scenarios write. The scenarios, the platform peers they run against and the trace format are in [`packages/core/src/test/kit/im`](../core/src/test/kit/im/README.md). This package depends on core for the trace format. It is a development tool: nothing in Rome's runtime depends on it or serves it.

The page is built from [`@rome-os/ui`](../ui/README.md), the shared component kit, with Tailwind 4 and `lucide-react` icons. The kit ships token names and the dashboard owns their values, so `web/theme.ts` applies the dashboard's default theme through `packages/web/src/lib/theme.ts` and follows the system's light or dark mode.

## Use it

```sh
pnpm channels:ui            # build the UI, serve it on http://127.0.0.1:3212
pnpm channels:ui --run      # also run every scenario once on start
pnpm channels:ui --watch    # also rerun every scenario when packages/core/src changes
```

The page lists every test in `packages/core/src/test/kit/im`, scenario files first, with a name filter and a status filter. **Run all** starts the index over. The button beside a test reruns only that test and merges its result into the index. One run happens at a time.

Selecting a scenario fills three columns. The middle column is the conversation as the user sees it. The right column has the timeline, and below it the selected frame's detail. The timeline has four lanes on one clock. They hold the test's steps, what the agent emitted, what Rome did and the requests the platform received. For a request, the detail shows the request and answer bodies. When the scenario checked invariants, a list of them sits above the timeline, each marked held or broken. A request's tag says where the answer's shape came from: `capture` (a recorded platform response), `synthetic` (hand-written, no capture yet) or `fault` (injected by the test).

Selecting a frame shows the conversation as it stood after the step the frame belongs to.

The page follows the server's events, so a run started anywhere, including `pnpm test:channels` in a terminal, refreshes it.

## Replay

**Replay** and **Settings** are icon buttons at the top of the conversation. Hover or focus one to see its name. Replay plays the conversation from the start: each message appears, and an edit changes a message already shown. The user's messages appear whole, and the typewriter types out Rome's. An edit types only the text that differs from what the message showed, so a streamed reply grows. Pause, resume or drag the position bar to move through it. Selecting a frame or pressing **Stop** ends the replay.

A scenario runs in milliseconds, so a replay keeps the order of the recorded changes and spaces them with its own delays. **Settings** opens a dialog with them. A change applies at once, and the browser keeps them between visits:

| Setting | Default |
|---|---|
| Pause before a message | 600 ms |
| Pause before an edit | 250 ms |
| Typewriter effect | On, or off when the system asks for reduced motion |
| Typing speed | 40 characters per second |
| Longest typing time per message | 2000 ms, counting all its edits. A longer message types faster to fit |
| Also type the user's messages | Off |

## How data flows

1. `runScenario` in core writes one trace per test under `.channel-traces/traces/` when `ROME_CHANNEL_TRACES` is set, and names it in the test's `task.meta`.
2. `ChannelTraceReporter`, which core's Rstest config adds on the same variable, writes `.channel-traces/index.json` when the run ends.
3. `src/server.ts` serves the index and the traces and pushes an event when the index changes. It runs scenarios by spawning Rstest with the variable set.

`src/trace.ts` is the one place this package imports the trace format from core.

## Develop it

The page has no stylesheet of its own beyond `web/globals.css`, which imports Tailwind and the kit stylesheet. Write styles as Tailwind utilities on kit tokens, and reach for a kit component before writing a control by hand.

To work on the UI itself, start `pnpm channels:ui` and run `pnpm --filter @rome/channel-test-ui dev:web`, which serves the page with hot reload and sends API calls to the running server.

This package's tests run in core's suite: `pnpm --filter @rome/core test channel-test-ui`.
