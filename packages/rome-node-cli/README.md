# Rome Node

Rome Node exposes a computer to Rome instances in the same Cloud account while
`rome-node connect` runs. Programs run as the OS user who starts the command.
The computer needs Node.js 24 or later. It does not need a Rome instance.

Build an installation archive from this repository on an arm64 Mac with a real
Apple signing identity:

```sh
pnpm --filter @rome-os/node build
pnpm --filter @rome-os/node-core build:native --identity "Apple Development: Your Name (TEAMID)"
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

On Apple Silicon macOS, ordinary `rome-node connect` (and Rome Desktop when
Computer Use is enabled) advertises background-window control alongside regular
Node actions on the same Gateway connection.

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

Native window control on the target Mac uses the helper shipped in the package:

```sh
rome-node computer permissions
rome-node computer status
rome-node connect --name "My Mac"
```

Grant persistent Screen Recording and Accessibility to **Rome Computer Use**
through its local panel. Input Monitoring is not required.
**Check window access** tests capture against the helper's own permission panel.
Ordinary status and bind calls do not request grants. Stable signed builds retain
the same application identity, but macOS can require consent or launch disclosures again.
Unsigned CI builds cannot request those grants or dispatch input.
The implementation targets Apple Silicon macOS 14 or later. Audio capture is disabled.

On the caller, discover a window and bind its opaque reference:

```sh
rome-node device run <device-id> computer.windows
rome-node device run <device-id> computer.bind --args '{"windowRef":"<listed-window-ref>"}'
rome-node device run <device-id> computer.observe --args '{"sessionId":"<session-id>","full":true}'
rome-node device run <device-id> computer.observe --args '{"sessionId":"<session-id>","screenshot":true}' --output window.png
rome-node help device run
```

Full input requires the target application to own neither system frontmost status
nor system key focus. A different non-key window in that foreground application
can instead use `window_semantics`: ref-only AX `click`, `press`, `setValue` and
`selectText`. Click is a single left AX press without coordinates; this mode has
no type, raw keys, pointer events, dragging, scrolling or raw AX actions.
The binding's input mode stays fixed until a new binding.
The agent uses its own virtual cursor. Input and focus changes in
other applications do not interrupt it. Target takeover stops the session.
There is no global mouse, keyboard, activation or focus-restoration fallback.
Omitting `windowRef` returns `window_selection_required`.

Use only actions advertised by the binding and the selected element.
The implementation provides `move`, `click`, `drag`, `scroll`, `key`, `type`,
`press`, `setValue`, `selectText` and `performAction`.
Coordinates use pixels in the latest window image. `click` and `scroll` can use
a ref without coordinates. AX operations require an element ref.
The backend has no application allowlist. Its capabilities do not prove compatibility
with every application. Legacy bindings retain their `setValue`-only, 180-unit contract.

`computer.observe` returns full or delta records. Supply `baseVersion` for incremental
reads, or `full: true` for a reset. An absent or mismatched baseline produces a full response.
Use `computer.act` with a unique action ID and the fresh observation's version,
then `computer.verify`. Event delivery alone does not prove success.
`setValue` and `selectText` support independent readback. Generic input without a
checkable AX postcondition remains `unverifiable`.

Unicode input does not provide IME composition. `computer.cancel` stops a session.
Observations expire after 15 seconds, and unknown outcomes must never be replayed.
Images travel as raw bytes. Audit records omit image and input contents.
Real AppKit checks and isolated input checks do not qualify complete tasks,
multiple applications, both hosts or distribution permissions. See the
[full action contract](../rome-node-core/README.md#shared-macos-computer-use).

Copy a file to or from a device:

```sh
rome-node cp ./video.mp4 <device-id>:/tmp/video.mp4
rome-node cp <device-id>:/tmp/video.mp4 ./video.mp4
```

The caller daemon and `rome-node connect` read and write the files with Node
streams. Each copy writes its own hidden part file next to the destination.
The destination changes only after its size and SHA-256 checksum match and the
data is flushed to disk. A replaced file keeps its permission bits.
A failed copy leaves it unchanged and is safe to run again. To copy between two
devices, copy to this computer first and then to the second device. Progress
goes to stderr, and `{"bytes":...,"ms":...,"sha256":"..."}` goes to stdout. The
device needs a rome-node version with file transfer support.

To pass raw bytes to a program and read its raw stdout, add `--input` or `--output`
to `device run`:

```sh
rome-node device run <device-id> exec --args '{"command":"gzip","args":["-c"]}' --input data.bin --output data.bin.gz
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

Commands print JSON to stdout and diagnostics to stderr. With `--input` and no
`--output <file>`, `device run` prints the program's raw stdout and moves the JSON
response to stderr. Errors and nonzero
remote exit codes produce a nonzero local exit status. Output is collected in memory
and returned in full after program exit. Action message limits follow the WebSocket library and infrastructure.
The local daemon disconnects event observers that exceed its unsent event limit. A lost response reports
`unknown_outcome`. Never automatically retry an unknown outcome.
An authorized device is
not necessarily online. Use `describe` to query its current platform and actions.

The CLI uses [`@rome-os/node-core`](../rome-node-core/README.md) for authorization,
its shared caller daemon, and the computer host. The package also re-exports
the Gateway client, socket adapter, and action response contract for compatibility. See [the device architecture and operating guide](../../docs/rome-node.md)
for credential boundaries, binary frames, file copies, output limits, and disconnection behavior.
