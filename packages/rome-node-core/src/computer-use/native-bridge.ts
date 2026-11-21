import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isRecord } from "../actions.js";
import {
  inspectComputerUseApp,
  prepareComputerUseApp,
  type ComputerUseApp,
} from "./native-assets.js";
import { ComputerUseError, parseComputerUseHello } from "./protocol.js";

const MAX_RPC_BYTES = 8 * 1024 * 1024;
const runFile = promisify(execFile);

export interface ComputerUseNative {
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
  readStopStatus?(sessionId: string): Promise<unknown>;
}

export interface NativeBridgeOptions {
  appPath?: string;
  bundledAppPath?: string;
  stateDir?: string;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
}

export function defaultComputerUseStateDir(): string {
  return join(homedir(), "Library", "Application Support", "Rome", "ComputerUse");
}

export function computerUseAppPath(options: NativeBridgeOptions): string {
  return (
    options.appPath ??
    process.env.ROME_COMPUTER_USE_APP ??
    options.bundledAppPath ??
    fileURLToPath(new URL("../native/Rome Computer Use.app", import.meta.url))
  );
}

/** Refuses links and permissive existing paths rather than repairing someone else's state. */
export async function privateComputerUseDirectory(path: string): Promise<string> {
  if (!isAbsolute(path))
    throw new ComputerUseError(
      "invalid_state_directory",
      "The computer-use state directory must be absolute.",
    );
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new ComputerUseError(
      "unsafe_state_directory",
      "The computer-use state directory must belong to this user and have mode 0700.",
    );
  return realpath(path);
}

async function privateToken(stateDir: string): Promise<string> {
  const path = join(stateDir, "token");
  const temporary = join(stateDir, `.token-${randomUUID()}`);
  const pending = await open(temporary, "wx", 0o600);
  try {
    await pending.writeFile(randomBytes(32).toString("hex") + "\n");
    await pending.sync();
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await pending.close();
    await unlink(temporary).catch(() => {});
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      info.size > 128
    )
      throw new ComputerUseError(
        "unsafe_helper_token",
        "The computer-use token must be an owner-only regular file.",
      );
    const token = (await file.readFile("utf8")).trim();
    if (!/^[0-9a-f]{64}$/.test(token))
      throw new ComputerUseError(
        "invalid_helper_token",
        "The computer-use helper token is invalid.",
      );
    return token;
  } finally {
    await file.close();
  }
}

function request(
  socketPath: string,
  token: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const json = Buffer.from(JSON.stringify({ id, token, method, params }));
    if (json.length > MAX_RPC_BYTES)
      return reject(
        new ComputerUseError("request_too_large", "The computer-use request is too large."),
      );
    const header = Buffer.alloc(4);
    header.writeUInt32LE(json.length);
    let sent = false;
    let settled = false;
    let bytes = Buffer.alloc(0);
    const socket = connect(socketPath);
    const timer = setTimeout(
      () =>
        finish(
          new ComputerUseError(
            "helper_timeout",
            "The computer-use helper did not return before the deadline.",
            { effectStatus: sent ? "unknown" : "not_dispatched" },
          ),
        ),
      timeoutMs,
    );
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    socket.on("connect", () => {
      sent = true;
      socket.write(Buffer.concat([header, json]));
    });
    socket.on("data", (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > MAX_RPC_BYTES + 4)
        return finish(
          new ComputerUseError(
            "invalid_helper_response",
            "The computer-use helper response is too large.",
            { effectStatus: "unknown" },
          ),
        );
      if (bytes.length < 4) return;
      const size = bytes.readUInt32LE();
      if (!size || size > MAX_RPC_BYTES)
        return finish(
          new ComputerUseError(
            "invalid_helper_response",
            "The computer-use helper frame is invalid.",
            { effectStatus: "unknown" },
          ),
        );
      if (bytes.length < size + 4) return;
      try {
        const response: unknown = JSON.parse(bytes.subarray(4, size + 4).toString("utf8"));
        if (!isRecord(response) || response.id !== id) throw new Error("Unexpected response id");
        if (response.ok === true && Object.hasOwn(response, "result"))
          return finish(undefined, response.result);
        if (
          response.ok === false &&
          isRecord(response.error) &&
          typeof response.error.code === "string" &&
          typeof response.error.message === "string"
        )
          return finish(
            new ComputerUseError(
              response.error.code,
              response.error.message,
              isRecord(response.error.details) ? response.error.details : {},
            ),
          );
        throw new Error("Unexpected response shape");
      } catch {
        finish(
          new ComputerUseError(
            "invalid_helper_response",
            "The computer-use helper returned an invalid response.",
            { effectStatus: "unknown" },
          ),
        );
      }
    });
    socket.on("error", (error: NodeJS.ErrnoException) =>
      finish(
        new ComputerUseError(
          sent ? "helper_connection_lost" : "helper_unavailable",
          "The computer-use helper connection is unavailable.",
          { effectStatus: sent ? "unknown" : "not_dispatched", socketCode: error.code },
        ),
      ),
    );
    socket.on("close", () =>
      finish(
        new ComputerUseError(
          "helper_connection_lost",
          "The computer-use helper connection closed without a reply.",
          { effectStatus: sent ? "unknown" : "not_dispatched" },
        ),
      ),
    );
  });
}

/** Every request has its own socket, so cancel does not wait behind an in-flight action. */
export function createNativeRpcTransport(options: NativeBridgeOptions = {}): ComputerUseNative {
  const stateDir = options.stateDir ?? defaultComputerUseStateDir();
  let prepared: Promise<{ socketPath: string; token: string }> | undefined;
  return {
    async call(method, params) {
      prepared ??= (async () => {
        const canonicalDir = await privateComputerUseDirectory(stateDir);
        const socketPath = join(canonicalDir, "helper.sock");
        if (Buffer.byteLength(socketPath) > 103)
          throw new ComputerUseError(
            "helper_path_too_long",
            "The computer-use state directory is too long for a macOS Unix socket.",
          );
        return { socketPath, token: await privateToken(canonicalDir) };
      })().catch((error: unknown) => {
        prepared = undefined;
        throw error;
      });
      const { socketPath, token } = await prepared;
      return request(socketPath, token, method, params, options.requestTimeoutMs ?? 15_000);
    },
  };
}

function unavailable(error: unknown): boolean {
  return (
    error instanceof ComputerUseError &&
    error.code === "helper_unavailable" &&
    error.details.effectStatus === "not_dispatched" &&
    ["ENOENT", "ECONNREFUSED"].includes(String(error.details.socketCode))
  );
}

function assertComputerUseImplementation(value: unknown, asset: ComputerUseApp): void {
  const hello = parseComputerUseHello(value);
  if (
    hello.bundleId !== "com.rome.computer-use" ||
    hello.implementationSha256 !== asset.implementationSha256 ||
    hello.architecture !== asset.architecture
  )
    throw new ComputerUseError(
      "helper_update_required",
      "A different or unidentified helper is running. Finish its work and close it before starting this version.",
      { effectStatus: "not_dispatched" },
    );
}

/** A default package stages its signed app at a stable per-user path before launching it. */
export function createComputerUseNativeBridge(
  options: NativeBridgeOptions = {},
): ComputerUseNative {
  const stateDir = options.stateDir ?? defaultComputerUseStateDir();
  const transport = createNativeRpcTransport(options);
  let ready: Promise<ComputerUseApp> | undefined;
  async function initialize(): Promise<ComputerUseApp> {
    const source = await inspectComputerUseApp(computerUseAppPath(options));
    const canonicalStateDir = await privateComputerUseDirectory(stateDir);
    try {
      assertComputerUseImplementation(await transport.call("hello", {}), source);
      return source;
    } catch (error) {
      if (!unavailable(error)) throw error;
    }
    const explicit =
      options.appPath !== undefined || process.env.ROME_COMPUTER_USE_APP !== undefined;
    const until = Date.now() + (options.startupTimeoutMs ?? 10_000);
    try {
      const app = explicit ? source : await prepareComputerUseApp(source, canonicalStateDir);
      await runFile(
        "/usr/bin/open",
        ["-g", "-a", app.path, "--args", "--state-dir", canonicalStateDir],
        {
          timeout: Math.max(1, until - Date.now()),
        },
      );
    } catch (error) {
      // Another caller can win the install/service lock after our first hello.
      if (!(error instanceof ComputerUseError) || error.code !== "helper_install_busy") throw error;
    }
    for (;;) {
      try {
        assertComputerUseImplementation(await transport.call("hello", {}), source);
        return source;
      } catch (error) {
        if (!unavailable(error) || Date.now() >= until) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
  const ensure = () =>
    (ready ??= initialize().catch((error: unknown) => {
      ready = undefined;
      if (error instanceof ComputerUseError)
        throw new ComputerUseError(error.code, error.message, {
          ...error.details,
          effectStatus: "not_dispatched",
        });
      throw new ComputerUseError(
        "helper_start_failed",
        "The verified computer-use helper could not be started.",
        { effectStatus: "not_dispatched" },
      );
    }));
  return {
    async readStopStatus(sessionId) {
      const source = await inspectComputerUseApp(computerUseAppPath(options));
      const hello = parseComputerUseHello(await transport.call("hello", {}));
      assertComputerUseImplementation(hello, source);
      const background = hello.capabilities.background;
      if (!isRecord(background) || background.sessionRecovery !== true) return undefined;
      return transport.call("stop_status", { sessionId });
    },
    async call(method, params) {
      const hadReady = ready !== undefined;
      let source = await ensure();
      // Revalidate the live helper before every non-hello dispatch so a helper replaced
      // between calls cannot receive actions without matching the verified implementation.
      if (hadReady && method !== "hello") {
        try {
          assertComputerUseImplementation(await transport.call("hello", {}), source);
        } catch (error) {
          ready = undefined;
          if (!unavailable(error)) {
            if (error instanceof ComputerUseError)
              throw new ComputerUseError(error.code, error.message, {
                ...error.details,
                effectStatus: "not_dispatched",
              });
            throw error;
          }
          source = await ensure();
        }
      }
      let value: unknown;
      try {
        value = await transport.call(method, params);
      } catch (error) {
        // A socket that never connected dispatched nothing. Written requests are never retried.
        if (!unavailable(error)) throw error;
        ready = undefined;
        source = await ensure();
        value = await transport.call(method, params);
      }
      if (method === "hello") {
        try {
          assertComputerUseImplementation(value, source);
        } catch (error) {
          ready = undefined;
          throw error;
        }
      }
      return value;
    },
  };
}
