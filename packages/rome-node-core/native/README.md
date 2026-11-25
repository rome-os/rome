# macOS Computer Use helper

The standalone arm64 bundle is `Rome Computer Use.app` with bundle ID
`com.rome.computer-use`. Its executable is `Contents/MacOS/RomeComputerUse`.
It uses public Accessibility and ScreenCaptureKit APIs on macOS 14 or later.

## Build and verify

Run these commands from the repository root.

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
   with `getpeereid` and `LOCAL_PEERPID`, then validates `LOCAL_PEERTOKEN`
   with Security and pins it to the connection. A native host can apply the
   same kernel checks to the helper.
5. Send `handshake` with a fresh 32-byte random `nonce` and the host `proof`.
   Encode both as standard Base64. Verify the returned PID and helper proof
   before sending another request. Use constant-time MAC comparison.

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
| 4 | Decimal helper PID | Decimal helper PID |
| 5 | Standard Base64 nonce | Standard Base64 nonce |
| 6 | | Returned `instance` UUID |

The helper waits up to 10 seconds for the declared host to connect and up to 5 seconds
for its handshake. A socket or directory replacement, peer identity change, or
transport loss seals admission and ends the helper. Start a fresh instance to
reconnect. Remove the per-launch state directory after the helper exits.

`scripts/computer-use.swift test` runs the native handshake tests against
`--self-test-server STATE_DIR`. A separate launcher starts the helper so
the tests cover the same bootstrap and socket flow with a non-parent host.
The test server checks kernel peer identity and HMAC with desktop access disabled.

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
| `observe` | `binding`, optional Boolean `screenshot` | `binding`, `tree`, `truncated`, `refTTLms`, optional `screenshot` |
| `act` | `binding`, `element` ref, `action`, optional `value` | `binding`, `dispatched:true` |
| `cancel` | | `stop` and `reason` |

Window records have a numeric `window` ID, `appName`, `bundleName`,
`bundleId`, `title` and `bounds` as `[x,y,width,height]` in desktop points.
The application filter matches any of the three app names case-insensitively.
The title serves as display text. The helper requires a unique public AX
window root and Core Graphics row with the same PID and exact bounds.
Ambiguous, minimized, offscreen, and unresolvable windows are ineligible.
Discovery is bounded and can return a partial list. A bind attempt discards
the current binding and its refs.

Tree nodes have `ref`, `role`, `actions`, `children` and optional `title`,
`description` and `value`. A ref stays stable while a node remains present
across successive observations within the 15-second TTL. Read `actions` to
choose between `press`, `set_value`, `increment` and `decrement`.
`set_value` takes a string of up to 16384 UTF-8 bytes for text input, a Boolean
for a checkbox, or a number within the slider's range. Increment and decrement
operate on AX scroll bars. The helper checks membership and capabilities again
before dispatch. Secure text fields withhold values and value actions.

The optional screenshot descriptor is
`{"mimeType":"image/png","width":640,"height":480,"bytes":12345}`. The binary
length equals `bytes`, and the PNG dimensions equal `width` and `height`.
Each dimension is at most 2048 pixels, with at most 3145728 pixels in total.
A screenshot uses a desktop-independent filter for the single bound window.

## Stop and failures

One slot serves `windows`, `bind`, `observe` and `act`. An overlapping
request for that slot gets `busy`. `status` and `cancel` use the socket
reader and can reply out of order while a window operation is busy.
`kill -USR1 HELPER_PID` provides a local stop, and `SIGTERM` seals admission
and exits. Session switching, sleep, and the console guard also seal
admission. The console guard uses public session fields, display state and
visible window levels. It runs during window operations and once per second
while a slot or binding is active.

Cancel permanently seals this helper's admission. `cancel_requested` means
an admitted operation still occupies the slot. `stop_confirmed` means the
slot has drained. An AX call that crossed the final check can still reach its
destination. A dispatched call can finish after cancellation. No stop status
represents OS rollback.

| Code | Meaning |
| --- | --- |
| `invalid_frame`, `frame_limit` | The transport cannot use the frame. The helper closes the connection. |
| `invalid_request`, `unsupported_version`, `method_unavailable` | Invalid request shape, version or method |
| `authentication_failed`, `connection_closed` | Failed handshake or a connection that lost its authority |
| `desktop_disabled` | Compile-only helper |
| `console_unavailable`, `accessibility_permission_required` | Unavailable graphical session or missing Accessibility grant |
| `screen_recording_permission_required` | Missing grant for the requested capture, or loss of a grant seen by this helper |
| `session_stopped`, `busy` | Admission is closed or the window slot is occupied |
| `window_unavailable`, `process_identity_changed` | The helper cannot verify the window or its process |
| `binding_unavailable`, `element_unavailable` | Missing binding, stale ref or a node outside the window |
| `action_unavailable`, `invalid_value`, `action_rejected` | The action, input or target rejected the request |
| `action_outcome_unknown` | An AX timeout after dispatch. Observe the window before deciding what to do next. |
| `capture_failed`, `capture_limit` | Capture failed or exceeded a limit |
| `internal_error` | Unclassified internal failure |

System Settings supplies Accessibility and Screen Recording permissions.
The helper uses preflight checks without opening permission prompts.
