# macOS Computer Use helper

The standalone arm64 bundle is `Rome Computer Use.app` with bundle ID
`com.rome.computer-use`. Its executable is `Contents/MacOS/RomeComputerUse`.
It uses public Accessibility and ScreenCaptureKit APIs on macOS 14 or later.

## Build and verify

Run these commands from the repository root with Node 24 on PATH for the
socket interoperability test.

```sh
script=packages/rome-node-core/scripts/computer-use.swift
swift "$script" build --self-test-build
swift "$script" test
swift "$script" verify --release
```

The last command must fail for the compile-only bundle. That build accepts
`--self-test` and runs a test socket with desktop access disabled. The release
gate requires a production bundle with a valid Developer ID Application
signature and a stapled notarization ticket.

Build a production bundle with `build --identity 'Apple signing identity'`.
The default output is under `.scratch/rome-node-native/`. Use `--app PATH` to
select an output named `Rome Computer Use.app`. Use
`install --source PATH --app PATH` to stage a signed bundle at another path.
Build and install take the same lock in the output directory and publish the
validated app in one rename. Use a stable signing identity and installation
path so macOS can retain permissions across upgrades.

## Launch and authenticate

1. Create a fresh mode `0700` directory owned by the graphical session user.
   Pass its absolute, canonical path to the helper. The path including
   `/helper.sock` is at most 103 UTF-8 bytes.
2. Create `STATE_DIR/bootstrap.json` exclusively as a regular, single-link
   file with mode `0600`. Close it before launch. The fields are `secret` (32
   cryptographically random bytes encoded as 64 lowercase hex digits),
   `hostPid` (the connecting process's numeric PID), and `hostExecutable` (the
   canonical absolute path to that process's executable). Generate a fresh key
   for every launch and retain it in the host through the handshake.
3. Start the signed app through LaunchServices.

   ```sh
   open -g -n -a "/path/to/Rome Computer Use.app" --args --serve "$state_dir"
   ```

   LaunchServices starts the helper in the graphical session under
   `launchd`. macOS attributes Accessibility and Screen Recording to
   `com.rome.computer-use` as the responsible process. A native host can
   use `NSWorkspace.openApplication` to launch the app and get its PID.
4. Connect to `STATE_DIR/helper.sock` from the declared host process. The
   helper exposes the socket with mode `0600`. It checks the peer UID and PID
   with `getpeereid` and `LOCAL_PEERPID`, then validates the code associated
   with `LOCAL_PEERTOKEN`. It matches the audit token's PID version against
   the kernel process record. A native host can apply the same kernel checks
   to the helper.
5. Send `handshake` with a fresh 32-byte random `nonce` and the host `proof`.
   Encode both as standard Base64. The request requires only the host PID.
   After the local user allows the session, use the returned PID and instance
   to verify the helper proof with a constant-time MAC comparison. Send
   additional requests only after successful verification.

The helper takes an exclusive `flock` on the pinned directory inode. It opens
`bootstrap.json` without following symlinks and verifies its owner, type, mode,
link count and inode. It unlinks the file before reading up to 16 KiB from the
open descriptor. Invalid JSON, an unavailable host PID, or a mismatched UID
or executable path fails launch. A valid file also disappears if handshake
or socket setup fails.

Compute proofs with HMAC-SHA256 keyed by the decoded 32 bootstrap bytes. Encode the
following fields as UTF-8, joined by one LF byte with no final newline.

| Position | Host proof | Helper proof |
| --- | --- | --- |
| 1 | `rome-computer-use-v1` | `rome-computer-use-v1` |
| 2 | `host` | `helper` |
| 3 | Decimal host PID | Decimal host PID |
| 4 | Standard Base64 nonce | Decimal helper PID |
| 5 | | Standard Base64 nonce |
| 6 | | Returned `instance` UUID |

The helper waits up to 10 seconds for the declared host to connect and up to
5 seconds for the handshake request. After verifying the host proof and computing
the helper proof, a production helper waits up to 60 seconds for the local user
to approve. Allow for both time limits when waiting for the handshake response.
The helper sends `consent_denied` on denial, dialog coverage, timeout, lock,
stop signal or disconnect whenever the socket can still carry the reply.
Admission closes and the helper exits in each case.

A socket or directory replacement, peer identity change or transport loss
seals admission and ends the helper. The helper samples the kernel process
unique ID and PID version every 100 ms and before window operations. A
same-path exec can preserve the PID, start time and socket descriptor. A
changed PID version still invalidates that connection. Start a fresh instance
to reconnect. Remove the per-launch state directory after the helper exits.

`scripts/computer-use.swift test` runs the native handshake tests against
`--self-test-server STATE_DIR ALLOW_MODE`. A separate launcher starts the helper so
the tests cover the same bootstrap and socket flow with a non-parent host.
The test server checks kernel peer identity and HMAC with desktop access disabled
and uses an injected consent decision. A Node 24 client verifies the wire
contract using the helper PID from the response.

## Threat model

macOS grants Accessibility and Screen Recording to the helper as a separate
TCC responsible process. A generic `node` binary can run arbitrary JavaScript,
including package install scripts. Rome's Electron app disables library
validation to load native modules. A valid process signature does not
identify the code making the request, and a process running as the same user
can create bootstrap files of its own.

The per-launch secret and HMAC bind the Unix socket handshake to its host.
After verifying the host's kernel identity and HMAC, the helper displays the
requesting process name, PID, canonical executable path and signing summary
in a local confirmation dialog. **Deny** is the default. **Allow Session**
becomes available after the dialog stays focused and clear for one second.
A left mouse press or key press during that delay restarts it. An overlapping window above the dialog from another process ends confirmation,
except for the system cursor. The helper checks again before accepting approval.

**Allow Session** lets the host list eligible open windows and their titles.
The authenticated host can hold bindings to several distinct windows at once.
Each binding limits observation and actions to its own window. The helper
checks the Accessibility root and element membership before dispatch.
The **Rome Computer Use** menu bar item shows the host and either no binding,
the window title and app, or the number of bound windows.
**Stop Computer Use** clears every binding and ends the session.

## Frames

| Bytes | Field |
| --- | --- |
| 0–3 | Unsigned big-endian JSON byte length, 1 to 262144 |
| 4–7 | Unsigned big-endian binary byte length, 0 to 8388608 |
| Next JSON length bytes | UTF-8 JSON object |
| Next binary length bytes | Raw PNG, present only on a successful screenshot response |

Requests use `{"v":1,"id":"r1","method":"status","params":{}}`. The ID is a
nonempty string of at most 64 UTF-8 bytes, unique among outstanding requests.
The binary length is zero. Omit `params` for methods without parameters.

Every reply uses one of these forms. Use `id` to associate replies with
requests. A framing or request error without a usable ID uses JSON `null`.

```json
{"v":1,"id":"r1","ok":true,"result":{"stop":"running"}}
{"v":1,"id":"r1","ok":false,"error":{"code":"window_unavailable"}}
```

| Method | Parameters | Result |
| --- | --- | --- |
| `handshake` | `nonce`, `proof` | `instance` UUID, numeric `pid`, Base64 `proof` |
| `status` | | `instance`, `stop` and optional `reason` |
| `windows` | Optional `application` | `windows` array of eligible windows |
| `bind` | Numeric `window` | `binding` UUID and `window` record |
| `unbind` | `binding` UUID | `binding`, `released:true` |
| `observe` | `binding`, optional Boolean `screenshot` | `binding`, `tree`, `truncated`, `refTTLms`, optional `screenshot` |
| `act` (Accessibility) | `binding`, `element` ref, `action`, optional `value` | `binding`, `dispatched:true` |
| `act` (input) | `binding`, `action`, and the fields in the input table | `binding`, `dispatched:true` |
| `stop`, `cancel` | | `stop` and `reason` |

Window records have a numeric `window` ID, `appName`, `bundleName`,
`bundleId`, `title` and `bounds` as `[x,y,width,height]` in desktop points.
The application filter matches any of the three app names case-insensitively.
The title serves as display text. The helper requires a unique public AX
window root and Core Graphics row with the same PID and exact bounds.
Ambiguous, minimized, offscreen, and unresolvable windows are ineligible.
Discovery is bounded and can return a partial list. A window ID has at most
one active binding in the helper. Trying to bind it again returns
`window_already_bound` and leaves its binding and refs intact. Bindings for
different windows keep separate refs and capture streams. The host can pass
distinct binding UUIDs to its callers over the same authenticated connection.
`unbind` releases the named binding and stops its stream. It returns
`binding_not_found` for an unknown, revoked, or released binding.
A later bind of that window returns a fresh UUID.

Tree nodes have `ref`, `role`, `actions`, `children` and optional `title`,
`description` and `value`. A ref stays stable while a node remains present
across successive observations within the 15-second TTL. Read `actions` to
choose between `press`, `set_value`, `increment` and `decrement`.
`set_value` takes a string of up to 16384 UTF-8 bytes for text input, a Boolean
for a checkbox, or a number within the slider's range. Increment and decrement
operate on AX scroll bars. The helper checks membership and capabilities again
before dispatch. Secure text fields withhold values and value actions.

### Input actions

Send these actions through `act` with the binding UUID and action name.
For example, click 40 points from the left and 20 points from the top.

```json
{"v":1,"id":"r2","method":"act","params":{"binding":"<uuid>","action":"click","x":40,"y":20}}
```

| Action | Required fields | Optional fields |
| --- | --- | --- |
| `click` | `x`, `y` | `button` (default `left`), `clickCount` (1–3, default 1), `modifiers` |
| `move` | `x`, `y` | `modifiers` |
| `drag` | `x`, `y`, `toX`, `toY` | `button` (default `left`), `steps` (1–60, default 12), `modifiers` |
| `scroll` | `x`, `y`, `deltaX`, `deltaY` | `modifiers` |
| `key_press` | `key` | `modifiers` |
| `type_text` | `text` | |

Pointer coordinates use logical points from the current window's top-left
corner. Both drag endpoints and all intermediate points must lie inside the
window. The left and top edges are inclusive. The right and bottom edges are
exclusive. Buttons are `left`, `right`, and `middle`. Supply modifiers as an
array of distinct names from `command`, `control`, `option`, and `shift`.
Scroll deltas use pixels, with positive values scrolling right or down.
Each delta is finite, within −2000 to 2000, and rounded to the nearest
integer. At least one rounded delta must be nonzero.

Named keys are case-insensitive. Use `return`, `enter`, `tab`, `escape`,
`backspace`, `delete` (forward delete), `space`, `up`, `down`, `left`,
`right`, `home`, `end`, `page_up`, `page_down`, or `f1` through `f12`.
A single character of up to 16 UTF-16 units uses the current keyboard layout.
Unmapped characters can use Unicode input when no modifiers are supplied.
`type_text` accepts 1–16384 UTF-8 bytes and sends the text in Unicode chunks
without splitting surrogate pairs.

Before dispatch, the helper checks the host, console, capture, and target
process identity. It activates the target app when needed and verifies that
the bound window has focus. Pointer input checks the topmost window at the
event coordinates. Keyboard input checks the full window for overlap.
A window that obscures the target can block input even if both share a PID.
The helper sends the events to the verified PID. Each stage of a drag and
each text chunk receives a fresh check. A failure can leave earlier events
dispatched. A successful `dispatched:true` confirms event submission. The
target application decides how to handle those events.

### Capture

`bind` requires Screen Recording permission and starts a desktop-independent
ScreenCaptureKit stream for the verified window. The helper waits for a
complete frame before it returns the binding. Each stream runs at up to
one frame per second with a maximum frame size of 640 × 480 pixels. macOS
uses the stream to show its purple screen-sharing indicator during control.
The helper retains the latest complete stream frame for preview consumers.

If the user stops sharing in the macOS indicator, or ScreenCaptureKit reports
an unexpected stream end, the helper immediately invalidates that stream's
binding. Later calls require a fresh bind. Any other binding whose stream
still runs remains active. If macOS stops every stream, every binding is
revoked.

The optional screenshot descriptor is
`{"mimeType":"image/png","width":640,"height":480,"bytes":12345}`. The binary
length equals `bytes`, and the PNG dimensions equal `width` and `height`.
Each dimension is at most 2048 pixels, with at most 3145728 pixels in total.
`observe(screenshot: true)` takes a separate single-frame screenshot at up to
the wire size limit. Its desktop-independent filter covers the requested
binding's window.

## Stop and failures

One serial window worker serves `windows`, `bind`, `unbind`, `observe` and
`act`. An overlapping request for that slot gets `busy` even when the
requests target different windows. `status`, `stop` and `cancel` use the
socket reader and can reply out of order while a window operation is busy.
`kill -USR1 HELPER_PID` provides a local stop, and `SIGTERM` seals admission
and exits. **Stop Computer Use** also seals admission and exits. Locking the
screen, session switching, sleep and the console guard seal
admission. The console guard uses public session fields, display state and
visible window levels. It runs during window operations and once per second
while a slot or binding is active.

`stop` and `cancel` permanently seal admission and stop every binding's
stream. `cancel_requested` means an admitted operation or binding cleanup
is still pending. `stop_confirmed` means the slot has drained, the bindings
have cleared, and the helper has requested all stream stops. A call or event
batch that crossed the final check can still reach its destination.

| Code | Meaning |
| --- | --- |
| `invalid_frame`, `frame_limit` | The transport cannot use the frame. The helper closes the connection. |
| `invalid_request`, `unsupported_version`, `method_unavailable` | Invalid request shape, version or method |
| `authentication_failed`, `connection_closed` | Failed handshake or a connection that lost its authority |
| `consent_denied` | The local user declined or the consent window expired or was interrupted |
| `desktop_disabled` | Compile-only helper |
| `console_unavailable`, `accessibility_permission_required` | Unavailable graphical session or missing Accessibility grant |
| `screen_recording_permission_required` | Missing grant for binding or capture, or loss of a grant seen by this helper |
| `session_stopped`, `busy` | Admission is closed or the window slot is occupied |
| `window_unavailable`, `process_identity_changed` | The helper cannot verify the window, its process, or the host process |
| `window_already_bound` | An active binding owns the requested window |
| `binding_not_found` | `unbind` did not find an active binding with that UUID |
| `binding_unavailable`, `element_unavailable` | Missing or revoked binding, stale ref or a node outside the window |
| `window_coordinate_out_of_bounds` | A pointer coordinate lies outside the window or the desktop displays |
| `window_focus_unavailable`, `window_occluded` | The helper cannot verify focus on the target or another window blocks input |
| `key_unavailable` | The keyboard layout cannot supply the character for a shortcut with modifiers |
| `action_unavailable`, `invalid_value`, `action_rejected` | The action, input or target rejected the request |
| `action_outcome_unknown` | An AX timeout after dispatch. Observe the window before deciding what to do next. |
| `capture_failed`, `capture_limit` | Capture failed or exceeded a limit |
| `internal_error` | Unclassified internal failure |

System Settings supplies Accessibility and Screen Recording permissions.
The helper checks permissions without opening prompts. The host can guide
the user to System Settings when a permission is missing.
