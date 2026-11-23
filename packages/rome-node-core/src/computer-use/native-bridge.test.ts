import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { ComputerUseError } from "./protocol.js";
import {
  computerUseAppPath,
  createComputerUseNativeBridge,
  createNativeRpcTransport,
} from "./native-bridge.js";

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
  const canonicalStateDir = await realpath(stateDir);
  const sockets = new Set<Socket>();
  const calls: Array<Record<string, unknown>> = [];
  const connections: Array<string[]> = [];
  const service = createServer((socket) => {
    sockets.add(socket);
    const methods: string[] = [];
    connections.push(methods);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readUInt32LE();
        if (buffer.length < 4 + size) return;
        const payload = buffer.subarray(4, 4 + size);
        buffer = buffer.subarray(4 + size);
        const request = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
        calls.push(request);
        if (typeof request.method === "string") methods.push(request.method);
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
      }
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
    canonicalStateDir,
    calls,
    connections,
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
    if (mode === "bundle") expect(assets.prepare).toHaveBeenCalledWith(source, f.canonicalStateDir);
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
      f.canonicalStateDir,
    ]);
  });

  it("canonicalizes a symlinked state-directory ancestor before installing and launching", async () => {
    const source = {
      path: "/bundled/app",
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
      capabilities: { actions: [] },
      architecture: "arm64",
      implementationSha256: source.implementationSha256,
    };
    const realParent = await mkdtemp("/tmp/rome-cua-real-");
    const aliasParent = await mkdtemp("/tmp/rome-cua-alias-");
    const aliasLink = join(aliasParent, "link");
    await symlink(realParent, aliasLink);
    const aliasedStateDir = join(aliasLink, "state");
    const realStateDir = join(realParent, "state");
    await mkdir(realStateDir, { mode: 0o700 });
    const canonicalStateDir = await realpath(realStateDir);
    const sockets = new Set<Socket>();
    let absent = true;
    const service = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length < 4 || buffer.length < 4 + buffer.readUInt32LE()) return;
        const req = JSON.parse(buffer.subarray(4).toString("utf8")) as Record<string, unknown>;
        const payload = absent
          ? {
              id: req.id,
              ok: false,
              error: {
                code: "helper_unavailable",
                message: "Absent",
                details: { socketCode: "ENOENT", effectStatus: "not_dispatched" },
              },
            }
          : { id: req.id, ok: true, result: hello };
        absent = false;
        const body = Buffer.from(JSON.stringify(payload));
        const header = Buffer.alloc(4);
        header.writeUInt32LE(body.length);
        socket.write(Buffer.concat([header, body]));
      });
    });
    await new Promise<void>((resolve, reject) => {
      service.once("error", reject);
      service.listen(join(canonicalStateDir, "helper.sock"), resolve);
    });
    cleanup.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => service.close(() => resolve()));
      await rm(aliasParent, { recursive: true, force: true });
      await rm(realParent, { recursive: true, force: true });
    });
    assets.inspect.mockResolvedValue(source);
    assets.prepare.mockResolvedValue(installed);
    assets.launch.mockImplementation((...args: unknown[]) => {
      (args.at(-1) as (error: null, stdout: string, stderr: string) => void)(null, "", "");
    });
    const bridge = createComputerUseNativeBridge({
      bundledAppPath: source.path,
      stateDir: aliasedStateDir,
    });
    expect(aliasedStateDir).not.toBe(canonicalStateDir);
    expect(await bridge.call("hello", {})).toEqual(hello);
    expect(assets.prepare).toHaveBeenCalledWith(source, canonicalStateDir);
    expect(assets.launch).toHaveBeenCalledWith(
      "/usr/bin/open",
      ["-g", "-a", installed.path, "--args", "--state-dir", canonicalStateDir],
      expect.any(Object),
      expect.any(Function),
    );
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

  it("verifies helper identity on the same socket before non-hello calls and blocks replaced services", async () => {
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
    };
    let currentHello = baseHello;
    const f = await server((request, send) => {
      if (request.method === "hello") send(currentHello);
      else send({ ok: true });
    });
    assets.inspect.mockResolvedValue(source);
    const bridge = createComputerUseNativeBridge({
      stateDir: f.stateDir,
      bundledAppPath: source.path,
    });
    expect(await bridge.call("act", { sessionId: "s1" })).toEqual({ ok: true });
    expect(f.connections).toEqual([["hello"], ["hello", "act"]]);

    // Simulate another Node/Desktop version replacing the helper behind the same socket path.
    currentHello = { ...baseHello, implementationSha256: "f".repeat(64) };
    await expect(bridge.call("act", { sessionId: "s1" })).rejects.toMatchObject({
      code: "helper_update_required",
      details: { effectStatus: "not_dispatched" },
    });
    // The incompatible replacement must never receive the action.
    expect(f.connections).toEqual([["hello"], ["hello", "act"], ["hello"]]);
  });

  it("verifies identity and capability on the same socket for readStopStatus", async () => {
    const source = {
      path: "/bundled/app",
      requirement: "stable",
      implementationSha256: "a".repeat(64),
      executableSha256: "b".repeat(64),
      architecture: "arm64" as const,
    };
    let sessionRecovery = false;
    const f = await server((request, send) => {
      if (request.method === "hello") {
        send({
          protocolVersion: 1,
          bundleId: "com.rome.computer-use",
          permissions: { accessibility: true, screenCapture: true },
          capabilities: { actions: [], background: { sessionRecovery } },
          architecture: "arm64",
          implementationSha256: source.implementationSha256,
        });
      } else send({ status: "stopped" });
    });
    assets.inspect.mockResolvedValue(source);
    const bridge = createComputerUseNativeBridge({
      stateDir: f.stateDir,
      bundledAppPath: source.path,
    });
    expect(await bridge.readStopStatus?.("s1")).toBeUndefined();
    sessionRecovery = true;
    expect(await bridge.readStopStatus?.("s1")).toEqual({ status: "stopped" });
    expect(f.connections).toEqual([["hello"], ["hello", "stop_status"]]);
  });

  it("keeps readiness cached across ordinary not_dispatched helper rejections", async () => {
    const source = {
      path: "/bundled/app",
      requirement: "stable",
      implementationSha256: "a".repeat(64),
      executableSha256: "b".repeat(64),
      architecture: "arm64" as const,
    };
    const f = await server((request, send, fail) => {
      if (request.method === "hello") {
        send({
          protocolVersion: 1,
          bundleId: "com.rome.computer-use",
          permissions: { accessibility: true, screenCapture: true },
          capabilities: { actions: [] },
          architecture: "arm64",
          implementationSha256: source.implementationSha256,
        });
      } else if (request.method === "act") {
        fail({
          code: "stale_element",
          message: "Target moved",
          details: { effectStatus: "not_dispatched" },
        });
      } else send({ status: "cancelled" });
    });
    assets.inspect.mockResolvedValue(source);
    const bridge = createComputerUseNativeBridge({
      stateDir: f.stateDir,
      bundledAppPath: source.path,
    });
    await expect(bridge.call("act", { sessionId: "s1" })).rejects.toMatchObject({
      code: "stale_element",
      details: { effectStatus: "not_dispatched" },
    });
    expect(await bridge.call("cancel", { sessionId: "s1" })).toEqual({ status: "cancelled" });
    expect(assets.inspect).toHaveBeenCalledTimes(1);
    expect(f.connections).toEqual([["hello"], ["hello", "act"], ["hello", "cancel"]]);
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

  it("refuses an unsafe state directory without connecting and recovers once permissions are fixed", async () => {
    const f = await server((_request, send) => send({ ok: true }));
    await chmod(f.stateDir, 0o755);
    await expect(f.bridge.call("hello", {})).rejects.toMatchObject({
      code: "unsafe_state_directory",
    });
    expect(f.calls).toHaveLength(0);
    await chmod(f.stateDir, 0o700);
    expect(await f.bridge.call("hello", {})).toEqual({ ok: true });
    expect(f.calls).toHaveLength(1);
  });

  it("hands off an idle older Rome helper via shutdown and stages the new version", async () => {
    const source = {
      path: "/bundled/app",
      version: "0.1.9",
      requirement: "stable",
      implementationSha256: "a".repeat(64),
      executableSha256: "b".repeat(64),
      architecture: "arm64" as const,
    };
    const installed = { ...source, path: "/stable/app" };
    const oldHello = {
      protocolVersion: 1,
      version: "0.1.8",
      bundleId: "com.rome.computer-use",
      permissions: { accessibility: true, screenCapture: true },
      capabilities: { actions: [] },
      architecture: "arm64",
      implementationSha256: "9".repeat(64),
      activeSessions: 0,
      execution: { busy: false },
    };
    const newHello = {
      ...oldHello,
      version: source.version,
      implementationSha256: source.implementationSha256,
    };
    let phase: "old" | "down" | "new" = "old";
    const f = await server((request, send, fail) => {
      if (phase === "old") {
        if (request.method === "hello") send(oldHello);
        else if (request.method === "shutdown") {
          phase = "down";
          send({ stopping: true });
        }
      } else if (phase === "down") {
        fail({
          code: "helper_unavailable",
          message: "Old helper exited",
          details: { socketCode: "ENOENT", effectStatus: "not_dispatched" },
        });
      } else {
        send(newHello);
      }
    });
    assets.inspect.mockResolvedValue(source);
    assets.prepare
      .mockRejectedValueOnce(new ComputerUseError("helper_install_busy", "Lock still closing"))
      .mockResolvedValueOnce(installed);
    assets.launch.mockImplementation((...args: unknown[]) => {
      phase = "new";
      (args.at(-1) as (error: null, stdout: string, stderr: string) => void)(null, "", "");
    });
    const bridge = createComputerUseNativeBridge({
      bundledAppPath: source.path,
      stateDir: f.stateDir,
      startupTimeoutMs: 2_000,
    });
    expect(await bridge.call("hello", {})).toEqual(newHello);
    expect(f.connections).toEqual([
      ["hello"],
      ["hello", "shutdown"],
      ["hello"],
      ["hello"],
      ["hello"],
    ]);
    expect(f.calls.find((call) => call.method === "shutdown")?.params).toEqual({ idleOnly: true });
    expect(assets.prepare).toHaveBeenCalledTimes(2);
    expect(assets.launch).toHaveBeenCalledTimes(1);
  });

  it("refuses to downgrade or replace an idle newer, same-version, or unversioned Rome helper", async () => {
    for (const scenario of [
      { bundledVersion: "0.1.9", runningVersion: "0.1.10" },
      { bundledVersion: "0.1.9", runningVersion: "0.1.9" },
      { bundledVersion: "0.1.9", runningVersion: undefined },
      { bundledVersion: undefined, runningVersion: "0.1.8" },
    ]) {
      const source = {
        path: "/bundled/app",
        ...(scenario.bundledVersion ? { version: scenario.bundledVersion } : {}),
        requirement: "stable",
        implementationSha256: "a".repeat(64),
        executableSha256: "b".repeat(64),
        architecture: "arm64" as const,
      };
      const runningHello = {
        protocolVersion: 1,
        ...(scenario.runningVersion ? { version: scenario.runningVersion } : {}),
        bundleId: "com.rome.computer-use",
        permissions: { accessibility: true, screenCapture: true },
        capabilities: { actions: [] },
        architecture: "arm64",
        implementationSha256: "9".repeat(64),
        activeSessions: 0,
        execution: { busy: false },
      };
      const f = await server((request, send) => {
        if (request.method === "hello") send(runningHello);
        else send({ stopping: true });
      });
      assets.inspect.mockResolvedValue(source);
      const bridge = createComputerUseNativeBridge({
        bundledAppPath: source.path,
        stateDir: f.stateDir,
        startupTimeoutMs: 500,
      });
      await expect(bridge.call("hello", {})).rejects.toMatchObject({
        code: "helper_update_required",
        details: { effectStatus: "not_dispatched" },
      });
      expect(f.calls.some((call) => call.method === "shutdown")).toBe(false);
      expect(assets.prepare).not.toHaveBeenCalled();
      expect(assets.launch).not.toHaveBeenCalled();
    }
  });

  it("refuses shutdown and fails closed when a mismatched helper is busy or gains a session", async () => {
    const source = {
      path: "/bundled/app",
      version: "0.1.9",
      requirement: "stable",
      implementationSha256: "a".repeat(64),
      executableSha256: "b".repeat(64),
      architecture: "arm64" as const,
    };
    const oldHello = {
      protocolVersion: 1,
      version: "0.1.8",
      bundleId: "com.rome.computer-use",
      permissions: { accessibility: true, screenCapture: true },
      capabilities: { actions: [] },
      architecture: "arm64",
      implementationSha256: "9".repeat(64),
      activeSessions: 0,
      execution: { busy: false },
    };
    let helloCount = 0;
    let mode: "active_session" | "busy" | "raced" = "active_session";
    const f = await server((request, send) => {
      if (request.method === "hello") {
        helloCount++;
        if (mode === "active_session") send({ ...oldHello, activeSessions: 1 });
        else if (mode === "busy") send({ ...oldHello, execution: { busy: true } });
        else send(helloCount === 1 ? oldHello : { ...oldHello, activeSessions: 1 });
      } else {
        send({ stopping: true });
      }
    });
    assets.inspect.mockResolvedValue(source);
    for (const nextMode of ["active_session", "busy", "raced"] as const) {
      mode = nextMode;
      helloCount = 0;
      const bridge = createComputerUseNativeBridge({
        bundledAppPath: source.path,
        stateDir: f.stateDir,
        startupTimeoutMs: 500,
      });
      await expect(bridge.call("hello", {})).rejects.toMatchObject({
        code: "helper_update_required",
        details: { effectStatus: "not_dispatched" },
      });
    }
    expect(f.calls.some((call) => call.method === "shutdown")).toBe(false);
    expect(assets.prepare).not.toHaveBeenCalled();
    expect(assets.launch).not.toHaveBeenCalled();
  });

  it.each([
    "helper_busy",
    "input_busy",
  ])("fails closed when a concurrent bind lands after the verification hello (%s)", async (rejectionCode) => {
    const source = {
      path: "/bundled/app",
      version: "0.1.9",
      requirement: "stable",
      implementationSha256: "a".repeat(64),
      executableSha256: "b".repeat(64),
      architecture: "arm64" as const,
    };
    const oldHello = {
      protocolVersion: 1,
      version: "0.1.8",
      bundleId: "com.rome.computer-use",
      permissions: { accessibility: true, screenCapture: true },
      capabilities: { actions: [] },
      architecture: "arm64",
      implementationSha256: "9".repeat(64),
      activeSessions: 0,
      execution: { busy: false },
    };
    const f = await server((request, send, fail) => {
      if (request.method === "hello") {
        send(oldHello);
      } else if (request.method === "shutdown") {
        fail({
          code: rejectionCode,
          message: "Another host bound a session after verification hello.",
        });
      }
    });
    assets.inspect.mockResolvedValue(source);
    const bridge = createComputerUseNativeBridge({
      bundledAppPath: source.path,
      stateDir: f.stateDir,
      startupTimeoutMs: 500,
    });
    await expect(bridge.call("hello", {})).rejects.toMatchObject({
      code: "helper_update_required",
      details: { effectStatus: "not_dispatched" },
    });
    expect(f.connections).toEqual([["hello"], ["hello", "shutdown"]]);
    expect(f.calls.find((call) => call.method === "shutdown")?.params).toEqual({ idleOnly: true });
    expect(assets.prepare).not.toHaveBeenCalled();
    expect(assets.launch).not.toHaveBeenCalled();
  });

  it("resolves the helper path by precedence and discovers @rome-os/node-core-darwin-arm64 on Apple Silicon", () => {
    rs.stubEnv("ROME_COMPUTER_USE_APP", undefined);
    const defaultPath = computerUseAppPath({});
    expect(defaultPath.endsWith(join("native", "Rome Computer Use.app"))).toBe(true);
    if (process.platform === "darwin" && process.arch === "arm64") {
      expect(defaultPath).toContain("rome-node-core-darwin-arm64");
    }
    expect(computerUseAppPath({ bundledAppPath: "/bundled/Rome Computer Use.app" })).toBe(
      "/bundled/Rome Computer Use.app",
    );
    rs.stubEnv("ROME_COMPUTER_USE_APP", "/env/Rome Computer Use.app");
    expect(computerUseAppPath({ bundledAppPath: "/bundled/Rome Computer Use.app" })).toBe(
      "/env/Rome Computer Use.app",
    );
    expect(
      computerUseAppPath({
        appPath: "/explicit/Rome Computer Use.app",
        bundledAppPath: "/bundled/Rome Computer Use.app",
      }),
    ).toBe("/explicit/Rome Computer Use.app");
  });
});
