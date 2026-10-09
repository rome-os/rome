# @rome/channel-test-ui

A browser UI for channel scenario tests. It reads the traces that scenarios write. The scenarios, the platform peers they run against and the trace format are in [`packages/core/src/test/kit/im`](../core/src/test/kit/im/README.md). This package depends on core for the trace format. It is a development tool: nothing in Rome's runtime depends on it or serves it.

## Use it

```sh
pnpm channels:ui            # build the UI, serve it on http://127.0.0.1:3212
pnpm channels:ui --run      # also run every scenario once on start
pnpm channels:ui --watch    # also rerun every scenario when packages/core/src changes
```

The page lists every test in `packages/core/src/test/kit/im`, scenario files first, with a name filter and a status filter. **Run all** starts the index over. The button beside a test reruns only that test and merges its result into the index. One run happens at a time.

Selecting a scenario shows its timeline: the test's steps and the requests the platform received, on one clock, one row per frame and one column per lane. Selecting a frame shows what the conversation looked like after the step the frame belongs to. For a request, it also shows the request and answer bodies. A request's tag says where the answer's shape came from: `capture` (a recorded platform response), `synthetic` (hand-written, no capture yet) or `fault` (injected by the test).

The page follows the server's events, so a run started anywhere, including `pnpm test:channels` in a terminal, refreshes it.

## How data flows

1. `runScenario` in core writes one trace per test under `.channel-traces/traces/` when `ROME_CHANNEL_TRACES` is set, and names it in the test's `task.meta`.
2. `ChannelTraceReporter`, which core's Rstest config adds on the same variable, writes `.channel-traces/index.json` when the run ends.
3. `src/server.ts` serves the index and the traces and pushes an event when the index changes. It runs scenarios by spawning Rstest with the variable set.

`src/trace.ts` is the one place this package imports the trace format from core.

## Develop it

To work on the UI itself, start `pnpm channels:ui` and run `pnpm --filter @rome/channel-test-ui dev:web`, which serves the page with hot reload and sends API calls to the running server.

This package's tests run in core's suite: `pnpm --filter @rome/core test channel-test-ui`.
