// Recovering the WeChat message-store key, the one step that needs a debugger.
//
// The store is SQLCipher, keyed by a passphrase the client only ever holds in
// memory and only ever derives during a login. Reading it out needs ptrace on
// the client as it signs in. Rome's own container can do that: it launches the
// client under gdb from inside the container and reads the value back out. The
// container already carries the capability the debugger needs (SYS_ADMIN, and
// AppArmor unconfined), and gdb traces a child it launched, so no host-root
// script or namespace crossing is involved — the capture is an ordinary local
// subprocess. Rome then derives and verifies the per-database keys in the same
// container, where the databases are.
//
// It recovers the key by launching the client under gdb, not by attaching to a
// running one. The passphrase is derived once, at the first login, and a
// fresh-QR login re-execs into a new image — attaching after the client is up
// misses that derivation and forces a second, in-process login. Launching owns
// the client from its first instruction and re-arms the breakpoint across every
// exec, so the very first login is caught with nothing asked of the guardian
// twice.
//
// The mechanics: Rome stages the launch driver and the vendored key tool in a
// private directory under /run, then runs the driver directly. The driver
// launches the client the container's own way, catches the key the first login
// derives, and prints only the passphrase on stdout.

import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../logger.js";
import { runCommand, type RunCommand, type RunResult } from "./wechat-user.js";

const log = createLogger("wechat-user-keys");

/** The capture launches the client and waits for the guardian to scan and for
 *  the login to derive the key, so it needs room. */
const CAPTURE_TIMEOUT_SECONDS = 540;

/** How much longer the parent waits before killing the driver, so the driver's
 *  own timeout fires first and yields a clean diagnostic. */
const CAPTURE_GRACE_SECONDS = 30;

/** Where Rome stages the driver and key tool. A private directory under /run,
 *  owned by the runtime user; the driver runs against these paths in place. */
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
 * Stage the launch driver and the vendored key tool in a private directory, so
 * the capture can run them. Returns a private, unique directory. The caller
 * removes it after recovery.
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
  /** Where the driver was staged, inside this container. */
  driverDir: string;
  /** The home the launched client must run under, so the store it writes lands
   *  where the Rome runtime reads it. Defaults to the container's own HOME. */
  home?: string;
  /** Override the capture window (seconds). Defaults to CAPTURE_TIMEOUT_SECONDS. */
  timeoutSeconds?: number;
}

/**
 * Recover the message-store passphrase by launching the client under gdb inside
 * this container. Resolves with the 64-char hex passphrase, which the caller
 * derives per-database keys from.
 *
 * A login must happen while this runs — the driver launches the client, the
 * guardian scans, and the breakpoint fires on the login's key derivation. The
 * caller shows the scan walkthrough alongside it. The debugger is injectable as
 * `run` so tests never spawn a process.
 */
export async function recoverWechatPassphrase(
  options: WechatKeyRecoveryOptions,
  signal?: AbortSignal,
  run: RunCommand = runCommand,
): Promise<string> {
  const timeoutSeconds = options.timeoutSeconds ?? CAPTURE_TIMEOUT_SECONDS;
  const driver = join(options.driverDir, DRIVER_FILE);

  log.info("wechat_user.key_recovery_started", {});
  const result = await run("python3", [driver, String(timeoutSeconds)], {
    timeoutMs: (timeoutSeconds + CAPTURE_GRACE_SECONDS) * 1000,
    // The launched client must run under the runtime's home so the store lands
    // where the reader looks; the driver reads HOME from its environment.
    ...(options.home ? { env: { HOME: options.home } } : {}),
    ...(signal ? { signal } : {}),
  });

  return parsePassphrase(result);
}

/** Pull `PASSPHRASE <hex>` out of a finished capture, or explain its absence. */
function parsePassphrase(result: RunResult): string {
  if (result.code !== 0) {
    throw new WechatUserKeyRecoveryError(
      `The key capture did not succeed (exit ${result.code ?? "?"}). ${result.stderr.trim()}`,
    );
  }
  for (const line of result.stdout.split("\n")) {
    const match = /^PASSPHRASE ([0-9a-fA-F]{64})$/.exec(line.trim());
    if (match) return match[1]!.toLowerCase();
  }
  throw new WechatUserKeyRecoveryError(
    `The key capture produced no passphrase. ${result.stderr.trim()}`,
  );
}
