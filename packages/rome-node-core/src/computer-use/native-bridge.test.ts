import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { ComputerUseError } from "./protocol.js";
import { createComputerUseNativeBridge, createNativeRpcTransport } from "./native-bridge.js";

const assets = rs.hoisted(() => ({ inspect: rs.fn(), prepare: rs.fn(), launch: rs.fn() }));
rs.mock("./native-assets.js", () => ({
  inspectComputerUseApp: assets.inspect,
  prepareComputerUseApp: assets.prepare,
}));
rs.mock("node:child_process", () => ({ execFile: assets.launch }));

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  rs.clearAllMocks();
  rs.unstubAllEnvs();
});

async function server(
  reply: (
    request: Record<string, unknown>,
    send: (result: unknown) => void,
    fail: (error: { code: string; message: string; details?: unknown }) => void,
  ) => void,
) {
  const stateDir = await mkdtemp("/tmp/rome-cua-rpc-");
  const sockets = new Set<Socket>();
  const calls: Array<Record<string, unknown>> = [];
  const service = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4 || buffer.length < 4 + buffer.readUInt32LE()) return;
      const request = JSON.parse(buffer.subarray(4).toString("utf8")) as Record<string, unknown>;
      calls.push(request);
      const respond = (value: unknown) => {
        const response = Buffer.from(JSON.stringify(value));
        const header = Buffer.alloc(4);
        header.writeUInt32LE(response.length);
        socket.write(header.subarray(0, 2));
        socket.write(Buffer.concat([header.subarray(2), response]));
      };
      reply(
        request,
        (result) => respond({ id: request.id, ok: true, result }),
        (error) => respond({ id: request.id, ok: false, error }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    service.once("error", reject);
    service.listen(join(stateDir, "helper.sock"), resolve);
  });
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => service.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  });
  return {
    stateDir,
    calls,
    bridge: createNativeRpcTransport({ stateDir, requestTimeoutMs: 100 }),
  };
}

describe("native computer-use transport", () => {
  it.each([
    "bundle",
    "option",
    "environment",
  ])("stages only bundled sources and launches the selected %s app without a GUI in the test", async (mode) => {
    rs.stubEnv(
      "ROME_COMPUTER_USE_APP",
      mode === "option" ? "/ignored/app" : mode === "environment" ? "/override/app" : undefined,
    );
    const source = {
      path: mode === "bundle" ? "/bundled/app" : "/override/app",
      requirement: "stable",
      implementationSha256: "a".repeat(64),
      executableSha256: "b".repeat(64),
      architecture: "arm64" as const,
    };
    const installed = { ...source, path: "/stable/app" };
    const hello = {
      protocolVersion: 1,
      bundleId: "com.rome.computer-use",
      permissions: { accessibility: true, screenCapture: true },
      capabilities: { actions: ["setValue"] },
      architecture: source.architecture,
      implementationSha256: source.implementationSha256,
    };
    let absent = true;
    const f = await server((_request, send, fail) => {
      if (absent) {
        absent = false;
        fail({
          code: "helper_unavailable",
          message: "Synthetic absent service",
          details: { socketCode: "ENOENT", effectStatus: "not_dispatched" },
        });
      } else send(hello);
    });
    assets.inspect.mockResolvedValue(source);
    assets.prepare.mockResolvedValue(installed);
    assets.launch.mockImplementation((...args: unknown[]) => {
      (args.at(-1) as (error: null, stdout: string, stderr: string) => void)(null, "", "");
    });
    const bridge = createComputerUseNativeBridge({
      bundledAppPath: "/bundled/app",
      ...(mode === "option" ? { appPath: "/override/app" } : {}),
      stateDir: f.stateDir,
    });
    expect(await bridge.call("hello", {})).toEqual(hello);
    expect(assets.inspect).toHaveBeenCalledWith(source.path);
    if (mode === "bundle") expect(assets.prepare).toHaveBeenCalledWith(source, f.stateDir);
    else expect(assets.prepare).not.toHaveBeenCalled();
    expect(assets.launch).toHaveBeenCalledTimes(1);
    const [command, args] = assets.launch.mock.calls[0] as [string, string[]];
    expect(command).toBe("/usr/bin/open");
    expect(args).toEqual([
      "-g",
      "-a",
      mode === "bundle" ? installed.path : source.path,
      "--args",
      "--state-dir",
      f.stateDir,
    ]);
  });

  it("matches the signed implementation across independent signatures and rejects an unknown service", async () => {
    const source = {
      path: "/bundled/app",
      requirement: "stable",
      implementationSha256: "a".repeat(64),
      executableSha256: "b".repeat(64),
      architecture: "arm64" as const,
    };
    const baseHello = {
      protocolVersion: 1,
      bundleId: "com.rome.computer-use",
      permissions: { accessibility: true, screenCapture: true },
      capabilities: { actions: [] },
      architecture: "arm64",
      implementationSha256: source.implementationSha256,
      executableSha256: "c".repeat(64),
    };
    let reply: Record<string, unknown> = baseHello;
    const f = await server((_request, send) => send(reply));
    assets.inspect.mockResolvedValue(source);
    const bridge = createComputerUseNativeBridge({
      stateDir: f.stateDir,
      bundledAppPath: source.path,
    });
    expect(await bridge.call("hello", {})).toEqual(baseHello);
    for (const mismatch of [
      { ...baseHello, implementationSha256: "d".repeat(64) },
      { ...baseHello, implementationSha256: undefined },
      { ...baseHello, architecture: "x64" },
    ]) {
      reply = mismatch;
      await expect(bridge.call("hello", {})).rejects.toMatchObject({
        code: "helper_update_required",
      });
    }
  });

  it.each([
    true,
    false,
  ])("rechecks a healthy contender after installation is busy (matching=%s)", async (matching) => {
    const source = {
      path: "/bundled/app",
      requirement: "stable",
      implementationSha256: "a".repeat(64),
      executableSha256: "b".repeat(64),
      architecture: "arm64" as const,
    };
    const hello = {
      protocolVersion: 1,
      bundleId: "com.rome.computer-use",
      permissions: { accessibility: true, screenCapture: true },
      capabilities: { actions: [] },
      architecture: "arm64",
      implementationSha256: matching ? source.implementationSha256 : "c".repeat(64),
    };
    let first = true;
    const f = await server((_request, send, fail) => {
      if (first) {
        first = false;
        fail({
          code: "helper_unavailable",
          message: "Absent",
          details: {
            socketCode: "ENOENT",
            effectStatus: "not_dispatched",
          },
        });
      } else send(hello);
    });
    assets.inspect.mockResolvedValue(source);
    assets.prepare.mockRejectedValue(new ComputerUseError("helper_install_busy", "Lock held"));
    const bridge = createComputerUseNativeBridge({
      stateDir: f.stateDir,
      bundledAppPath: source.path,
    });
    if (matching) expect(await bridge.call("hello", {})).toEqual(hello);
    else
      await expect(bridge.call("hello", {})).rejects.toMatchObject({
        code: "helper_update_required",
      });
    expect(assets.launch).not.toHaveBeenCalled();
    expect(assets.prepare).toHaveBeenCalledTimes(1);
  });

  it("ends an unavailable contender retry at the startup deadline", async () => {
    const source = {
      path: "/bundled/app",
      requirement: "stable",
      implementationSha256: "a".repeat(64),
      executableSha256: "b".repeat(64),
      architecture: "arm64" as const,
    };
    const f = await server((_request, _send, fail) => {
      fail({
        code: "helper_unavailable",
        message: "Absent",
        details: {
          socketCode: "ENOENT",
          effectStatus: "not_dispatched",
        },
      });
    });
    assets.inspect.mockResolvedValue(source);
    assets.prepare.mockRejectedValue(new ComputerUseError("helper_install_busy", "Lock held"));
    const bridge = createComputerUseNativeBridge({
      stateDir: f.stateDir,
      bundledAppPath: source.path,
      startupTimeoutMs: 1,
    });
    await expect(bridge.call("hello", {})).rejects.toMatchObject({
      code: "helper_unavailable",
      details: { effectStatus: "not_dispatched" },
    });
  });

  it.each([
    "helper_timeout",
    "helper_connection_lost",
    "helper_unavailable",
  ])("never retries an action with an unknown %s reply", async (code) => {
    const source = {
      path: "/bundled/app",
      requirement: "stable",
      implementationSha256: "a".repeat(64),
      executableSha256: "b".repeat(64),
      architecture: "arm64" as const,
    };
    const f = await server((request, send, fail) => {
      if (request.method === "hello")
        send({
          protocolVersion: 1,
          bundleId: "com.rome.computer-use",
          permissions: { accessibility: true, screenCapture: true },
          capabilities: { actions: [] },
          architecture: "arm64",
          implementationSha256: source.implementationSha256,
        });
      else
        fail({
          code,
          message: "Input may already have happened",
          details: {
            effectStatus: "unknown",
            socketCode: "ENOENT",
          },
        });
    });
    assets.inspect.mockResolvedValue(source);
    const bridge = createComputerUseNativeBridge({
      stateDir: f.stateDir,
      bundledAppPath: source.path,
    });
    await expect(bridge.call("act", { sessionId: "old-session" })).rejects.toMatchObject({
      code,
      details: { effectStatus: "unknown" },
    });
    expect(f.calls.filter((request) => request.method === "act")).toHaveLength(1);
    expect(assets.prepare).not.toHaveBeenCalled();
    expect(assets.launch).not.toHaveBeenCalled();
  });

  it("authenticates fragmented frames and sends cancel on a separate socket", async () => {
    let complete!: (result: unknown) => void;
    let start!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const f = await server((request, send) => {
      if (request.method === "act") {
        complete = send;
        start();
      } else send({ status: "cancelled" });
    });
    const acting = f.bridge.call("act", { sessionId: "bound-session" });
    await started;
    expect(await f.bridge.call("cancel", { sessionId: "bound-session" })).toEqual({
      status: "cancelled",
    });
    complete({ status: "cancelled", eventsPosted: 0 });
    expect(await acting).toMatchObject({ eventsPosted: 0 });
    const token = (await readFile(join(f.stateDir, "token"), "utf8")).trim();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(f.calls.map((call) => call.token)).toEqual([token, token]);
  });

  it("classifies a lost action reply as unknown and does not replay it", async () => {
    const f = await server(() => {});
    await expect(f.bridge.call("act", { sessionId: "bound-session" })).rejects.toMatchObject({
      code: "helper_timeout",
      details: { effectStatus: "unknown" },
    });
    expect(f.calls).toHaveLength(1);
  });

  it("refuses an unsafe state directory without connecting", async () => {
    const f = await server((_request, send) => send({}));
    await chmod(f.stateDir, 0o755);
    await expect(f.bridge.call("hello", {})).rejects.toMatchObject({
      code: "unsafe_state_directory",
    });
    expect(f.calls).toHaveLength(0);
  });
});
