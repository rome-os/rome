# Rome Node

[`@rome-os/node`](../packages/rome-node-cli/README.md) provides the `rome-node`
command. [`@rome-os/node-core`](../packages/rome-node-core/README.md) provides the
JavaScript client, caller daemon, authorization, and embedded computer host.
The CLI works without Rome Core. Rome Core depends on the library and prepares
caller credentials after the instance binds to Cloud.
The production image and local development stack install the CLI explicitly.

## JavaScript clients and process ownership

The caller daemon owns one Gateway connection and matches pending requests.
CLI commands and JavaScript clients using the same configuration directory and
port share that daemon. The CLI owns terminal interaction and exit codes.
A Web Server can use `createNodeClient(config)` from `@rome-os/node-core/client`
to list devices, describe them, run actions, and query caller connection status.

`getConnectionStatus()` does not start the daemon. It returns `null` when no
service runs, or `{ pid, protocolVersion, connection }`. The connection status
belongs to the caller-to-Gateway connection. It does not report whether each
remote device is online. Device listing returns authorization records.

Device operations start the daemon from the core package when needed. The
library does not depend on a CLI executable or the embedding process entry point.
Concurrent starts use the same OS listener bind. A client disconnect leaves
other clients and the shared daemon running. Explicit stop affects all clients.
Protocol version mismatch requires an explicit stop and restart.

The target computer host runs separately, in `rome-node connect` or an embedding
application such as an Electron main process. `connectHost()` accepts a credential
store, authorization callback, event callback, and abort signal. It does not
print terminal output or install process signal handlers.
See the [library examples](../packages/rome-node-core/README.md) for both APIs.

## Device status in Settings

Settings → Devices shows the caller connection, connected device count, and each
device's name, platform, and status. The dashboard refreshes every 15 seconds
while open. `client.getDevicesStatus()` returns the same daemon-owned checks.

It only connects to an existing daemon and returns `null` if none is running.
Opening the page, polling, and refreshing never start or restart the daemon.
The HTTP API reports `not_running` in that case, and the page shows an unknown
device count. Explicit daemon startup and device commands can start it again.

Cloud's device list records authorization, not live presence. The daemon sends
read-only `system.info` requests: a successful reply confirms a connected device,
`target_unavailable` means not connected, and a timeout or other failure means
unknown. Revoked devices are shown separately and excluded from the count.
When checks are incomplete, the count is a lower bound. A failed list query or
local service failure displays an unavailable count, never a fabricated zero.

The daemon shares concurrent checks, caches completed snapshots for 10 seconds,
and invalidates the cache when its Gateway connection changes. At most four
probes run concurrently, each waiting three seconds for a reply after submission.
A refresh starts probes for at most 15 seconds after listing devices. Any devices
not checked within that budget remain unknown. Gateway connection setup has its
own existing wait limits. No history, remote actions with side effects, or new
Gateway presence protocol is involved.

## Local client protocol

Clients connect to `ws://127.0.0.1:<port>/rpc` using the private credential from
`daemon.json` in an Authorization header. Browser Origin requests are rejected.
The connection uses JSON-RPC 2.0 and starts with `daemon.hello`, passing
`{ protocolVersion: 2 }`. This local protocol is separate from Gateway envelopes.

| Method | Purpose |
| --- | --- |
| `daemon.hello` | Check protocol version and return a status snapshot |
| `daemon.status` | Read caller status without opening a Gateway connection |
| `daemon.stop` | Explicitly stop the shared daemon |
| `devices.list` | List authorized devices from Cloud |
| `devices.status` | Check device reachability with read-only `system.info` requests |
| `devices.run` | Forward `{ deviceId, action, args }` to a device |
| `events.subscribe` | Subscribe with `{ topic: "connection" }` |
| `events.unsubscribe` | Remove the connection's subscription |

Each client has one full-duplex WebSocket. Responses match request IDs within
that connection. Independent clients can use the same IDs. Events and concurrent
responses share the socket. Neither requires polling or a separate event stream.

Subscription registers the listener and sends an `events.connection` notification
with `{ pid, protocolVersion, connection }` before acknowledging the request.
The JS API wraps snapshots as `{ transport: "connected", daemon: snapshot }`.
Local disconnection emits `{ transport: "disconnected", daemon: null, reason }`,
so consumers can clear stale state. The only topic is currently caller connection
status. Remote device presence events, logs, and streaming action output are not
provided. Device reachability snapshots use `devices.status`.

`client.subscribe("connection", listener)` and `rome-node watch` start the daemon
when initially subscribed. After a connection loss they reconnect to an existing
daemon with backoff, restore subscriptions, and receive a fresh snapshot. They do
not restart an explicitly stopped daemon. There is no event history or action replay.
Protocol mismatch stops reconnection and requires an explicit daemon restart.

Ping/pong detects dead connections. A slow observer exceeding 1 MiB of queued
outgoing data is disconnected when the next event is sent, without blocking other
clients. Unsubscribe removes the local listener. Disconnecting a client never
stops the shared daemon. `rome-node watch` writes newline-delimited JSON and
exits on Ctrl+C.

The new daemon does not serve HTTP business routes. Upgrade compatibility is
limited to detecting and explicitly stopping a running HTTP daemon with the
existing private credential. A client never silently replaces an incompatible daemon.

## Authorization and transport

After startup and either browser enrollment flow, Rome calls `authorizeServer()`
with the current Instance Token and the same configuration as the CLI.
The parent environment and agent environment are unchanged.

The library checks local caller credentials. If credentials are missing, it
exchanges the Instance Token through Cloud and saves the returned communication
token. It does not persist the Instance Token or send it to Gateway.
The CLI invokes the same library API for `auth --server`.

Existing caller credentials for the configured Cloud origin are reused without
a network check or a new token. A different Cloud origin requires manual
configuration. Provisioning does not start the daemon or block startup or login.
Transient failures get up to three attempts, with delays of one and five seconds.
An issued token is reused across validation retries. After retries fail, the library
returns an error. Rome logs the failure and retries on the next
startup or enrollment.

When the server environment already supplies `ROME_INSTANCE_TOKEN`, run:

```sh
rome-node auth --server --cloud https://romeos.cc
```

For manual configuration, exchange the Instance Token through Cloud and pass
the returned `deviceToken` to the CLI through stdin:

```sh
rome-node auth --cloud https://romeos.cc < /path/to/private-token-file
rome-node auth status
```

The CLI validates the communication token with Cloud and saves it in `caller.json`
inside its private configuration directory. The token has no expiration. It
contains no account or instance claims. Cloud stores its hash in the existing
device-session table. Issuing another token leaves previous tokens valid.
The CLI does not read Rome's database. Only server authorization needs an
Instance Token. Device commands use the stored communication token.
`auth status` reports whether local credentials exist and their Cloud origin.
It does not print the token or check its validity with Cloud. Preserve the CLI
configuration directory across container replacements and use the same directory
for Rome startup and agent commands.

The first device command starts a background CLI daemon. Concurrent commands use
that daemon's connection and receive independently matched responses. Listing
devices only calls Cloud. The daemon opens its Gateway connection on the first
remote action. It stays alive after an individual CLI command exits.

```sh
rome-node daemon start
rome-node daemon status
rome-node daemon stop
```

`start` is idempotent. `status` reports whether the daemon runs and its PID.
`stop` closes its Gateway connection. A subsequent device command starts it again.
A command can also restart a crashed daemon. Interrupted operations are never
replayed. Stop the daemon before replacing credentials with `auth`.
`rome-node daemon serve` runs in the foreground for diagnosis.

The daemon listens on loopback with a private local credential in `daemon.json`.
Its port is derived from the configuration directory. The OS allows one listener,
so concurrent launches cannot establish competing Gateway connections. Set
`ROME_NODE_DAEMON_PORT` consistently for the caller and daemon if the port is occupied.
The daemon owns this local interface. Rome Core exposes a sanitized
`GET /api/devices` snapshot for Settings → Devices through the shared JS client.

On the target computer, `connect` uses the `rome-computer` PKCE flow and stores
the resulting device credential in a private user directory:

| Platform | Default directory |
| --- | --- |
| macOS and Linux | `$XDG_CONFIG_HOME/rome-node`, or `~/.config/rome-node` |
| Windows | `%LOCALAPPDATA%\RomeNode` |

`ROME_NODE_CONFIG_DIR` overrides the directory. Unix directories use mode 0700
and files use 0600. Windows directories restrict inherited access with the current
user's SID. `--cloud` selects an HTTPS Cloud origin. Plain HTTP is allowed only
for loopback development.

Gateway connections require WSS. Plain WS is allowed only for `localhost`,
`127.0.0.1`, and `[::1]`. Gateway URLs cannot contain credentials, query parameters,
or fragments. The same rules apply when reconnecting.

Startup checks the credential through `GET /v1/gateway/config`. Missing,
malformed, or confirmed-invalid credentials require browser authorization.
Network failures and temporary service errors preserve the credential and retry
with backoff. Runtime revocation stops the process. Run `connect` explicitly to
authorize a new identity. A superseded connection stops without competing to reconnect.

Gateway sends `{ id, to, payload }` and delivers `{ id, from, payload }`.
It derives `from` from the authenticated connection. Requests carry
`{ type: "request", action, args }`. Responses carry either
`{ type: "response", ok: true, result }` or
`{ type: "response", ok: false, error: { code, message } }`.
The CLI daemon accepts a response only from the selected target with the matching request ID.

## Commands and execution

Run `rome-node help` for the command overview and `rome-node help device run`
for action arguments, examples, and result handling. Each command also accepts
`--help` or `-h`. Help works offline without credentials or a running daemon.

`rome-node device` reads the authorized device list from Cloud. It does not claim
that listed devices are online. `device describe <id>` invokes `system.info`,
which returns the computer name, platform, and supported actions.

`device run <id> exec --args <json>` starts a program with an argument vector.
The arguments are `command`, optional `args: string[]`, and optional `cwd`.
The executor does not concatenate a shell command. Invoke a shell explicitly
for redirection, pipelines, or shell builtins.

Examples of action arguments for macOS and Linux:

```json
{"command":"ls","args":["-la","/workspace"]}
{"command":"cat","args":["/workspace/README.md"]}
{"command":"sh","args":["-c","printf '%s' 'Hello' > '/tmp/example.txt'"]}
```

Examples for Windows:

```json
{"command":"powershell.exe","args":["-NoProfile","-Command","Get-ChildItem -LiteralPath 'C:\\Work'"]}
{"command":"powershell.exe","args":["-NoProfile","-Command","Get-Content -Raw -LiteralPath 'C:\\Work\\README.md'"]}
{"command":"powershell.exe","args":["-NoProfile","-Command","Set-Content -LiteralPath 'C:\\Work\\example.txt' -Value 'Hello'"]}
```

An exec result contains `exitCode`, `signal`, `stdout`, `stderr`, and
`truncated: { stdout: false, stderr: false }`. Output is collected in memory and
returned in full after program exit. Action messages and output use WebSocket library defaults and platform
limits. Local event observers have the send-buffer limit described above. Cloudflare limits received WebSocket messages to 32 MiB,
including the envelope. WebSocket fragmentation does not bypass this limit.
A lost response returns `unknown_outcome` because execution may have occurred.
Never automatically repeat an operation after an unknown outcome.
At most eight programs run concurrently on one executor.

## Failure and shutdown

The CLI daemon waits up to 60 seconds for an action response. Timeout and connection loss
return `unknown_outcome`. The remote program may have started or completed.
A local timeout does not cancel it. Never automatically repeat an operation after
an unknown outcome. The protocol has no offline queue, replay, cancellation, or
remote task-status API.

The executor attempts to terminate its direct child processes on connection loss,
revocation, supersession, or shutdown. It escalates to forced termination after
one second when needed. Detached descendants are not guaranteed to terminate.
Replies from an earlier connection cannot be sent through a replacement connection.

Cloud device revocation closes the target through the existing durable Gateway
notification mechanism. A partition can delay enforcement until synchronization
finishes. Revocation cannot undo completed side effects. The caller connection
remains available for other devices.

## Deployment and verification

Instance startup and enrollment prepare the caller token through the core
library. The existing Cloud device endpoints and Gateway protocol handle communication.
Configure the npm Trusted Publishers for `@rome-os/node` and `@rome-os/node-core`
before their package releases. Building an archive does not publish it.

The [platform workflow](../.github/workflows/rome-node.yml) runs the package on
macOS, Linux, and Windows. It covers execution, literal arguments, Unicode paths,
output limits, direct-child shutdown, and credential lifecycle behavior.
Browser authorization and two-computer acceptance also require real environments.
Platform simulations and type checks do not establish those results.
