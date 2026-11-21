# macOS computer-use helper

`Rome Computer Use.app` is a signed, standalone permission owner shared by the
Desktop host and the Node host. Its identifier is `com.rome.computer-use`.
Launch it through Launch Services. Executing its Mach-O file from a terminal
does not establish the same privacy-permission responsibility.

## Build and permission identity

Run the build script with Node 24 or later on macOS:

```sh
node packages/rome-node-core/scripts/build-computer-use.ts \
  --output '/absolute/stable/path/Rome Computer Use.app' \
  --identity '<Apple Development or Developer ID Application identity>'
```

The script uses the selected Xcode and its macOS SDK without changing the global
Xcode selection. This keeps a Nix-provided SDK from selecting the wrong Swift
driver. A target Mac does not need Swift or Xcode when it receives this app.

`--unsigned` produces a compile-only artifact for CI package checks. It disables
privacy-permission requests and computer-use operations. Permission-capable
builds require `--identity`, `ROME_COMPUTER_USE_SIGNING_IDENTITY`,
`CODE_SIGN_IDENTITY` or `CSC_NAME`. Release workflows must separately require a
Developer ID Application signature and notarization.

Keep the bundle identifier, signing identity and installed path stable during
development. The build prints the designated requirement. Ad-hoc signing is
refused because its identity can change on every build. Development and
distribution signatures can have different requirements, so permission
continuity must be verified for the distribution channel too.

Each output has an exclusive lock under `.scratch/computer-use-build-locks/`.
Competing builds fail before changing the source snapshot or app bundle.
A killed build can leave its lock. Read `owner.json` and confirm that process
has exited before moving a stale lock to Trash.

`Resources/implementation.json` records the protocol, architecture and a source
fingerprint covered by the bundle signature. The fingerprint includes sorted
Swift/C/header bytes and runtime build options. The compiler receives an exact
snapshot of those bytes. Signing timestamps and bundle build numbers are not
implementation changes. The service caches that identity and the executable
hash at startup, so rebuilding a file does not change an already-running
service's reported identity.

The package bridge installs a verified staged app with the early
`--install-staged-app --state-dir <directory>` mode. It acquires the same native
process lock before replacing the installed app. A running service refuses
replacement. The old app remains in a private backup directory, and a failed
move restores it. This mode starts no AppKit application or privacy API.

Open the permission panel explicitly:

```sh
open -a '/absolute/stable/path/Rome Computer Use.app' --args --permissions
```

The panel has explicit **Allow Screen Recording…** and **Allow Accessibility…** buttons.
Post-event access follows the Accessibility grant. Background control requires no
Input Monitoring grant or global event tap. The panel uses persistent access only.

Opening the panel does not attempt capture. **Check window access** checks AX access
and captures only the helper's own permission panel. Ordinary status and bind calls
do not invoke permission-request APIs. Capture configurations disable audio,
microphone capture and the system cursor.

Keep Rome Desktop or the Node host open during authorization. If a new grant needs
a fresh process, the panel first stops input and capture, then restarts only this
helper once per authorization attempt. Existing sessions cannot continue or replay input.
A capture error stops automatic checks. A failed capture with all required flags
granted does not cause an automatic restart.

macOS can still display Quit & Reopen or launch-disclosure prompts. Stable code identity
supports grant continuity within a signing channel, but OS revocation and upgrades
can require consent again. The panel also provides **Stop all computer use**.

## Local protocol

The host creates a private directory with mode 0700 and a regular, single-link
`token` file with mode 0600 containing 64 lowercase hexadecimal characters.
Pass its canonical path with `--state-dir`. The app listens on `helper.sock` in
that directory. UNIX socket paths must fit the platform's 104-byte limit.

Each frame has a four-byte little-endian JSON length followed by UTF-8 JSON,
with an 8 MiB limit. A request is `{ id, token, method, params }`. Replies are
`{ id, ok: true, result }` or `{ id, ok: false, error: { code, message, details } }`.
The app accepts only peers with the same effective user ID. A retained process
lock prevents a second service from replacing an active socket.

Methods are `hello`, `requestPermissions`, `windows`, `bind`, `observe`, `act`,
`verify`, `cancel` and idle-only `shutdown`. `hello.execution.busy` reports the
native lane. Each connection has its own worker. Cancellation latches a stop
without acquiring that lane or waiting for the main queue.

## Window execution

Binding requires an opaque `windowRef` from discovery. Omitting it returns
`window_selection_required` before capture or input. `WindowControl.swift` checks
the kernel process identity and exact AX/WindowServer window relationship.
Full input requires the entire target application to own neither the system
frontmost application nor the system key focus. There is no application allowlist.
When both belong to that application but a different exact window is focused,
binding selects `inputIsolation: "window_semantics"` with `transport: "ax_only"`.
Its fixed action list is `click`, `press`, `setValue` and `selectText`.
Every action requires a ref. Click is a single left AX press on an advertised
button, without coordinates. Text edits use explicit complete `setValue`
assignments. Type, raw keys, pointer events, dragging, scrolling and raw AX actions
remain unavailable. An unreadable focused window or takeover of the bound window
ends the session. An active semantic binding with only one real focus channel
in the target application blocks input until a fresh sample allows it.
If the target application owns key focus, the helper still checks the exact
focused window. A mixed sample at least 350 ms after the first unresolved
sample ends the session. A `focus_transitioning` rejection before dispatch
requires a fresh observation before the caller issues another action.
A successful AX call keeps its dispatch receipt if the post-dispatch check
finds a temporary focus transition. The caller can verify the effect once focus settles.
An off-screen window can qualify when its exact AX and WindowServer identities
match, its application is unhidden, and its AX window reports that it is unminimized.
Discovery checks the window list, main window and focused window because macOS
may return an empty AX window list outside the current Space. Binding requires a
usable first frame from the window-only capture. It selects the same fixed
AX-only mode and omits the cursor overlay.
The shared host checks the request against the element's advertised actions.
The native helper checks live focus independently of the background stop poll.
Transient `cannotComplete` errors can retry read-only focused-window, window-root
enumeration and value-writability queries, with at most three attempts and a
200 ms retry budget. Focused-window and window-root reads check that budget
again after each pause. Window-root failures report the enumeration stage,
AX error and read-attempt count.
Synchronous reads can finish beyond that threshold; the separate 200 ms proof
before input remains unchanged. No input operation is retried and no cached focus
value grants access.

The binding advertises `scope: "background"`, `realPointer: false`,
`coordinateSpace: "window_image_pixels"` and `partialObservations: true`.
The full-input actions are `move`, `click`, `drag`, `scroll`, `key`, `type`, `press`,
`setValue`, `selectText` and `performAction`. Element records advertise their
available actions. Callers must check both lists before dispatch.

`WindowInput.swift` creates discrete PID- and window-directed events with
`CGEventSource(stateID: .privateState)`. Window routing uses private window fields
and a window-location API, followed by `postToPid`.
Local focus notifications target the same process. A full-input binding can negotiate
`foregroundNavigationFallback` for repeatable navigation. Two unchanged source
reads precede application activation. The helper confirms the exact key window
and checks the receiver again before a single window-directed retry. Strict
background bindings keep activation disabled. Neither mode moves the physical
pointer or restores focus.
The helper compiles no global desktop dispatcher or global input monitor.
Required private APIs can vary across macOS versions and need device qualification.

Keyboard calls retain a process-local focus context across asynchronous target processing.
The native lane assigns one owner per target process. Cancelling a superseded owner
cannot deactivate its replacement. Terminal cleanup follows the input worker and
skips local deactivation if the user now owns real system focus in that target.
Session reclamation waits for capture-stop confirmation and local context release.
Before creating a control stream, the helper writes the window claim in its
private `native-stops` directory. A replacement helper in the same state
directory can read a durable stop confirmation. A claim that survived the old
helper without confirmation keeps that exact window occupied.

Coordinates use pixels in the latest bound-window image. The viewport maps them
to window-local points. `click` and `scroll` can instead use a fresh element ref.
`press`, `setValue`, `selectText` and `performAction` require one.
`performAction` accepts a raw AX name only when that element advertises it.
The helper rejects `AXRaise`.
Native menus, popup buttons and combo boxes have no advertised pointer, keyboard
or raw AX actions because menu tracking can acquire system key focus. Coordinate
dispatch checks known menu bounds and a fresh application-restricted AX hit test.
The receiver check can walk up to 64 AX ancestors to reach the bound window
within its existing read budget. The observation depth remains 32.
Custom controls can still have application-specific focus effects and require qualification.
Generic AX groups do not expose AXPress for background control. A reference-only
click on such a group uses the same window-directed pointer route as a coordinate click.
A reference-only single left click can choose an uncovered point when another
control overlaps the default point. The snapshot must be complete, and a fresh
AX hit must resolve to the same receiver within the observed region before dispatch.
With explicit coordinates, the helper rejects a point covered by another observed
pressable control outside the referenced element's ancestry and subtree.

`setValue` accepts at most 16,384 UTF-16 units, including an empty value.
`selectText` selects one unambiguous match, optionally constrained by prefix and
suffix, or positions a cursor before or after it. This AX operation sends no
keyboard or focus-preparation events.
`type` accepts at most 4096 UTF-16 units. Unicode replacement uses the target's
selected range without the clipboard. IME composition and candidate windows are
not supported. The eight-second dispatch budget can constrain long input before
the parser limit. Text fields reject NUL and malformed UTF-16.
Legacy bindings without window capabilities retain `setValue` only and a 180-unit limit.

`WindowAction.swift` follows the shared Bézier trajectory for a drag in window-local points.
Cancellation cleanup releases at the last dispatched local point after another
kernel and window identity check. It never reads or restores the system pointer.
Cleanup cannot undo an event or AX operation already dispatched.

## Semantic state and capture

`WindowAXState.swift` batches fresh AX reads and compares them with a cached
baseline. Its budget is 600 ms, 512 nodes, and 64 KiB of UTF-8 content. Whole-window
reads are limited to depth 32, and regional reads to depth 48.
Optional attribute failures remain unknown and do not by themselves mean the
tree omitted a node. Structural limits produce a partial observation.
Secure values stay omitted. Truncated fields cannot prove complete-field equality.
Snapshots and their action authority expire after 15 seconds.

Observations carry a full reset or a delta with stable refs, a lineage and a
version. `elements` contains only added and changed records in a delta.
An absent or mismatched `baseVersion`, explicit `full: true`, changed geometry
or incomplete baseline produces a full reset. A partial reset replaces the
visible cache and never presents unvisited nodes as confirmed removals.
Only fresh records and valid coordinates can authorize actions from partial state.

The host retains the state baseline after an action consumes observation authority.
It clears both on termination or a helper instance change.
The SDK returns `{ observation, changes, image }`: materialized state, the wire
payload and optional PNG bytes. Independent verification does not advance the
public observation revision.

Each bound session keeps a one-frame-per-second ScreenCaptureKit stream for its
exact window and the native sharing indicator. Binding requires an existing
Screen Recording grant, a confirmed start and a frame.
The stream has no audio, system cursor or recording file. Its frames are discarded.
Stopping sharing stops the session. macOS controls the indicator's appearance.

Requested screenshots also capture only that window. They have a 2048 by 1536
pixel limit and a 5 MiB PNG limit. Metadata records dimensions, scale and window
bounds. Pixels use binary transport and stay out of the action journal.

## Verification and stop conditions

Dispatch receipts have `effectVerified: false`. Generic input without an explicit
AX postcondition remains `unverifiable`. A postcondition requires a fresh independent
tree read, complete traversal and exactly one matching element.
Unknown comparison attributes cannot prove uniqueness. `setValue` and `selectText`
also support independent value or selection-range readback.
An internal virtual cursor position cannot verify a `move` effect.

Target takeover, expiry, console lock, capture stop, identity failure, cancellation
or host disconnection stops control. Other applications can receive input and
change focus without stopping the background session. No global input tap is required.
`native-stops` preserves the first terminal cause through exclusive creation and fsync.
Unknown action outcomes stop the session and cannot be replayed.

One helper admits one live binding per process identity and exact window.
A competing bind for that window returns `busy`. Different windows can have
independent bindings. After a stop, the helper keeps the window occupied until
it confirms that input and session resources have stopped.

The `end` method records `completed` if there is no earlier terminal cause.
It returns `stopConfirmed` after checking the input lane, capture and cleanup.
A pending receipt can be checked again with `end` for the same session ID.

The console gate requires a current-user, logged-in session and rejects loginwindow.
A present private lock marker must be false. A missing private marker alone does
not prove a locked session. Missing public session fields fail closed.
This convention requires OS qualification. Dispatch checks and application processing
are not atomic, and sampling cannot prove the absence of every transient focus change.

For focus isolation tests, start the independent sampler before launching Desktop.
Record the foreground process, keyboard focus owner and physical pointer through
the final page read. A command-line sampler that sleeps between reads of
`NSWorkspace.frontmostApplication` can keep reporting the previous app after a
foreground switch. Run the AppKit main loop between samples and cross-check the
foreground PID against the system process manager.

## Checks and provenance

Build an isolated test app to run the dependency-free native contract checks.
The normal release app excludes the checks and their command-line entry:

```sh
node packages/rome-node-core/scripts/build-computer-use.ts \
  --output '.scratch/computer-use-self-test/Rome Computer Use.app' \
  --unsigned --self-test-build
mkdir -p .scratch/native-check
chmod 700 .scratch/native-check
'.scratch/computer-use-self-test/Rome Computer Use.app/Contents/MacOS/RomeComputerUse' \
  --self-test "$PWD/.scratch/native-check"
ROME_COMPUTER_USE_TEST_APP="$PWD/.scratch/computer-use-self-test/Rome Computer Use.app" \
  node --test packages/rome-node-core/native/check-install.ts
ROME_COMPUTER_USE_BUILD_LOCK_TEST=1 \
  node --test packages/rome-node-core/native/check-build-lock.ts
```

These checks cover first-cause arbitration, concurrent stops, lane retention,
state deltas, event construction, trajectory bounds, cleanup and text limits.
They do not replace real application, screenshot, permission-continuity or takeover tests.

Complete development-Mac tasks cover AppKit, Electron pages and Chrome pages:
selection, Unicode replacement, shortcuts, semantic buttons, checkboxes and scroll.
AppKit also covers drag and release. Real Core/Gateway tasks pass through Node and
the actual Electron DeviceHost class with shared-helper identity checks. These
tests exclude production Cloud and the outer Desktop account/settings flow.
Distribution signatures, other OS versions and arbitrary applications require
separate qualification.

The cross-Space acceptance harness (added alongside the host coordinator in the
follow-up stack) creates its own AppKit windows and moves its foreground fixture
into a fullscreen Space, verifying exact discovery, deep AX observation, deltas,
permitted and rejected actions, and focus, pointer, and process cleanup. Do not
replace a helper during a GUI acceptance run.

Upstream research attribution for the MIT-licensed
[Cua driver](https://github.com/trycua/cua/tree/ed9026fd4cbd7ebcf3a44e23c3881752165bc6cb)
is retained in `THIRD_PARTY_NOTICES.md`. The helper excludes the PID-only
driver, fixture oracle, global event filtering, and frontend focus restoration.
