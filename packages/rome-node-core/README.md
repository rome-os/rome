# Rome Node Core

`@rome-os/node-core` provides JavaScript APIs for a shared caller daemon and an
embedded computer host. It runs on Node.js 24 or later, including an Electron
main process. The CLI is published separately as `@rome-os/node`.

## Shared caller

A Web Server and CLI using the same configuration directory and daemon port
share one caller daemon. The daemon owns the communication credential, Gateway
connection, and pending requests. Each client uses one local WebSocket for
requests and event subscriptions. The client entry does not load the host executor.

```ts
import {
  createNodeClient,
  nodeConfigFromEnvironment,
} from "@rome-os/node-core/client";

const client = createNodeClient(nodeConfigFromEnvironment(process.env));
const status = await client.getConnectionStatus();
const devices = await client.listDevices();
const connections = await client.getDevicesStatus();
await client.renameDevice("device-id", "Build server");
await client.removeDevice("old-device-id");
const info = await client.describe("device-id");
const result = await client.run("device-id", "exec", {
  command: "git",
  args: ["status"],
  cwd: "/workspace",
});
const { response, body } = await client.runBinary(
  "device-id",
  "exec",
  { command: "gzip", args: ["-c"] },
  input,
);
const copied = await client.copy({
  direction: "push",
  localPath: "/data/video.mp4",
  deviceId: "device-id",
  remotePath: "/tmp/video.mp4",
});
client.disconnect();
```

`getConnectionStatus()` returns `null` when no daemon runs. Otherwise it returns
`{ pid, protocolVersion, connection }`. It does not start a daemon or open a
Gateway connection. `connection` describes the caller connection to Gateway,
not the online state of remote devices. `listDevices()` returns authorized
devices without asserting that they are online.

`renameDevice(deviceId, name)` and `removeDevice(deviceId)` change the account's
device list in Cloud and resolve with no value. A failure throws
`DeviceActionError` with code `device_not_found`, `invalid_device_name`,
`invalid_device_session`, or `cloud_unavailable`. `removeDevice` ends the
device's token and connection and deletes it from the account in one call.

`runBinary(deviceId, action, args?, body?)` resolves to `{ response, body }`.
It sends `body` as input bytes in a binary frame. For `exec`, the input is the
program's stdin and the reply `body` is its raw stdout. Neither side is JSON or
base64 encoded. `response` is the same `ActionResponse` as `run()`, and the exec
result has no `stdout` field. Failures have an empty `body`. The device ID must
be a UUID. The request must fit in one 32 MiB Gateway frame, header and meta
included. Larger input fails with `message_too_large` before anything is sent.
Output that cannot fit fails with `output_too_large` after the program ran.
A host version without binary frame support
does not reply, and the call returns `unknown_outcome` after the wait limit.
See [binary frames](../../docs/rome-node.md#binary-frames).

`copy({ direction, localPath, deviceId, remotePath }, { onProgress? })` copies
one file between the daemon's computer and a device. `direction` is `push` or
`pull`, and `localPath` must be absolute. It resolves to `{ bytes, ms, sha256 }`
after both sides verified the size and checksum. It throws `DeviceActionError`
otherwise, and the destination stays unchanged. `onProgress` receives
`{ bytes, total }` about four times per second. The copy has no total time limit
and aborts after 60 seconds without progress or when the client disconnects.
See [copying files](../../docs/rome-node.md#copying-files).

`getDevicesStatus()` checks device reachability through read-only `system.info`
requests through an existing daemon and returns `{ connection, checkedAt, devices }`.
It returns `null` when no daemon runs and never starts or restarts one. Each device has
`id`, `name`, `platform`, and status `connected`, `not_connected`, or `unknown`.
The daemon shares concurrent checks and caches snapshots for ten
seconds. A timeout is unknown, not proof that a device is offline. This call
opens the shared Gateway connection when there are active devices to check.

Device operations start the daemon on demand. Only remote actions open its
Gateway connection. The daemon starts from this package's own entry point and
does not require an installed CLI. Concurrent launches elect one owner through
the OS listener bind before writing discovery state or connecting to Gateway.

`disconnect()` closes the local client handle. It does not stop the shared daemon,
cancel submitted operations, or interrupt other clients. `startDaemon(config)`
and `stopDaemon(config)` explicitly manage the shared service. An incompatible
protocol requires an explicit stop before restart. Requests are never replayed
after a lost response.

Subscribe to caller connection changes:

```ts
const unsubscribe = await client.subscribe("connection", (event) => {
  if (event.transport === "connected") {
    updateConnection(event.daemon.connection);
  } else {
    clearConnection();
  }
});

await unsubscribe();
client.disconnect();
```

`updateConnection` and `clearConnection` are application callbacks. Subscription
starts the daemon if needed and delivers a snapshot before resolving. It does
not open a Gateway connection. Events describe the daemon's caller connection.
they do not report remote device presence. A local connection loss delivers
`{ transport: "disconnected", daemon: null, reason: "connection_lost" }`.

While subscribed, the client reconnects with backoff and restores subscriptions
with a fresh snapshot. It does not restart a stopped daemon or replay missed
events. Incompatible protocols deliver reason `incompatible` and stop reconnection.
Listener exceptions can be handled with `createNodeClient(config, { onListenerError })`.
Unsubscribe removes one listener. other listeners and clients remain subscribed.
Close the client with `disconnect()` when its owning application shuts down.

Use `createNodeConfig({ directory, port? })` for an explicit location. Pass the
same environment to `nodeConfigFromEnvironment()` as the CLI to honor
`ROME_NODE_CONFIG_DIR`, `ROME_NODE_DAEMON_PORT`, and platform defaults.
The library does not select an environment implicitly.

## Activity console

The daemon records the actions it sends in `observe.db`. Read them with
`node.status`, `log.query`, `log.stats`, and the `node` event topic of the
[local protocol](../../docs/rome-node.md#activity-log).

A backend that serves a browser console puts `openConsoleBridge` between the
browser socket and the daemon:

```ts
import { nodeConfigFromEnvironment, openConsoleBridge } from "@rome-os/node-core/client";

const bridge = openConsoleBridge(nodeConfigFromEnvironment(process.env), {
  send: (text) => socket.send(text),
  close: () => socket.close(),
});
socket.on("message", (data) => bridge.receive(data.toString()));
socket.on("close", () => bridge.close());
```

The bridge never starts the daemon. It forwards only the observation methods.
When no daemon answers, it sends `console.daemon` with state `not_configured`,
`not_running`, `incompatible`, or `disconnected`, then closes.

## Caller authorization

```ts
import { authorizeServer } from "@rome-os/node-core/auth";
import { nodeConfigFromEnvironment } from "@rome-os/node-core/client";

await authorizeServer(cloudOrigin, instanceToken, nodeConfigFromEnvironment(process.env));
```

Authorization exchanges the Instance Token with Cloud and stores only the
communication credential. It does not start the daemon. Existing credentials
for the selected Cloud origin are reused. `configureCaller(origin, token, config)`
accepts an issued communication credential instead. The optional fourth argument
to `authorizeServer` receives retry notifications without terminal output.

## Embedded host

The host runs in the application process, independently of the caller daemon.
The application supplies credential storage, authorization interaction, and an
abort signal. It receives structured events instead of terminal output.

```ts
import {
  connectHost,
  createFileCredentialStore,
  loginDevice,
} from "@rome-os/node-core/host";

const controller = new AbortController();
const running = connectHost({
  cloudUrl: "https://romeos.cc",
  name: "My computer",
  signal: controller.signal,
  credentials: createFileCredentialStore("/private/app-data/credential.json"),
  authorize: (origin, name, signal) =>
    loginDevice(origin, name, signal, (url) => showAuthorizationUrl(url)),
  onEvent: (event) => updateApplicationState(event),
});

// At application shutdown, abort and await the host connection's completion.
controller.abort();
await running;
```

`showAuthorizationUrl` and `updateApplicationState` are application callbacks.
A custom credential store implements `load`, `save`, and `clear`. A stored token
is either a computer credential from `loginDevice` or `loginDeviceCode`, or the
Rome desktop app's own Rome Cloud sign-in. The built-in
login adapter uses a temporary loopback callback listener. Applications can
supply their own authorization function returning a device session.

For authorization from another device, import `loginDeviceCode` from the same
`/host` entry. It accepts the same origin, name, and abort signal as `loginDevice`.
Its callback receives `{ verificationUri, verificationUriComplete, userCode, expiresIn }`,
where `expiresIn` is in seconds. It returns a `DeviceSession` after approval and
rejects on denial, expiry, cancellation, or a terminal error. It opens no browser
or callback listener. The callback receives neither the device code nor the access token.

The host exposes `system.info`, `exec`, and the read-only `fs.list`, in text envelopes and in binary frames.
It also accepts the internal file transfers that `copy()` uses. Programs run as the application's OS
user. Connection loss terminates direct child processes on a best-effort basis.
A local caller timeout does not cancel remote execution.

See [the architecture and operating guide](../../docs/rome-node.md) for protocol,
credential, and failure semantics.


## Shared macOS computer use

Import the shared local host from `/computer-use`.
Desktop and the Node CLI use this implementation. When packaged for distribution,
the signed native app is bundled under `dist/native/Rome Computer Use.app`. On first use, the default host verifies
and copies those bundled bytes into the owner-only application state directory.
It restores the Mach-O executable bits that npm normalizes, then verifies the
signature again. No compiler, installer download, or postinstall script is needed.
The implementation targets Apple Silicon macOS 14 or later and explicitly selected
background windows. It uses its own virtual cursor and window-directed input.
It has no application allowlist and never falls back to global mouse or keyboard input.
Application and OS qualification remain separate from advertised capabilities.

The local `createComputerUseHost({ bundledAppPath?, appPath?, stateDir? })` exposes `run`,
`runBinary`, `describe`, `requestPermissions`, `disconnect`, and `idle`.
`describe()` reads configuration without launching the helper. Only the local
`requestPermissions()` opens its panel. `disconnect()` stops this host's sessions,
and `idle()` waits for stop records. The helper stays available to another host.
A later connection can bind a new session, while the old refs remain invalid.

`bind(windowRef)` requires a discovered window. Omitting it returns
`window_selection_required`. Full input requires the target application to own
neither the system frontmost application nor the system key focus. A different
non-key window in that foreground application can use a restricted
`inputIsolation: "window_semantics"` binding: AX-only `click`, `press`,
`setValue` and `selectText`, each requiring a fresh ref. Click is a single left
AX press without coordinates. Text edits use complete `setValue` assignments; type, raw keys,
pointer events, drag/scroll and raw AX actions are unavailable. The mode stays
fixed until cancellation or a new binding. Input and focus changes in other
applications do not stop the background session.

Bindings advertise `realPointer: false`, `coordinateSpace: "window_image_pixels"`
and their action list. The implementation provides `move`, `click`, `drag`, `scroll`,
`key`, `type`, `press`, `setValue`, `selectText` and `performAction`.
Elements advertise their available actions. `press`, `setValue`, `selectText` and
`performAction` require a fresh ref. `click` and `scroll` can use a ref without coordinates.
Legacy bindings without window capabilities retain `setValue` only and its 180-unit limit.

`computer.observe` returns the observation payload (and raw PNG bytes via `runBinary`
when `screenshot: true`). Pass `baseVersion` to request incremental changes and
`full: true` to force a full snapshot; callers merge deltas with
`mergeComputerUseObservation`. The host retains the baseline after an action
consumes its observation authority. Stopping a session or changing the helper
instance invalidates the cache and refs.

Act receipts remain unverified until an independent postcondition or readback succeeds.
Generic input without a checkable postcondition remains `unverifiable`.
Images use raw binary output, with their byte count and hash bound to the observation.
Sessions belong to the authenticated transport caller. Unknown outcomes must never be replayed.

The local permission panel requests persistent Screen Recording and Accessibility.
It requires no Input Monitoring grant. **Check window access** captures only the
helper's own permission panel. Ordinary status and bind calls do not request grants.
Stable signing identity and path support grant continuity, while macOS retains
control over revocation, upgrade consent and launch disclosures.

Complete development-Mac tasks cover AppKit, Electron pages and Chrome pages,
including selection, Unicode, shortcuts, buttons, checkboxes and scroll. AppKit
also covers drag/release. Actual Core/Gateway tasks use Node and the Electron
DeviceHost class with shared-helper identity checks. Native menus and popup
controls are excluded because tracking can acquire system key focus. Production
Cloud, outer Desktop account/settings, other systems and distribution permission
continuity require separate qualification.

The default running app has a stable path under
`~/Library/Application Support/Rome/ComputerUse/`. Desktop supplies `bundledAppPath`
as the source of its packaged helper. This source is installed at the same stable
path as the Node package. Explicit `appPath` and
`ROME_COMPUTER_USE_APP` development paths are used directly. The native installer
takes the service process lock, preserves an old app, and refuses to replace a
running helper. A different running implementation returns `helper_update_required`
without killing work. Desktop and Node compare the signed source fingerprint,
protocol, and architecture, so independent signatures of the same source can share
one helper. The native build keeps `com.rome.computer-use` as its bundle identifier. Keep its
path and signing identity stable to retain privacy grants across builds. Explicit
`--unsigned` builds are CI-only: their helper refuses input and permission requests.
Once native packaging scripts are wired, the package gate checks that the executable
is arm64 and included in the archive, and release publication requires Developer ID
signing with stapled notarization on an arm64 Mac.

See [the native helper documentation](./native/README.md) for the helper build,
signing, protocol, and failure details.
