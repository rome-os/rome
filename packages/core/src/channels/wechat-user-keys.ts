// Recovering the WeChat message-store key, the one privileged step.
//
// The store is SQLCipher, keyed by a passphrase the client only ever holds in
// memory and only ever derives during a login. Reading it out needs ptrace on
// the client as it signs in, which the Rome container deliberately cannot do.
// The hosting VM can: host root reaches into the container across the namespace
// boundary and keeps its capability there, so the recovery runs on the VM as a
// root script and hands back only the passphrase. Rome then derives and verifies
// the per-database keys back inside the container, where the databases are.
//
// It recovers the key by launching the client under gdb, not by attaching to a
// running one. The passphrase is derived once, at the first login, and a
// fresh-QR login re-execs into a new image — attaching after the client is up
// misses that derivation and forces a second, in-process login. Launching owns
// the client from its first instruction and re-arms the breakpoint across every
// exec, so the very first login is caught with nothing asked of the guardian
// twice.
//
// The mechanics: Rome stages the launch driver and the vendored key tool inside
// its own container (it runs there). The root script, on the VM, translates a
// container-visible pid to the host pid naming the same process, enters that
// process's namespaces, and execs the staged driver — which launches the client
// the container's own way while running as host root. The material that leaves
// the VM is the passphrase, and it lands in the same container that already
// holds the client and its store.

import { lstat, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../logger.js";
import type { RootScriptOutcome, RootScriptRunner } from "../host-execution/root-script-runner.js";

const log = createLogger("wechat-user-keys");

/** The recovery launches the client and waits for the guardian to scan and for
 *  the login to derive the key, so it needs room; the helper's ceiling is 600
 *  seconds. */
const CAPTURE_TIMEOUT_SECONDS = 540;

/** Where Rome stages the driver and key tool inside its own container. The root
 *  script reaches this path only after entering the container's namespaces, so
 *  it is a container path, not a host one. */
const CAPTURE_DRIVER_PREFIX = ".rome-wechat-keys-";

const DRIVER_FILE = "launch-driver.py";
const TOOL_FILE = "wcdb_key_tool.py";

function assetDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

export class WechatUserKeyRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WechatUserKeyRecoveryError";
  }
}

/**
 * Stage the launch driver and the vendored key tool inside this
 * container, so the root script can exec them once it has entered the container.
 * Returns a private, unique directory. The caller removes it after recovery.
 */
export async function stageCaptureDriver(parent = "/run"): Promise<string> {
  const owner = await lstat(parent);
  if (!owner.isDirectory() || owner.uid !== process.getuid?.() || (owner.mode & 0o022) !== 0) {
    throw new WechatUserKeyRecoveryError(
      "Capture requires a private parent directory owned by the runtime user.",
    );
  }
  const dir = await mkdtemp(join(parent, CAPTURE_DRIVER_PREFIX));
  try {
    const [driver, tool] = await Promise.all([
      readFile(join(assetDir(), "wechat-user-launch-driver.py"), "utf8"),
      readFile(join(assetDir(), "vendor", "wcdb_key_tool.py"), "utf8"),
    ]);
    await Promise.all([
      writeFile(join(dir, DRIVER_FILE), driver, { mode: 0o600, flag: "wx" }),
      writeFile(join(dir, TOOL_FILE), tool, { mode: 0o600, flag: "wx" }),
    ]);
    return dir;
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

export interface WechatKeyRecoveryOptions {
  /** A pid, as this container sees it, of a process in this container. The root
   *  script translates it to the host pid naming the same process and enters
   *  that process's namespaces, which are this container's. Rome's own pid is
   *  the natural choice: it is guaranteed to be in the right container. */
  anchorPid: number;
  /** Where the driver was staged, inside this container. */
  driverDir: string;
  /** PID namespace identity observed inside the runtime container. */
  pidNamespace?: string;
  /** The home the launched client must run under, so the store it writes lands
   *  where the Rome runtime reads it. Defaults to the container's own HOME. */
  home?: string;
}

/**
 * Recover the message-store passphrase by launching the client under gdb on the
 * hosting VM. Resolves with the 64-char hex passphrase, which the caller derives
 * per-database keys from inside the container.
 *
 * A login must happen while this runs — the driver launches the client, the
 * guardian scans, and the breakpoint fires on the login's key derivation. The
 * caller shows the scan walkthrough; this owns getting host root into the
 * container and reading the value back out.
 */
export async function recoverWechatPassphrase(
  runner: RootScriptRunner,
  options: WechatKeyRecoveryOptions,
  signal?: AbortSignal,
): Promise<string> {
  const driverDir = options.driverDir;
  const pidNamespace = options.pidNamespace ?? (await readlink("/proc/self/ns/pid"));
  if (
    !/^pid:\[\d+\]$/.test(pidNamespace) ||
    !Number.isSafeInteger(options.anchorPid) ||
    options.anchorPid <= 0
  ) {
    throw new WechatUserKeyRecoveryError("Invalid container process identity.");
  }
  const script = rootScript(
    options.anchorPid,
    pidNamespace,
    driverDir,
    CAPTURE_TIMEOUT_SECONDS,
    options.home,
  );

  log.info("wechat_user.key_recovery_started", { anchorPid: options.anchorPid });
  const outcome = await runner.run(
    {
      script,
      reason: "Recover the WeChat message-store key for the personal WeChat connection",
      timeoutSeconds: CAPTURE_TIMEOUT_SECONDS + 30,
      interpreter: "bash",
    },
    signal,
  );

  return parsePassphrase(outcome);
}

/**
 * The root script. It finds the host pid whose innermost namespaced pid is the
 * container pid we were handed, enters that process's namespaces, and execs the
 * staged driver there.
 *
 * NSpid in /proc/<hostpid>/status lists a process's pid in each nesting
 * namespace; the last field is the number the container itself sees. The PID
 * namespace identity distinguishes otherwise identical PIDs in other containers.
 */
function rootScript(
  anchorPid: number,
  pidNamespace: string,
  driverDir: string,
  timeoutSeconds: number,
  home?: string,
): string {
  const driver = join(driverDir, DRIVER_FILE);
  // The launched client must run under the runtime's home so the store lands
  // where the reader looks; the driver reads HOME from its environment.
  const homeEnv = home ? `env HOME=${sq(home)} ` : "";
  return [
    "set -eu",
    "command -v nsenter >/dev/null || { echo 'nsenter is not installed on the hosting VM' >&2; exit 6; }",
    `anchor=${anchorPid}`,
    `pid_namespace=${sq(pidNamespace)}`,
    "host_pid=''",
    "for st in /proc/[0-9]*/status; do",
    '  ns="$(awk \'/^NSpid:/{print $NF}\' "$st" 2>/dev/null || true)"',
    '  candidate="$(dirname "$st")"',
    '  if [ "$ns" = "$anchor" ] && [ "$(readlink "$candidate/ns/pid" 2>/dev/null || true)" = "$pid_namespace" ]; then host_pid="$(basename "$candidate")"; break; fi',
    "done",
    '[ -n "$host_pid" ] || { echo "no host pid for container pid $anchor" >&2; exit 4; }',
    'echo "host pid $host_pid for container anchor $anchor" >&2',
    // exec so the driver's stdout and exit code become the job's, unmediated.
    `exec nsenter -t "$host_pid" -m -u -i -n -p -- ${homeEnv}python3 ${sq(driver)} ${timeoutSeconds}`,
  ].join("\n");
}

/** Pull `PASSPHRASE <hex>` out of a finished job, or explain why it is absent. */
function parsePassphrase(outcome: RootScriptOutcome): string {
  if (outcome.status !== "succeeded" || outcome.exitCode !== 0) {
    throw new WechatUserKeyRecoveryError(
      `The key recovery script did not succeed (${outcome.status}, exit ${outcome.exitCode ?? "?"}). ${outcome.stderr.trim()}`,
    );
  }
  for (const line of outcome.stdout.split("\n")) {
    const match = /^PASSPHRASE ([0-9a-fA-F]{64})$/.exec(line.trim());
    if (match) return match[1]!.toLowerCase();
  }
  throw new WechatUserKeyRecoveryError(
    `The key recovery script produced no passphrase. ${outcome.stderr.trim()}`,
  );
}

/** Single-quote a value for safe inclusion in the shell script. */
function sq(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
