# Rome Node

Rome Node exposes a computer to Rome instances in the same Cloud account while
`rome-node connect` runs. Programs run as the OS user who starts the command.
The computer needs Node.js 24 or later. It does not need a Rome instance.

Build an installation archive from this repository:

```sh
pnpm --filter @rome-os/node build
pnpm --filter @rome-os/node-core pack --pack-destination /tmp
pnpm --filter @rome-os/node pack --pack-destination /tmp
npm install -g /tmp/rome-os-node-core-0.1.0.tgz /tmp/rome-os-node-0.1.0.tgz
```

On the target computer:

```sh
rome-node connect --name "My computer"
```

Open the printed authorization URL in a browser on that computer and approve it.
The browser callback uses a temporary loopback listener. A remote browser needs
a tunnel to that listener. Ctrl+C disconnects and preserves the credential.

Over SSH or on a headless computer, use device authorization:

```sh
rome-node connect --device-code --name "Remote Linux" --cloud https://romeos.cc
```

Open the printed URL on another device and approve the displayed user code.
The CLI prints the expiry and waits for approval without a callback listener or SSH tunnel.
Ctrl+C cancels the authorization. Both modes reuse stored credentials when valid.

Rome instances prepare caller authorization automatically at startup and after
Cloud enrollment. In a server environment that supplies `ROME_INSTANCE_TOKEN`, run:

```sh
rome-node auth --server --cloud https://romeos.cc
```

This exchanges the Instance Token with Cloud and stores only the communication
token. Existing caller credentials are reused. The CLI does not read Rome's database.

For manual caller configuration, pass an issued communication token through stdin:

```sh
rome-node auth --cloud https://romeos.cc < /path/to/private-token-file
```

This saves the token privately. The caller does not need Rome Core.
Run commands from an agent, script, or terminal:

```sh
rome-node help
rome-node help device run
rome-node device
rome-node device describe <device-id>
rome-node device run <device-id> exec --args '{"command":"git","args":["status"],"cwd":"/workspace"}'
```

Use `rome-node <command> --help` or `-h` for command-specific help.
Help includes action arguments, examples, output fields, and failure handling.
It works offline without credentials and does not start the daemon.

The first device command starts a background CLI daemon. Commands share its
Gateway connection. `rome-node daemon status` reports its PID, and
`rome-node daemon stop` closes it. A later command starts it again. Stop the
daemon before changing credentials. `rome-node daemon serve` runs in the
foreground for diagnosis. Set `ROME_NODE_CONFIG_DIR` to isolate configurations.

`rome-node watch` subscribes to caller connection changes and prints one JSON
event per line. It starts the daemon if needed and begins with a snapshot.
After a connection loss it waits for the daemon and subscribes again; it does
not restart a stopped daemon. Ctrl+C closes only the watcher. These events
report the caller's Gateway connection, not remote device presence.

Commands print JSON to stdout and diagnostics to stderr. Errors and nonzero
remote exit codes produce a nonzero local exit status. Output is collected in memory
and returned in full after program exit. Action message limits follow the WebSocket library and infrastructure.
The local daemon disconnects event observers that exceed its send-buffer limit. A lost response reports
`unknown_outcome`. Never automatically retry an unknown outcome.
An authorized device is
not necessarily online. Use `describe` to query its current platform and actions.

The CLI uses [`@rome-os/node-core`](../rome-node-core/README.md) for authorization,
its shared caller daemon, and the computer host. The package also re-exports
the Gateway client, socket adapter, and action response contract for compatibility. See [the device architecture and operating guide](../../docs/rome-node.md)
for credential boundaries, file operations, output limits, and disconnection behavior.
