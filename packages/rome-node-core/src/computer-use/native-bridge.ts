import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
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
const DARWIN_ARM64_PACKAGE = "@rome-os/node-core-darwin-arm64";

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

function packagedComputerUseAppPath(): string {
  // Desktop bundles this module to CJS with esbuild (where import.meta is {}),
  // and always supplies bundledAppPath. Resolve lazily so CJS module load never throws.
  if (typeof import.meta.url === "string") {
    try {
      const manifestPath = createRequire(import.meta.url).resolve(
        `${DARWIN_ARM64_PACKAGE}/package.json`,
      );
      return join(dirname(manifestPath), "dist", "native", "Rome Computer Use.app");
    } catch {
      // Fall back when the optional darwin-arm64 package is not installed.
    }
    return fileURLToPath(new URL("../native/Rome Computer Use.app", import.meta.url));
  }
  return join("native", "Rome Computer Use.app");
}

export function computerUseAppPath(options: NativeBridgeOptions): string {
  return (
    options.appPath ??
    process.env.ROME_COMPUTER_USE_APP ??
    options.bundledAppPath ??
    packagedComputerUseAppPath()
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

function encodeFrame(
  id: string,
  token: string,
  method: string,
  params: Record<string, unknown>,
): Buffer {
  const json = Buffer.from(JSON.stringify({ id, token, method, params }));
  if (json.length > MAX_RPC_BYTES)
    throw new ComputerUseError("request_too_large", "The computer-use request is too large.");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length);
  return Buffer.concat([header, json]);
}

function request(
  socketPath: string,
  token: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  verifyHello?: (hello: unknown) => boolean | void,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    let requestFrame: Buffer;
    let helloId: string | undefined;
    let helloFrame: Buffer | undefined;
    try {
      requestFrame = encodeFrame(id, token, method, params);
      if (verifyHello) {
        helloId = randomUUID();
        helloFrame = encodeFrame(helloId, token, "hello", {});
      }
    } catch (error) {
      return reject(error);
    }
    let stage: "hello" | "method" = verifyHello ? "hello" : "method";
    let expectedId = helloId ?? id;
    let connected = false;
    let dispatched = false;
    let settled = false;
    let bytes = Buffer.alloc(0);
    const socket = connect(socketPath);
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(
      () =>
        finish(
          new ComputerUseError(
            "helper_timeout",
            "The computer-use helper did not return before the deadline.",
            { effectStatus: dispatched ? "unknown" : "not_dispatched" },
          ),
        ),
      timeoutMs,
    );
    socket.on("connect", () => {
      connected = true;
      if (stage === "hello") {
        socket.write(helloFrame!);
      } else {
        dispatched = true;
        socket.write(requestFrame);
      }
    });
    socket.on("data", (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      while (!settled) {
        if (bytes.length > MAX_RPC_BYTES + 4)
          return finish(
            new ComputerUseError(
              "invalid_helper_response",
              "The computer-use helper response is too large.",
              { effectStatus: dispatched ? "unknown" : "not_dispatched" },
            ),
          );
        if (bytes.length < 4) return;
        const size = bytes.readUInt32LE();
        if (!size || size > MAX_RPC_BYTES)
          return finish(
            new ComputerUseError(
              "invalid_helper_response",
              "The computer-use helper frame is invalid.",
              { effectStatus: dispatched ? "unknown" : "not_dispatched" },
            ),
          );
        if (bytes.length < size + 4) return;
        const payload = bytes.subarray(4, size + 4);
        bytes = bytes.subarray(size + 4);
        let response: unknown;
        try {
          response = JSON.parse(payload.toString("utf8"));
        } catch {
          return finish(
            new ComputerUseError(
              "invalid_helper_response",
              "The computer-use helper returned an invalid response.",
              { effectStatus: dispatched ? "unknown" : "not_dispatched" },
            ),
          );
        }
        if (!isRecord(response) || response.id !== expectedId)
          return finish(
            new ComputerUseError(
              "invalid_helper_response",
              "The computer-use helper returned an invalid response.",
              { effectStatus: dispatched ? "unknown" : "not_dispatched" },
            ),
          );
        if (
          response.ok === false &&
          isRecord(response.error) &&
          typeof response.error.code === "string" &&
          typeof response.error.message === "string"
        ) {
          const details = isRecord(response.error.details) ? response.error.details : {};
          return finish(
            new ComputerUseError(
              response.error.code,
              response.error.message,
              dispatched ? details : { ...details, effectStatus: "not_dispatched" },
            ),
          );
        }
        if (response.ok === true && Object.hasOwn(response, "result")) {
          if (stage === "hello") {
            try {
              if (verifyHello!(response.result) === false) return finish(undefined, undefined);
            } catch (error) {
              if (error instanceof ComputerUseError)
                return finish(
                  new ComputerUseError(error.code, error.message, {
                    ...error.details,
                    effectStatus: "not_dispatched",
                  }),
                );
              return finish(error instanceof Error ? error : new Error(String(error)));
            }
            if (bytes.length > 0)
              return finish(
                new ComputerUseError(
                  "invalid_helper_response",
                  "The computer-use helper returned unexpected trailing data.",
                  { effectStatus: "not_dispatched" },
                ),
              );
            stage = "method";
            expectedId = id;
            dispatched = true;
            socket.write(requestFrame);
            return;
          }
          return finish(undefined, response.result);
        }
        return finish(
          new ComputerUseError(
            "invalid_helper_response",
            "The computer-use helper returned an invalid response.",
            { effectStatus: dispatched ? "unknown" : "not_dispatched" },
          ),
        );
      }
    });
    socket.on("error", (error: NodeJS.ErrnoException) =>
      finish(
        new ComputerUseError(
          connected ? "helper_connection_lost" : "helper_unavailable",
          "The computer-use helper connection is unavailable.",
          { effectStatus: dispatched ? "unknown" : "not_dispatched", socketCode: error.code },
        ),
      ),
    );
    socket.on("close", () =>
      finish(
        new ComputerUseError(
          "helper_connection_lost",
          "The computer-use helper connection closed without a reply.",
          { effectStatus: dispatched ? "unknown" : "not_dispatched" },
        ),
      ),
    );
  });
}

function createSocketPreparer(
  stateDir: string,
): () => Promise<{ socketPath: string; token: string }> {
  let prepared: Promise<{ socketPath: string; token: string }> | undefined;
  return () =>
    (prepared ??= (async () => {
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
    }));
}

/** Every request has its own socket, so cancel does not wait behind an in-flight action. */
export function createNativeRpcTransport(options: NativeBridgeOptions = {}): ComputerUseNative {
  const prepare = createSocketPreparer(options.stateDir ?? defaultComputerUseStateDir());
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  return {
    async call(method, params) {
      const { socketPath, token } = await prepare();
      return request(socketPath, token, method, params, requestTimeoutMs);
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

function matchesComputerUseImplementation(value: unknown, asset: ComputerUseApp): boolean {
  const hello = parseComputerUseHello(value);
  return (
    hello.bundleId === "com.rome.computer-use" &&
    hello.implementationSha256 === asset.implementationSha256 &&
    hello.architecture === asset.architecture
  );
}

function assertComputerUseImplementation(value: unknown, asset: ComputerUseApp): void {
  if (!matchesComputerUseImplementation(value, asset))
    throw new ComputerUseError(
      "helper_update_required",
      "A different or unidentified helper is running. Finish its work and close it before starting this version.",
      { effectStatus: "not_dispatched" },
    );
}

function parseNumericVersion(value: unknown): number[] | null {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)*$/.test(value)) return null;
  return value.split(".").map((part) => Number(part));
}

function isNewerVersion(candidate: unknown, running: unknown): boolean {
  const left = parseNumericVersion(candidate);
  const right = parseNumericVersion(running);
  if (!left || !right) return false;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

function isIdleMismatchedHelper(value: unknown, asset: ComputerUseApp): boolean {
  const hello = parseComputerUseHello(value);
  return (
    hello.bundleId === "com.rome.computer-use" &&
    typeof hello.implementationSha256 === "string" &&
    (hello.implementationSha256 !== asset.implementationSha256 ||
      hello.architecture !== asset.architecture) &&
    isNewerVersion(asset.version, hello.version) &&
    hello.activeSessions === 0 &&
    isRecord(hello.execution) &&
    hello.execution.busy === false
  );
}

/** A default package stages its signed app at a stable per-user path before launching it. */
export function createComputerUseNativeBridge(
  options: NativeBridgeOptions = {},
): ComputerUseNative {
  const stateDir = options.stateDir ?? defaultComputerUseStateDir();
  const prepare = createSocketPreparer(stateDir);
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const callSocket = async (
    method: string,
    params: Record<string, unknown>,
    verifyHello?: (hello: unknown) => boolean | void,
  ) => {
    const { socketPath, token } = await prepare();
    return request(socketPath, token, method, params, requestTimeoutMs, verifyHello);
  };
  let ready: Promise<ComputerUseApp> | undefined;
  async function initialize(): Promise<ComputerUseApp> {
    const source = await inspectComputerUseApp(computerUseAppPath(options));
    const canonicalStateDir = await privateComputerUseDirectory(stateDir);
    const until = Date.now() + (options.startupTimeoutMs ?? 10_000);
    let handedOff = false;
    try {
      const helloValue = await callSocket("hello", {});
      try {
        assertComputerUseImplementation(helloValue, source);
        return source;
      } catch (error) {
        if (!isIdleMismatchedHelper(helloValue, source)) throw error;
        // The helper is an LSUIElement with no Dock icon; after an auto-update or CLI upgrade,
        // ask an idle older Rome helper to shut down so we can stage and start this version.
        try {
          await callSocket("shutdown", { idleOnly: true }, (currentHello) => {
            if (!isIdleMismatchedHelper(currentHello, source)) {
              assertComputerUseImplementation(currentHello, source);
              return false;
            }
          });
        } catch (shutdownError) {
          if (
            !(shutdownError instanceof ComputerUseError) ||
            !["helper_connection_lost", "helper_unavailable"].includes(shutdownError.code)
          )
            throw error;
        }
        for (;;) {
          try {
            const currentHello = await callSocket("hello", {});
            if (matchesComputerUseImplementation(currentHello, source)) return source;
          } catch (pollError) {
            if (unavailable(pollError)) {
              handedOff = true;
              break;
            }
          }
          if (Date.now() >= until) throw error;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    } catch (error) {
      if (!unavailable(error)) throw error;
    }
    const explicit =
      options.appPath !== undefined || process.env.ROME_COMPUTER_USE_APP !== undefined;
    for (;;) {
      try {
        const app = explicit ? source : await prepareComputerUseApp(source, canonicalStateDir);
        await runFile(
          "/usr/bin/open",
          ["-g", "-a", app.path, "--args", "--state-dir", canonicalStateDir],
          {
            timeout: Math.max(1, until - Date.now()),
          },
        );
        break;
      } catch (error) {
        // Right after idle shutdown, the exiting helper can unlink helper.sock slightly before
        // closing service.lock; retry briefly before assuming another caller won the lock.
        if (
          handedOff &&
          error instanceof ComputerUseError &&
          error.code === "helper_install_busy" &&
          Date.now() < until
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          continue;
        }
        // Another caller can win the install/service lock after our first hello.
        if (!(error instanceof ComputerUseError) || error.code !== "helper_install_busy")
          throw error;
        break;
      }
    }
    for (;;) {
      try {
        assertComputerUseImplementation(await callSocket("hello", {}), source);
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
      return callSocket("stop_status", { sessionId }, (helloValue) => {
        const hello = parseComputerUseHello(helloValue);
        assertComputerUseImplementation(hello, source);
        const background = hello.capabilities.background;
        return isRecord(background) && background.sessionRecovery === true;
      });
    },
    async call(method, params) {
      let source = await ensure();
      // Verify the connected helper's identity on the same socket before writing any non-hello
      // request so a replacement helper cannot take over helper.sock between check and dispatch.
      const verify =
        method === "hello"
          ? undefined
          : (helloValue: unknown) => {
              assertComputerUseImplementation(helloValue, source);
            };
      let value: unknown;
      try {
        value = await callSocket(method, params, verify);
      } catch (error) {
        // A socket that never connected dispatched nothing. Written requests are never retried.
        if (!unavailable(error)) throw error;
        ready = undefined;
        source = await ensure();
        value = await callSocket(method, params, verify);
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
