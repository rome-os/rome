# iOS performance

How the app keeps the transcript, lists and streaming smooth on a long chat. The principles set the direction and leave room for judgment; the must-follow rules apply to every change. The evidence comes from the work that made the transcript's rows stored and equatable (#2123).

## General principles

- **Each update does little work.** A view reads only what it draws, and nothing recomputes or rewrites a value that did not change.
- **Heavy work stays off the main actor.** Decoding, parsing and disk reads run elsewhere; the main actor gets their results.
- **Every cache has a bound and an owner that clears it.**
- **A change on a hot path is measured.** Hot paths are the chat, lists and streaming. Count with `ROME_PERF`, then check hitches with Instruments on a device. Put the before and after numbers in the PR.

Examples of these principles:

- **Look up by an index, not a scan in a loop.** `RowInfo.build` scanned every message for each quoted row; `TasksStore` indexes tasks by chat.
- **Cache pure parsing by its input with `ParseCache`.** Markdown parses while streaming fell from 8 to 2 per run.
- **Update a known item in place.** A streamed message whose turn and time are unchanged keeps its place, instead of sorting the whole chat again.
- **Store derived lists and rebuild them when an input changes.** `TranscriptStore.rows` was computed on every read, about four times per body.
- **Put many rows in over several frames.** An older page of 40 messages laid out at once took about 55 ms on a phone, a stall mid-fling; four messages a frame take about 10 (`TranscriptStore.olderChunk`, measured with `ROME_PERF=paging`).
- **A view reads only its own state.** The chat's header and banners read the status and notices themselves, so a status change no longer redraws the transcript.

## Must follow

1. **A `TimelineView(.animation)` or a repeating task pauses when its page is hidden.** Pass `paused: offScreen`.
   - Why: Chat stays mounted under other sections. Its shimmer, typing dots and mascot drew about 40 frames a second there for nothing.
   - Check: `ROME_PERF=idle-apps` shows about 0 `shimmerTick` and `mascotTick`.
2. **Transcript and list rows take values, are `Equatable`, and never read the store or take closures made in a `body`.** Actions go through a stable object such as `ChatActions`.
   - Why: a task chat's rows took closures, so each message redrew every row: 321 row bodies per streaming run, against 25 now.
   - Check: `ROME_PERF=stream` and `taskstream` row-body counts.
3. **No disk read, and no synchronous image or JSON decode, in a view's `init` or `body`.**
   - Why: an avatar read and decoded its PNG in `init`, which runs on every update of its parent: 62 disk reads per section-switch run.
   - Check: `ROME_PERF=sections` `diskImageRead`.
4. **Anything that grows with the number of chats has a cap, and is released on sign-out or when the workspace stops.** This covers per-chat stores and caches.
   - Why: every opened chat kept its transcript until the workspace closed, and a stored closure kept an old workspace alive.
   - Check: a test that holds the owner weakly, stops it and expects it freed (`StoredRowsTests`), and a test of the cap (`PerfPathsTests`).

## How to measure

**Counts.** Run a Debug build with `ROME_DEMO=long-chat` and `ROME_PERF=<scenario>`:

```bash
xcrun simctl launch booted cc.romeos.mobile.dev
```

Set the two variables with `SIMCTL_CHILD_` in front of each, or in the scheme. The app drives the scenario for about 20 s. It writes one line to the log (category `Perf`) and to `tmp/perf-<scenario>.txt` in its container. The line holds the frame hitch time and how often rows, screens, row builds and Markdown parses ran. [`README.md`](README.md#debug-modes) lists the scenarios.

- Counts repeat exactly between runs and hold on a device, so compare them before and after a change.
- A simulator's hitch figure moves with the Mac's load. Treat it as a hint.

**Device profile.** Check hitches on a phone with Instruments: Animation Hitches and Time Profiler while a scenario runs, and Allocations for memory. Record on the device itself, and build nothing while it records.
