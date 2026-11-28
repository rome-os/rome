import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { addAbortListener, once } from "node:events";
import {
  accessSync,
  type BigIntStats,
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { isRecord } from "../actions.js";
import { ComputerUseError } from "./protocol.js";

export const APP_NAME = "Rome Computer Use.app";
const EXECUTABLE = "Contents/MacOS/RomeComputerUse";
export const RELEASE_SIGNING_REQUIREMENT =
  'anchor apple generic and identifier "com.rome.computer-use" and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "4YWXB26F39"';
const SOCKET_NAME = "helper.sock";
const STATE_PREFIX = "rome-cu-";
const SOCKET_PATH_LIMIT = 103;
const POLL_INTERVAL_MS = 25;
const run = promisify(execFile);

export function stagedHelperPath(home = homedir()): string {
  return join(home, ".rome-computer-use", APP_NAME);
}

interface LaunchContext {
  appPath?: string;
  stateDir: string;
  signal: AbortSignal;
}

export interface LaunchOptions {
  appPath?: string;
  signal?: AbortSignal;
  stateRoot?: string;
  startupTimeoutMs?: number;
  verifyBundle?: (appPath: string, signal: AbortSignal) => void | Promise<void>;
  launcher?: (context: LaunchContext) => void | Promise<void>;
}

export type PermissionSetupPane = "accessibility" | "screen-recording" | "all";

export interface PermissionSetupOptions {
  appPath: string;
  pane?: PermissionSetupPane;
  locale?: string;
  signal?: AbortSignal;
  startupTimeoutMs?: number;
  verifyBundle?: LaunchOptions["verifyBundle"];
  launcher?: (args: string[], signal: AbortSignal) => void | Promise<void>;
}

const exitCleanups = new Set<() => void>();

function cleanOnExit(): void {
  for (const cleanup of exitCleanups) {
    try {
      cleanup();
    } catch {
      // Attempt the other cleanups even when a directory cannot be removed.
    }
  }
}

function stat(path: string): BigIntStats | undefined {
  return lstatSync(path, { bigint: true, throwIfNoEntry: false });
}

function sameInode(before: BigIntStats, after: BigIntStats | undefined): boolean {
  return before.dev === after?.dev && before.ino === after.ino;
}

function privateMode(info: BigIntStats, uid: number, mode: bigint): boolean {
  return info.uid === BigInt(uid) && (info.mode & 0o7777n) === mode;
}

function prepareState(root: string, uid: number, secret: Buffer) {
  const prefix = join(realpathSync(root), STATE_PREFIX);
  if (Buffer.byteLength(join(`${prefix}XXXXXX`, SOCKET_NAME)) > SOCKET_PATH_LIMIT) {
    throw new ComputerUseError("socket_path_limit");
  }
  const stateDir = mkdtempSync(prefix);
  const identity = lstatSync(stateDir, { bigint: true });
  const socketPath = join(stateDir, SOCKET_NAME);
  const cleanup = () => {
    exitCleanups.delete(cleanup);
    if (exitCleanups.size === 0) process.off("exit", cleanOnExit);
    if (sameInode(identity, stat(stateDir))) {
      rmSync(stateDir, { force: true, recursive: true, maxRetries: 2, retryDelay: 10 });
    }
  };
  if (exitCleanups.size === 0) process.on("exit", cleanOnExit);
  exitCleanups.add(cleanup);

  try {
    chmodSync(stateDir, 0o700);
    const bootstrap = JSON.stringify({
      secret: secret.toString("hex"),
      hostPid: process.pid,
      hostExecutable: realpathSync(process.execPath),
    });
    const fd = openSync(
      join(stateDir, "bootstrap.json"),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, bootstrap);
    } finally {
      closeSync(fd);
    }
  } catch (cause) {
    cleanup();
    throw cause;
  }

  const inspectSocket = () => {
    const dir = stat(stateDir);
    if (
      !dir?.isDirectory() ||
      !privateMode(dir, uid, 0o700n) ||
      !sameInode(identity, dir) ||
      realpathSync(stateDir) !== stateDir
    ) {
      throw new ComputerUseError("unsafe_state_directory");
    }
    const info = stat(socketPath);
    if (info && (!info.isSocket() || !privateMode(info, uid, 0o600n))) {
      throw new ComputerUseError("socket_unavailable");
    }
    return info;
  };

  return { stateDir, socketPath, cleanup, inspectSocket };
}

export async function untilAbort<T>(
  runOperation: () => T | Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
  });
  const listener = addAbortListener(signal, abort);
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return runOperation();
      }),
      stopped,
    ]);
  } finally {
    listener[Symbol.dispose]();
  }
}

async function verifySignedBundle(appPath: string, signal: AbortSignal): Promise<void> {
  await run(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", `-R=${RELEASE_SIGNING_REQUIREMENT}`, appPath],
    { signal },
  );
}

export async function verifyHelperBundle(
  path: string,
  signal: AbortSignal,
  verify: NonNullable<LaunchOptions["verifyBundle"]> = verifySignedBundle,
): Promise<string> {
  try {
    const appPath = realpathSync(path);
    const executable = join(appPath, EXECUTABLE);
    if (
      // The staged path must not redirect LaunchServices back inside Rome.app.
      (path === stagedHelperPath() && appPath !== stagedHelperPath(realpathSync(homedir()))) ||
      basename(appPath) !== APP_NAME ||
      !stat(appPath)?.isDirectory() ||
      !stat(executable)?.isFile() ||
      realpathSync(executable) !== executable
    ) {
      throw new Error("The helper app or its executable is missing");
    }
    accessSync(executable, constants.X_OK);
    await untilAbort(() => verify(appPath, signal), signal);
    return appPath;
  } catch (cause) {
    throw new ComputerUseError("invalid_helper_bundle", { cause });
  }
}

async function readOptionalFile(path: string, signal: AbortSignal): Promise<string> {
  try {
    return await readFile(path, { encoding: "utf8", signal });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

const SETUP_FAILURE_CODES = new Set([
  "invalid_request",
  "desktop_disabled",
  "console_unavailable",
  "permission_setup_unavailable",
]);

function helperSetupFailure(output: string): ComputerUseError | undefined {
  for (const line of output.split(/\r?\n/)) {
    const code = line.trim();
    if (!SETUP_FAILURE_CODES.has(code)) continue;
    if (
      code === "invalid_request" ||
      code === "desktop_disabled" ||
      code === "console_unavailable"
    ) {
      return new ComputerUseError(code);
    }
    return new ComputerUseError("internal_error", { cause: new Error(code) });
  }
  return undefined;
}

export async function launchPermissionSetup(options: PermissionSetupOptions): Promise<void> {
  if (!options.launcher && process.platform !== "darwin") {
    throw new ComputerUseError("computer_use_unsupported_platform");
  }
  const waitMs = options.startupTimeoutMs ?? 2500;
  const timeout = AbortSignal.timeout(Math.max(5000, waitMs + 2500));
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const app = await untilAbort(
    () => verifyHelperBundle(options.appPath, signal, options.verifyBundle),
    signal,
  );
  const directory = await mkdtemp(join(tmpdir(), "rome-cu-setup-"));
  const stdoutPath = join(directory, "stdout.txt");
  const stderrPath = join(directory, "stderr.txt");
  const args = [
    "-n",
    "--stdout",
    stdoutPath,
    "--stderr",
    stderrPath,
    "-a",
    app,
    "--args",
    "--setup-permissions",
  ];
  if (options.pane !== undefined) args.push(options.pane);
  if (options.locale !== undefined) args.push("--locale", options.locale);
  const launch =
    options.launcher ??
    (async (launchArgs, launchSignal) => {
      await run("/usr/bin/open", launchArgs, { signal: launchSignal });
    });
  try {
    await untilAbort(() => launch(args, signal), signal);
    const deadline = Date.now() + waitMs;
    while (true) {
      signal.throwIfAborted();
      const stdout = await readOptionalFile(stdoutPath, signal);
      if (stdout.split(/\r?\n/).includes("ready")) return;
      const stderr = await readOptionalFile(stderrPath, signal);
      const failure = helperSetupFailure(stderr);
      if (failure) throw failure;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        if (stderr.trim()) {
          throw new ComputerUseError("internal_error", { cause: new Error(stderr.trim()) });
        }
        throw new ComputerUseError("startup_timeout");
      }
      await delay(Math.min(POLL_INTERVAL_MS, remaining), undefined, { signal });
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

export async function probeHelperPermissions(path: string): Promise<boolean | undefined> {
  const signal = AbortSignal.timeout(2500);
  const app = await verifyHelperBundle(path, signal);
  const directory = await mkdtemp("/private/tmp/rome-cu-permissions-");
  const output = join(directory, "permissions.json");
  try {
    const args = ["-n", "-g", "-j", "-W", "--stdout", output, "--stderr", "/dev/null"];
    args.push("-a", app, "--args", "--check-permissions");
    // Direct execution can inherit the host's TCC identity. LaunchServices checks the app.
    await run("/usr/bin/open", args, { signal }).catch(() => {
      // A short-lived app can exit before open registers its wait, with valid output.
    });
    const result: unknown = JSON.parse(await readFile(output, { encoding: "utf8", signal }));
    if (
      isRecord(result) &&
      typeof result.accessibility === "boolean" &&
      typeof result.screenRecording === "boolean"
    ) {
      return result.accessibility && result.screenRecording;
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function connect(socketPath: string, signal: AbortSignal): Promise<Socket | undefined> {
  signal.throwIfAborted();
  const socket = createConnection(socketPath);
  try {
    await once(socket, "connect", { signal });
    return socket;
  } catch (error) {
    socket.destroy();
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ECONNREFUSED")
    )
      return;
    throw error;
  }
}

export async function launchHelper(options: LaunchOptions) {
  const uid = process.getuid?.();
  if (uid === undefined || (!options.launcher && process.platform !== "darwin")) {
    throw new ComputerUseError("socket_unavailable");
  }
  const secret = randomBytes(32);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), options.startupTimeoutMs ?? 10_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  let state: ReturnType<typeof prepareState> | undefined;
  let socket: Socket | undefined;
  try {
    signal.throwIfAborted();
    const appPath = options.appPath
      ? await verifyHelperBundle(options.appPath, signal, options.verifyBundle)
      : undefined;
    if (!appPath && !options.launcher) throw new ComputerUseError("invalid_helper_bundle");
    signal.throwIfAborted();
    state = prepareState(
      options.stateRoot ?? (process.platform === "darwin" ? "/private/tmp" : "/tmp"),
      uid,
      secret,
    );
    const { stateDir, socketPath, inspectSocket, cleanup } = state;
    if (options.launcher) {
      const launch = options.launcher;
      await untilAbort(() => launch({ appPath, stateDir, signal }), signal);
    } else {
      await run("/usr/bin/open", ["-n", "-a", appPath!, "--args", "--serve", stateDir], {
        signal,
      });
    }

    while (!signal.aborted) {
      const before = inspectSocket();
      if (before) {
        socket = await connect(socketPath, signal);
        if (socket) {
          if (!sameInode(before, inspectSocket())) throw new ComputerUseError("socket_unavailable");
          return { socket, secret, cleanup };
        }
      }
      await delay(POLL_INTERVAL_MS, undefined, { signal });
    }
    throw signal.reason;
  } catch (cause) {
    socket?.destroy();
    secret.fill(0);
    state?.cleanup();
    if (options.signal?.aborted) throw new ComputerUseError("request_aborted");
    if (deadline.signal.aborted) throw new ComputerUseError("startup_timeout");
    if (cause instanceof ComputerUseError) throw cause;
    throw new ComputerUseError("socket_unavailable", { cause });
  } finally {
    clearTimeout(timer);
  }
}
