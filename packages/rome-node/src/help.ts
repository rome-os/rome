const overview = `Rome Node — run programs on authorized remote computers.

Usage:
  rome-node help [command ...]
  rome-node <command> --help

Commands:
  connect          Keep this computer online as a remote executor.
  auth             Configure the caller's communication token through stdin.
  device           List authorized devices (they may be offline).
  device describe  Query a device's platform and supported actions.
  device run       Execute an action on a device.
  daemon           Manage the caller's background connection.

Agent workflow:
  1. Run rome-node device and choose a device ID from items.
  2. Run rome-node device describe <device-id> to check its platform and actions.
  3. Run rome-node help device run for argument formats and result handling.

Device commands require caller auth and start the daemon automatically.
Help works offline without credentials and does not start the daemon.
Use -h or --help on any command. No arguments also prints this overview.
Set ROME_NODE_CONFIG_DIR to use a separate configuration directory.
`;

const commands: Record<string, string> = {
  connect: `Usage: rome-node connect [--cloud <origin>] [--name <name>]

Run this on the computer that will execute programs.
Open the printed browser URL and approve access when authorization is needed.
The process stays in the foreground. Ctrl+C disconnects and preserves authorization.
Programs run as the OS user who starts connect.

Options:
  --cloud <origin>  Cloud origin (default: https://romeos.cc).
  --name <name>     Name for browser authorization (default: computer hostname).

Example:
  rome-node connect --name "My computer"
`,
  auth: `Usage: rome-node auth [--cloud <origin>] < token-file

Read an issued communication token (romedev_...) from stdin, validate it with
Cloud, and save it privately for device commands. An Instance Token must first
be exchanged through Cloud. This command does not perform that exchange.
Stop a running caller daemon before changing credentials.

Options:
  --cloud <origin>  Cloud origin (default: https://romeos.cc).

Example:
  rome-node daemon stop
  rome-node auth --cloud https://romeos.cc < /path/to/private-token-file

Output: {"configured":true}
Pass tokens through stdin. Never put them in command arguments or print them.
`,
  device: `Usage:
  rome-node device
  rome-node device describe <device-id>
  rome-node device run <device-id> <action> [--args <json>]

With no subcommand, list authorized devices as {"items":[...]}.
Use an item's id for subsequent commands. Listed devices may be offline.
describe queries the target's current platform and actions through Gateway.
run invokes one of those actions. The caller daemon starts automatically.

Examples:
  rome-node device
  rome-node device describe <device-id>
  rome-node help device run
`,
  "device describe": `Usage: rome-node device describe <device-id>

Invoke system.info on an online target. Use an ID from rome-node device.
The result includes name, platform, and actions. Platform-specific commands and
paths must match the target computer, which may differ from the caller.

Example result:
  {"type":"response","ok":true,"result":{"name":"My computer","platform":"macos","actions":["system.info","exec"]}}

Failures return {"type":"response","ok":false,"error":{"code":"...","message":"..."}}.
The local exit status is 0 on success or 1 on failure.
`,
  "device run": `Usage: rome-node device run <device-id> <action> [--args <json>]

Use an ID from rome-node device. Run device describe first to discover actions.
--args is a JSON object for the action (default: {}).

Computer actions:
  system.info  No arguments. Returns name, platform, and actions.
  exec         Run a program on the target computer.

exec arguments:
  command      Required nonempty executable name or path.
  args         Optional array of string arguments (default: []).
  cwd          Optional working directory on the target (default: executor cwd).

Programs receive no interactive stdin. No shell is added automatically.
Invoke a shell explicitly for pipelines, redirection, or shell builtins.
Examples below use POSIX caller-shell quoting:
  rome-node device run <device-id> system.info
  rome-node device run <device-id> exec --args '{"command":"git","args":["status"],"cwd":"/workspace"}'
  rome-node device run <device-id> exec --args '{"command":"cat","args":["/workspace/README.md"]}'
  rome-node device run <device-id> exec --args '{"command":"sh","args":["-c","ls /workspace | head"]}'
  rome-node device run <device-id> exec --args '{"command":"powershell.exe","args":["-NoProfile","-Command","Get-ChildItem -LiteralPath C:/Work"]}'

Output:
  Success: {"type":"response","ok":true,"result":{...}}
  Failure: {"type":"response","ok":false,"error":{"code":"...","message":"..."}}
  exec result: {exitCode, signal, stdout, stderr, truncated: {stdout, stderr}}

Check exec's exitCode even when ok is true. The local exit status is 1 for
action failures, nonzero remote exit codes, or signal termination, otherwise 0.
Local setup and argument errors print diagnostics to stderr and exit 1.
Each output stream retains at most 48 KiB, with further truncation to fit a frame.
Check truncated before treating output or file contents as complete.

The caller waits up to 60 seconds for a response. unknown_outcome means execution
may have started or completed. A local timeout does not cancel the remote program.
Never automatically retry an unknown outcome. Requests are never replayed.
`,
  daemon: `Usage: rome-node daemon [start|status|stop|serve]

  start   Start the background caller daemon if needed (default).
  status  Report {"running":true,"pid":...} or {"running":false} without starting it.
  stop    Close the daemon and its Gateway connection. Print {"running":false}.
  serve   Run the daemon in the foreground for diagnosis. Ctrl+C stops it.

Device commands start the daemon automatically and share its connection.
start and serve require caller auth. A later device command restarts a stopped
or crashed daemon. Interrupted operations are never replayed.
Stop the daemon before changing credentials with rome-node auth.

Environment:
  ROME_NODE_CONFIG_DIR   Configuration directory shared by caller and daemon.
  ROME_NODE_DAEMON_PORT  Override the derived loopback port (1024-65535).
                        Use the same value for caller and daemon.
`,
};

export function commandHelp(positionals: string[], explicitTopic: boolean): string {
  if (positionals.length === 0) return overview;
  const topic = positionals.join(" ");
  if (Object.hasOwn(commands, topic)) return commands[topic];
  if (
    positionals[0] === "daemon" &&
    positionals.length === 2 &&
    ["start", "status", "stop", "serve"].includes(positionals[1])
  )
    return commands.daemon;
  if (!explicitTopic) {
    const command = positionals.slice(0, 2).join(" ");
    if (Object.hasOwn(commands, command)) return commands[command];
  }
  throw new Error(`Unknown help topic: ${topic}. Run rome-node help.`);
}
