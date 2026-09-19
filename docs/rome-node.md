# Rome Node

[`@rome-os/node`](../packages/rome-node/README.md) provides the `rome-node` command,
a background caller daemon, and a reusable Gateway client. The command works
without Rome Core. Core tells agents how to use the CLI through its prompt.

## Authorization and transport

Provision a communication token before using device commands. Until automated
instance provisioning is integrated, exchange the Instance Token through Cloud
manually and pass the returned `deviceToken` to the CLI through stdin:

```sh
rome-node auth --cloud https://romeos.cc < /path/to/private-token-file
```

The CLI validates the communication token with Cloud and saves it in `caller.json`
inside its private configuration directory. The token has no expiration. It
contains no account or instance claims. Cloud stores its hash in the existing
device-session table. Issuing another token leaves previous tokens valid.
The CLI does not read Rome's database or require its Instance Token.

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
The daemon owns this local interface. Rome Core has no device routes or services.

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
`truncated: { stdout, stderr }`. Each stream retains at most 48 KiB.
Escaped output is reduced further when needed to keep the complete JSON envelope
within Gateway's 128 KiB limit. Truncation also applies to file reads.
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

Provision the caller token before using device commands. The existing Cloud
device endpoints and Gateway protocol handle communication. Automatic instance
provisioning is separate from the CLI runtime. Configure the npm Trusted Publisher for `@rome-os/node` before
its first package release. Building an archive does not publish it.

The [platform workflow](../.github/workflows/rome-node.yml) runs the package on
macOS, Linux, and Windows. It covers execution, literal arguments, Unicode paths,
output limits, direct-child shutdown, and credential lifecycle behavior.
Browser authorization and two-computer acceptance also require real environments.
Platform simulations and type checks do not establish those results.
