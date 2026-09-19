# Rome Node

Rome Node exposes a computer to Rome instances in the same Cloud account while
`rome-node connect` runs. Programs run as the OS user who starts the command.
The computer needs Node.js 24 or later. It does not need a Rome instance.

Build an installation archive from this repository:

```sh
pnpm --filter @rome-os/node build
pnpm --filter @rome-os/node pack --pack-destination /tmp
npm install -g /tmp/rome-os-node-0.1.0.tgz
```

On the target computer:

```sh
rome-node connect --name "My computer"
```

Open the printed authorization URL in a browser on that computer and approve it.
The browser callback uses a temporary loopback listener. A remote browser needs
a tunnel to that listener. Ctrl+C disconnects and preserves the credential.

On the caller, configure a previously issued communication token through stdin:

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

Commands print JSON to stdout and diagnostics to stderr. Errors and nonzero
remote exit codes produce a nonzero local exit status. An authorized device is
not necessarily online. Use `describe` to query its current platform and actions.

The package exports the Gateway client, socket adapter, and action response
contract for other clients. See [the device architecture and operating guide](../../docs/rome-node.md)
for credential boundaries, file operations, output limits, and disconnection behavior.
