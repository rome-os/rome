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
const info = await client.describe("device-id");
const result = await client.run("device-id", "exec", {
  command: "git",
  args: ["status"],
  cwd: "/workspace",
});
client.disconnect();
```

`getConnectionStatus()` returns `null` when no daemon runs. Otherwise it returns
`{ pid, protocolVersion, connection }`. It does not start a daemon or open a
Gateway connection. `connection` describes the caller connection to Gateway,
not the online state of remote devices. `listDevices()` returns authorized
devices without asserting that they are online.

`getDevicesStatus()` checks device reachability through read-only `system.info`
requests through an existing daemon and returns `{ connection, checkedAt, devices }`.
It returns `null` when no daemon runs and never starts or restarts one. Each device has
`id`, `name`, `platform`, and status `connected`, `not_connected`, `unknown`, or
`revoked`. The daemon shares concurrent checks and caches snapshots for ten
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
not open a Gateway connection. Events describe the daemon's caller connection;
they do not report remote device presence. A local connection loss delivers
`{ transport: "disconnected", daemon: null, reason: "connection_lost" }`.

While subscribed, the client reconnects with backoff and restores subscriptions
with a fresh snapshot. It does not restart a stopped daemon or replay missed
events. Incompatible protocols deliver reason `incompatible` and stop reconnection.
Listener exceptions can be handled with `createNodeClient(config, { onListenerError })`.
Unsubscribe removes one listener; other listeners and clients remain subscribed.
Close the client with `disconnect()` when its owning application shuts down.

Use `createNodeConfig({ directory, port? })` for an explicit location. Pass the
same environment to `nodeConfigFromEnvironment()` as the CLI to honor
`ROME_NODE_CONFIG_DIR`, `ROME_NODE_DAEMON_PORT`, and platform defaults.
The library does not select an environment implicitly.

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
A custom credential store implements `load`, `save`, and `clear`. The built-in
login adapter uses a temporary loopback callback listener. Applications can
supply their own authorization function returning a device session.

The host exposes `system.info` and `exec`. Programs run as the application's OS
user. Connection loss terminates direct child processes on a best-effort basis.
A local caller timeout does not cancel remote execution.

See [the architecture and operating guide](../../docs/rome-node.md) for protocol,
credential, and failure semantics.
