# Frontend performance bench

`pnpm perf:web` scores the dashboard's first load of `/chat`. It builds `rome-web`, measures what the browser downloads before the page renders, then loads the static mock build in headless Chromium under fixed throttling. Each result is compared against a saved baseline, so a change can be scored before it lands.

## Running it

Save a baseline from the commit you are improving on, then rerun the bench after each change:

```bash
git checkout main
pnpm perf:web --save-baseline
git checkout my-branch
pnpm perf:web
```

The second run prints each metric beside its baseline value and the change in percent. Results are written to `packages/web/perf/.results/`, which git ignores. `latest.json` holds the last run and `baseline.json` holds the saved baseline.

| Option | Effect |
|---|---|
| `--skip-build` | Reuse `dist/` and `dist-mock/` from the last build. |
| `--bundle-only` | Measure the bundle and skip the browser runs. |
| `--runs <n>` | Browser runs per scenario. The bench reports the median. The default is 5. |
| `--cpu-throttle <n>` | Chromium CPU slowdown factor. The default is 4. |
| `--baseline <file>` | Compare against another result file. |
| `--out <file>` | Write the result somewhere other than `latest.json`. |

The bench needs a Chromium that the installed `@playwright/test` can launch. When the browser Playwright expects is not installed, point `PERF_CHROMIUM_PATH` at a Chromium binary.

## What it measures

**Bundle.** The bench reads `dist/index.html` and sums every script and stylesheet it loads from `/static` — the assets the browser fetches before anything renders. It reports their raw, gzip, and brotli sizes. It also reads the source maps of those scripts and lists the packages with the most minified bytes in them, so the report names what to split out next.

**Page load.** The bench serves `dist-mock/` with gzip and opens a fresh browser context for each run, with Chromium's CPU slowed by the factor above. The bench's server applies the network profile itself: each response waits a 40 ms round trip, and all responses share one 10 Mbps link. Chromium's own network emulation would miss the requests the MSW service worker makes for the page, which include every lazy chunk. Hosts other than the local server do not resolve, so the Google Fonts stylesheet in `index.html` fails at once and the page renders with fallback fonts. One unmeasured run per scenario warms the file cache. It loads two scenarios:

| Scenario | Page | Ready when |
|---|---|---|
| `chat-empty` | `/chat` | The composer's text box is in the DOM. |
| `chat-transcript` | `/chat/mock-chat-market-brief` | The first transcript row is in the DOM. |

For each scenario it reports:

| Metric | Meaning |
|---|---|
| FCP, LCP | First and largest contentful paint, from the browser's paint timing. |
| ready | Time until the ready element first appears. |
| TBT | Total blocking time from first paint until the page settles: the part of each long task beyond 50 ms. |
| longest task | The longest single main-thread task, including script evaluation before first paint. |
| JS transferred | Gzipped bytes of script the server sent for the page, lazy chunks included. |
| JS heap | Used JS heap after the page settles and a forced garbage collection. |

The page-load numbers come from the mock build, which also ships MSW and its fixtures and waits for the MSW service worker before rendering. Compare them between runs of the bench, not with production. The bundle numbers come from the production build.

## Reading the numbers

Results move with the machine, so compare a baseline and a candidate measured on the same machine. When the baseline was measured with a different CPU factor, network profile, scenario list, or run count, the report prints a warning above the table. The report prints the spread of the ready time across runs. A change smaller than that spread is noise, so rerun with more `--runs` before acting on it. Bundle sizes are deterministic for a given commit.
