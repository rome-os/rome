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
import { createConnection, type Socket } from "node:net";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { ComputerUseError } from "./protocol.js";

const APP_NAME = "Rome Computer Use.app";
const EXECUTABLE = "Contents/MacOS/RomeComputerUse";
export const RELEASE_SIGNING_REQUIREMENT =
  'anchor apple generic and identifier "com.rome.computer-use" and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "4YWXB26F39"';
const SOCKET_NAME = "helper.sock";
const STATE_PREFIX = "rome-cu-";
const SOCKET_PATH_LIMIT = 103;
const POLL_INTERVAL_MS = 25;
const run = promisify(execFile);

interface LaunchContext {
  appPath?: string;
  stateDir: string;
  signal: AbortSignal;
}

export interface LaunchOptions {
  appPath?: string;
  stateRoot?: string;
  startupTimeoutMs?: number;
  verifyBundle?: (appPath: string, signal: AbortSignal) => void | Promise<void>;
  launcher?: (context: LaunchContext) => void | Promise<void>;
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
    return await Promise.race([Promise.resolve().then(runOperation), stopped]);
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

async function validatedApp(
  options: LaunchOptions,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (!options.appPath && options.launcher) return;
  try {
    if (!options.appPath) throw new Error(`Expected an app named ${APP_NAME}`);
    const appPath = realpathSync(options.appPath);
    const executable = join(appPath, EXECUTABLE);
    if (
      basename(appPath) !== APP_NAME ||
      !stat(appPath)?.isDirectory() ||
      !stat(executable)?.isFile() ||
      realpathSync(executable) !== executable
    ) {
      throw new Error("The helper app or its executable is missing");
    }
    accessSync(executable, constants.X_OK);
    const verify = options.verifyBundle ?? verifySignedBundle;
    await untilAbort(() => verify(appPath, signal), signal);
    return appPath;
  } catch (cause) {
    throw new ComputerUseError("invalid_helper_bundle", { cause });
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
  const { signal } = deadline;
  let state: ReturnType<typeof prepareState> | undefined;
  let socket: Socket | undefined;
  try {
    const appPath = await validatedApp(options, signal);
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
    if (signal.aborted) throw new ComputerUseError("startup_timeout");
    if (cause instanceof ComputerUseError) throw cause;
    throw new ComputerUseError("socket_unavailable", { cause });
  } finally {
    clearTimeout(timer);
  }
}
