import { afterEach, beforeEach, expect, it, rs } from "@rstest/core";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AuditStore } from "../audit.js";
import { createExecutor, type HostAudit } from "../executor.js";
import { decodeMeta, encodeMeta, FRAME_TYPE, type Frame } from "../frame.js";
import type { OutboundEnvelope } from "../protocol.js";
import type { ComputerUseBridge } from "./bridge.js";
import * as bridge from "./bridge.js" with { rstest: "importActual" };
import { discoverHelper } from "./discovery.js";
import * as discovery from "./discovery.js" with { rstest: "importActual" };
import { ComputerUseHost, type EnsureComputerUseHelper } from "./host.js";
import { ComputerUseError, PNG_LIMIT, type Results } from "./protocol.js";

const mock = rs.hoisted(() => ({ launch: rs.fn(), discover: rs.fn() }));
rs.mock("./bridge.js", () => ({ ComputerUseBridge: { launch: mock.launch } }));
rs.mock("./discovery.js", () => ({ ...discovery, discoverHelper: mock.discover }));

const peer = randomUUID();
const other = randomUUID();
const actionId = randomUUID();
const nativeId = randomUUID();
const png = Buffer.from("private-screenshot-bytes");
const shellToken = `romedev_${"t".repeat(43)}`;
const text = "private-input-text";
const title = "private-window-title";
const tree = {
  ref: "ax-ref",
  title: "private-ax-text",
  role: "AXWindow",
  actions: [],
  children: [],
};
const window = {
  window: 1,
  title,
  appName: "App",
  bundleName: "App",
  bundleId: "app.example",
  bounds: [0, 0, 2, 2],
} as const;
const canceled = { stop: "cancel_requested", reason: "session_stopped" } as const;
const confirmed = { ...canceled, stop: "stop_confirmed" } as const;
const cleanups: (() => unknown)[] = [];

beforeEach(() => {
  mock.discover.mockReset();
  mock.discover.mockResolvedValue("/fake/Rome Computer Use.app");
  mock.launch.mockReset();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fakeHelper() {
  type Disconnect = Parameters<ComputerUseBridge["onDisconnect"]>[0];
  let disconnect: Disconnect | undefined;
  const helper = {
    instanceId: randomUUID(),
    helperPid: process.pid,
    closed: false,
    onCancelRequested: rs.fn<ComputerUseBridge["onCancelRequested"]>(),
    onDisconnect: (listener: Disconnect) => {
      disconnect = listener;
      return () => {
        disconnect = undefined;
      };
    },
    close: rs.fn((reason = new ComputerUseError("connection_closed")) => {
      if (helper.closed) return;
      helper.closed = true;
      disconnect?.(reason);
    }),
    initialAccess: { status: "authorized", revision: 1 } as Results["access_status"],
    accessStatus: rs.fn(
      (_afterRevision?: number): Promise<Results["access_status"]> => new Promise(() => {}),
    ),
    openPermissionGuide: rs.fn(
      async (): Promise<Results["open_permission_guide"]> => ({
        status: "authorized",
        revision: 1,
      }),
    ),
    windows: rs.fn(async () => ({ windows: [{ ...window, bounds: [...window.bounds] }] })),
    bind: rs.fn(async (id: number) => ({
      binding: nativeId,
      window: { ...window, window: id, bounds: [...window.bounds] },
    })),
    unbind: rs.fn(async (): Promise<Results["unbind"]> => ({ binding: nativeId, released: true })),
    observe: rs.fn(async (_id: string, options?: { screenshot?: boolean }) => ({
      binding: nativeId,
      tree,
      truncated: false,
      refTTLms: 15_000,
      ...(options?.screenshot
        ? {
            screenshot: {
              mimeType: "image/png" as const,
              bytes: png.length,
              width: 2,
              height: 2,
              png,
            },
          }
        : {}),
    })),
    act: rs.fn(async (): Promise<Results["act"]> => ({ binding: nativeId, dispatched: true })),
    cancel: rs.fn(async (): Promise<Results["cancel"]> => canceled),
    status: rs.fn(
      async (): Promise<Results["status"]> => ({ instance: helper.instanceId, ...confirmed }),
    ),
  };
  return helper;
}

const noAudit: HostAudit = {
  start: async () => 1,
  end() {},
  host() {},
  status: async () => ({ state: "ok" }),
  hint: "",
};
const error = (code: string) => ({ ok: false, error: { code } });

function executor(audit: HostAudit = noAudit, computerUseHelperPath?: string) {
  const replies = new Map<string, OutboundEnvelope>();
  const frames = new Map<string, Frame>();
  const exec = createExecutor(
    "Test host",
    audit,
    (reply) => {
      replies.set(reply.id, reply);
      return true;
    },
    [shellToken],
    (frame) => {
      frames.set(frame.id, frame);
      return true;
    },
    computerUseHelperPath,
  );
  cleanups.push(exec.disconnect);
  const json = async (action: string, args: unknown = {}, from = peer) => {
    const id = randomUUID();
    await exec.receive({ id, from, payload: { type: "request", action, args } });
    return replies.get(id)?.payload as
      | {
          result: { binding: string; status: string; requestId: string; revision: number };
          ok: boolean;
        }
      | undefined;
  };
  const binary = async (action: string, args: unknown, body = new Uint8Array()) => {
    const id = randomUUID();
    await exec.receiveFrame({
      type: FRAME_TYPE.request,
      id,
      peer,
      meta: encodeMeta({ type: "request", action, args }),
      body,
    });
    const frame = frames.get(id)!;
    return { response: decodeMeta(frame.meta), body: Buffer.from(frame.body) };
  };
  const authorize = async (from = peer) => {
    await json("computer.request_access", {}, from);
    await expect
      .poll(async () => (await json("computer.status", {}, from))?.result.status)
      .toBe("authorized");
  };
  const bind = async (from = peer, windowId = 1) => {
    await authorize(from);
    return (await json("computer.bind", { window: windowId }, from))!.result.binding;
  };
  return { exec, json, binary, bind, authorize };
}

async function runHost(
  host: ComputerUseHost,
  action: string,
  args: unknown = {},
  from: string = peer,
) {
  const operation = host.prepare(action, from, args)!;
  try {
    return (await operation.run()).response;
  } finally {
    operation.release();
  }
}

async function authorizeHost(host: ComputerUseHost, from: string = peer) {
  await runHost(host, "computer.request_access", {}, from);
  await expect
    .poll(() => runHost(host, "computer.status", {}, from), { interval: 1 })
    .toMatchObject({ result: { status: "authorized" } });
}

function input(binding: string) {
  return { binding, actionId, action: "type_text", text };
}

it("discovers paths without signature verification and stops at an invalid explicit choice", async () => {
  const root = await mkdtemp(join(tmpdir(), "rome-cu-discovery-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const app = join(root, "Rome Computer Use.app");
  const preferred = join(root, "preferred", "Rome Computer Use.app");
  await mkdir(app);
  await mkdir(preferred, { recursive: true });
  const env = {
    platform: "darwin" as const,
    applications: [join(root, "preferred"), root],
    envPath: app,
    bundledAppPath: preferred,
    stagedAppPath: null,
  };
  await expect(discovery.discoverHelper({ ...env, platform: "linux" })).rejects.toMatchObject({
    code: "computer_use_unsupported_platform",
  });
  await expect(discovery.discoverHelper({ ...env, envPath: "./helper" })).rejects.toMatchObject({
    code: "invalid_helper_bundle",
  });
  await expect(
    discovery.discoverHelper({ ...env, envPath: join(root, "missing") }),
  ).rejects.toMatchObject({
    code: "computer_use_helper_missing",
  });
  await expect(discovery.discoverHelper(env)).resolves.toBe(app);
  await expect(discovery.discoverHelper({ ...env, envPath: undefined })).resolves.toBe(preferred);
});

it("prefers the override, caller, platform package, staged helper, then Applications", async () => {
  const home = await mkdtemp(join(tmpdir(), "rome-cu-discovery-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const app = "Rome Computer Use.app";
  const stagedAppPath = discovery.stagedHelperPath(home);
  expect(stagedAppPath).toBe(join(home, ".rome-computer-use", app));
  const paths = ["env", "bundled", "platform", "Applications"].map((dir) => join(home, dir, app));
  const [envPath, bundledAppPath, platformPath, application] = paths;
  for (const path of [...paths, stagedAppPath]) await mkdir(path, { recursive: true });
  const stagedBinary = join(stagedAppPath, "Contents", "MacOS", "RomeComputerUse");
  await mkdir(join(stagedAppPath, "Contents", "MacOS"), { recursive: true });
  await writeFile(stagedBinary, "binary");
  await chmod(stagedBinary, 0o755);
  await writeFile(join(stagedAppPath, "Contents", "Info.plist"), "plist");
  const options = {
    platform: "darwin" as const,
    stagedAppPath,
    platformApp: () => platformPath,
    applications: [join(home, "Applications")],
  };
  await expect(discovery.discoverHelper({ ...options, envPath, bundledAppPath })).resolves.toBe(
    envPath,
  );
  await expect(discovery.discoverHelper({ ...options, bundledAppPath })).resolves.toBe(
    bundledAppPath,
  );
  await expect(discovery.discoverHelper(options)).resolves.toBe(platformPath);
  await rm(platformPath, { recursive: true });
  await expect(discovery.discoverHelper(options)).resolves.toBe(stagedAppPath);
  await expect(discovery.discoverHelper({ ...options, stagedAppPath: null })).resolves.toBe(
    application,
  );
  await rm(stagedBinary);
  await expect(discovery.discoverHelper(options)).resolves.toBe(application);
  await rm(stagedAppPath, { recursive: true });
  await expect(discovery.discoverHelper(options)).resolves.toBe(application);
  const pinned = { ...options, bundledAppPath: stagedAppPath, strictBundledAppPath: true };
  await expect(discovery.discoverHelper(pinned)).rejects.toMatchObject({
    code: "computer_use_helper_missing",
  });
  await symlink(application, stagedAppPath, "junction");
  await expect(discovery.discoverHelper(pinned)).rejects.toMatchObject({
    code: "computer_use_helper_missing",
  });
  await expect(discovery.discoverHelper(options)).resolves.toBe(application);
  await rm(stagedAppPath);
  await mkdir(stagedAppPath);
  await expect(discovery.discoverHelper(pinned)).rejects.toMatchObject({
    code: "computer_use_helper_missing",
  });
});

it("passes the host's bundled app to discovery", async () => {
  const bundledAppPath = "/resources/native/Rome Computer Use.app";
  await executor(noAudit, bundledAppPath).json("system.info");
  expect(mock.discover).toHaveBeenCalledWith({ bundledAppPath });
});

it.each(["probe", "launch"])("repairs a deleted helper once before a %s", async (operation) => {
  const root = await mkdtemp(join(tmpdir(), "rome-cu-repair-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bundledAppPath = discovery.stagedHelperPath(root);
  await mkdir(bundledAppPath, { recursive: true });
  const discover = rs.fn(async () => {
    if (!(await stat(bundledAppPath).catch(() => undefined))?.isDirectory())
      throw new ComputerUseError("computer_use_helper_missing");
    return bundledAppPath;
  });
  const ensureHelper = rs.fn(async () => {
    await mkdir(bundledAppPath, { recursive: true });
    return true;
  });
  const probePermissions = rs.fn(async () => true);
  mock.launch.mockResolvedValue(fakeHelper());
  const host = new ComputerUseHost({
    bundledAppPath,
    strictBundledAppPath: true,
    discover,
    ensureHelper,
    probePermissions,
  });
  cleanups.push(() => host.disconnect());
  expect((await host.info(peer)).capability.state).toBe("on");
  expect(ensureHelper).toHaveBeenCalledTimes(1);
  ensureHelper.mockImplementationOnce(async () => {
    // The checked helper disappears before discovery opens it.
    await rm(bundledAppPath, { recursive: true });
    return true;
  });
  if (operation === "probe") {
    const results = await Promise.all([host.info(peer), host.info(other)]);
    expect(results.map((info) => info.capability.state)).toEqual(["on", "on"]);
    expect(probePermissions).toHaveBeenCalledTimes(2);
  } else {
    const request = host.prepare("computer.request_access", peer, {})!;
    expect((await request.run()).response.ok).toBe(true);
    request.release();
    expect(mock.launch).toHaveBeenCalledWith(expect.objectContaining({ appPath: bundledAppPath }));
  }
  expect(ensureHelper).toHaveBeenCalledTimes(3);
  expect(ensureHelper).toHaveBeenLastCalledWith({ force: true });
  expect(discover).toHaveBeenCalledTimes(3);
  expect(discover).toHaveBeenLastCalledWith({ bundledAppPath, strictBundledAppPath: true });
});

it("forces a repair on the same request when discovery rejects a damaged signed resource", async () => {
  const root = await mkdtemp(join(tmpdir(), "rome-cu-signature-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const app = discovery.stagedHelperPath(root);
  const contents = join(app, "Contents");
  const resource = join(contents, "_CodeSignature", "CodeResources");
  await mkdir(join(contents, "_CodeSignature"), { recursive: true });
  await mkdir(join(contents, "MacOS"));
  await writeFile(join(contents, "MacOS", "RomeComputerUse"), "binary");
  await writeFile(join(contents, "Info.plist"), "plist");
  await writeFile(resource, "signed");
  const ensureHelper = rs.fn<EnsureComputerUseHelper>(async (options) => {
    if (options?.force) await writeFile(resource, "signed");
    return true;
  });
  const probePermissions = rs.fn(async () => true);
  const host = new ComputerUseHost({
    ensureHelper,
    discover: async () => {
      if ((await readFile(resource, "utf8")) !== "signed")
        throw new ComputerUseError("computer_use_helper_missing");
      return app;
    },
    probePermissions,
  });
  expect((await host.info(peer)).capability.state).toBe("on");
  ensureHelper.mockClear();
  await writeFile(resource, "damaged");
  expect((await host.info(peer)).capability.state).toBe("on");
  expect(ensureHelper.mock.calls).toEqual([[], [{ force: true }]]);
  expect(probePermissions).toHaveBeenCalledTimes(2);
  expect(await readFile(resource, "utf8")).toBe("signed");
});

it.each([
  "computer_use_helper_missing",
  "invalid_helper_bundle",
] as const)("bounds repair attempts after %s", async (code) => {
  const discover = rs.fn().mockRejectedValue(new ComputerUseError(code));
  const ensureHelper = rs.fn(async () => true);
  const host = new ComputerUseHost({ discover, ensureHelper });
  expect((await host.info(peer)).capability.state).toBe("off");
  expect(ensureHelper).toHaveBeenCalledTimes(code === "computer_use_helper_missing" ? 2 : 1);
  expect(discover).toHaveBeenCalledTimes(code === "computer_use_helper_missing" ? 2 : 1);
});

it("refuses an unready helper even on a live bridge and probes again after recovery", async () => {
  const ensureHelper = rs.fn(async () => true);
  const probePermissions = rs.fn(async () => true);
  const bridge = fakeHelper();
  mock.launch.mockResolvedValue(bridge);
  const host = new ComputerUseHost({ ensureHelper, probePermissions });
  cleanups.push(() => host.disconnect());
  const call = async (action: string, targetPeer = peer) => {
    const request = host.prepare(action, targetPeer, {})!;
    try {
      return (await request.run()).response;
    } finally {
      request.release();
    }
  };
  const windows = () => call("computer.windows");
  expect((await call("computer.request_access")).ok).toBe(true);
  for (let i = 0; i < 20; i++) {
    const status = await call("computer.status");
    if (status.ok && (status.result as { status?: string }).status === "authorized") break;
    await delay(1);
  }
  expect((await windows()).ok).toBe(true);
  expect((await host.info(peer)).capability.state).toBe("on");
  expect(probePermissions).toHaveBeenCalledTimes(1);
  ensureHelper.mockResolvedValue(false);
  ensureHelper.mockClear();
  mock.discover.mockClear();
  const [info, response] = await Promise.all([host.info(peer), windows()]);
  expect(info.capability.state).toBe("off");
  expect(response).toMatchObject(error("computer_use_helper_missing"));
  expect(ensureHelper).toHaveBeenCalledTimes(1);
  expect(mock.discover).not.toHaveBeenCalled();
  expect(bridge.windows).toHaveBeenCalledTimes(1);
  expect(await call("computer.request_access", other)).toMatchObject(
    error("computer_use_helper_missing"),
  );
  expect(mock.launch).toHaveBeenCalledTimes(1);
  ensureHelper.mockResolvedValue(true);
  expect((await host.info(peer)).capability.state).toBe("on");
  expect(probePermissions).toHaveBeenCalledTimes(2);
  expect((await windows()).ok).toBe(true);
  expect(bridge.windows).toHaveBeenCalledTimes(2);
});

it.each([
  "computer_use_unsupported_platform",
  "computer_use_helper_missing",
  "invalid_helper_bundle",
] as const)("advertises off for %s and requires consent without launching", async (code) => {
  mock.discover.mockRejectedValue(new ComputerUseError(code));
  const f = executor();
  const info = await f.json("system.info");
  expect(info).toMatchObject({
    result: {
      actions: ["system.info", "exec", "fs.list"],
      capabilities: [
        {
          id: "computer_use",
          prefix: "computer",
          state: "off",
          personal: true,
          actions: expect.arrayContaining(["computer.observe"]),
        },
      ],
    },
  });
  expect(info?.result).not.toHaveProperty("computerUse");
  expect(info?.result).not.toHaveProperty("computerUseStatus");
  expect(info?.result).not.toHaveProperty("usage");
  mock.discover.mockClear();
  expect(await f.json("computer.windows")).toMatchObject(error("consent_required"));
  expect((await f.binary("computer.bind", { window: 1 })).response).toMatchObject(
    error("consent_required"),
  );
  expect(mock.discover).not.toHaveBeenCalled();
  expect(await f.json("computer.request_access")).toMatchObject(error(code));
  expect(await f.json("computer.status")).toMatchObject({ result: { status: "idle" } });
  expect(await f.json("computer.cancel")).toMatchObject({ result: confirmed });
  expect(await f.json("computer.windows")).toMatchObject(error("consent_required"));
  expect(mock.launch).not.toHaveBeenCalled();
});

it("refuses helper launch while the host cannot record the request", async () => {
  const f = executor({ ...noAudit, start: async () => null });
  expect(await f.json("computer.status")).toMatchObject({ result: { status: "idle" } });
  expect(await f.json("computer.bind", { window: 1 })).toMatchObject(error("audit_unavailable"));
  expect(await f.json("computer.request_access")).toMatchObject(error("audit_unavailable"));
  expect(mock.launch).not.toHaveBeenCalled();
  expect(await f.json("computer.cancel")).toMatchObject({ result: confirmed });
  expect(await f.json("computer.bind", { window: 1 })).toMatchObject(error("audit_unavailable"));
});

it("shares and caches permission probes by helper path until the TTL expires", async () => {
  let now = 0;
  const probePermissions = rs.fn(async () => true);
  const host = new ComputerUseHost({ probePermissions, now: () => now });
  const info = () => host.info(peer).then(({ capability }) => capability.state);
  expect(await Promise.all([info(), info()])).toEqual(["on", "on"]);
  now = 29_999;
  expect(await info()).toBe("on");
  expect(probePermissions).toHaveBeenCalledTimes(1);
  mock.discover.mockResolvedValueOnce("/other/Rome Computer Use.app");
  probePermissions.mockResolvedValueOnce(false);
  expect(await info()).toBe("needs_permission");
  now = 30_000;
  probePermissions.mockResolvedValueOnce(false);
  expect(await info()).toBe("needs_permission");
  expect(await info()).toBe("needs_permission");
  expect(probePermissions).toHaveBeenCalledTimes(3);
  expect(mock.launch).not.toHaveBeenCalled();
});

it("refreshes permissions before a session and across helper restarts", async () => {
  const helper = fakeHelper();
  mock.launch.mockResolvedValue(helper);
  const probePermissions = rs.fn(async () => true);
  const host = new ComputerUseHost({ probePermissions });
  cleanups.push(() => host.disconnect());

  const info = () => host.info(peer).then(({ capability }) => capability.state);
  expect(await Promise.all([info(), info()])).toEqual(["on", "on"]);
  expect(probePermissions).toHaveBeenCalledTimes(1);
  expect(mock.launch).not.toHaveBeenCalled();

  await authorizeHost(host);
  const list = host.prepare("computer.windows", peer, {})!;
  expect((await list.run()).response).toMatchObject({ ok: true });
  list.release();
  probePermissions.mockResolvedValueOnce(false);
  expect(await info()).toBe("needs_permission");
  helper.close();
  expect(await info()).toBe("on");
  expect(mock.launch).toHaveBeenCalledTimes(1);

  const cancel = host.prepare("computer.cancel", peer, {})!;
  await cancel.run();
  cancel.release();
  expect(await info()).toBe("off");
  expect(probePermissions).toHaveBeenCalledTimes(3);
  mock.discover.mockRejectedValueOnce(new ComputerUseError("computer_use_helper_missing"));
  expect((await host.info(other)).capability.state).toBe("off");
  expect(probePermissions).toHaveBeenCalledTimes(3);
});

it("does not reuse a probe that was in flight when the helper started", async () => {
  let finishProbe!: (permitted: boolean) => void;
  let markStarted!: () => void;
  const pending = new Promise<boolean>((resolve) => {
    finishProbe = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const probePermissions = rs
    .fn(async () => true)
    .mockImplementationOnce(() => {
      markStarted();
      return pending;
    });
  const host = new ComputerUseHost({ probePermissions });
  cleanups.push(() => host.disconnect());
  mock.launch.mockResolvedValue(fakeHelper());

  const info = host.info(peer);
  await started;
  await authorizeHost(host);
  const list = host.prepare("computer.windows", peer, {})!;
  expect((await list.run()).response).toMatchObject({ ok: true });
  list.release();
  finishProbe(false);
  await info;
  expect((await host.info(peer)).capability.state).toBe("on");
  expect(probePermissions).toHaveBeenCalledTimes(2);
});

it.each([
  "accessibility_permission_required",
  "screen_recording_permission_required",
] as const)("invalidates permissions when the helper reports %s", async (code) => {
  const helper = fakeHelper();
  mock.launch.mockResolvedValue(helper);
  const probePermissions = rs.fn(async () => true);
  const host = new ComputerUseHost({ probePermissions });
  cleanups.push(() => host.disconnect());
  await authorizeHost(host);
  const list = async () => {
    const op = host.prepare("computer.windows", peer, {})!;
    const result = await op.run();
    op.release();
    return result.response;
  };
  expect(await list()).toMatchObject({ ok: true });
  expect((await host.info(peer)).capability.state).toBe("on");
  helper.windows.mockRejectedValueOnce(new ComputerUseError(code));
  expect(await list()).toMatchObject(error(code));
  probePermissions.mockResolvedValueOnce(false);
  expect((await host.info(peer)).capability.state).toBe("needs_permission");
  expect(probePermissions).toHaveBeenCalledTimes(2);
});

it("keeps a peer off after a confirmed local emergency stop", async () => {
  const helper = fakeHelper();
  mock.launch.mockResolvedValue(helper);
  const f = executor();
  const binding = await f.bind();
  helper.close(new ComputerUseError("session_stopped"));
  expect(await f.json("system.info")).toMatchObject({
    result: { capabilities: [{ state: "off" }] },
  });
  expect(await f.json("computer.cancel")).toMatchObject({ result: confirmed });
  expect(await f.json("computer.act", input(binding))).toMatchObject(error("session_stopped"));
  expect(await f.json("computer.bind", { window: 1 })).toMatchObject(error("consent_required"));
  expect(mock.launch).toHaveBeenCalledTimes(1);
});

it("revokes status during an unfinished input and holds its window until native cleanup confirms", async () => {
  const helper = fakeHelper();
  mock.launch.mockResolvedValueOnce(helper).mockResolvedValueOnce(fakeHelper());
  let finish!: (result: Results["act"]) => void;
  helper.act.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const f = executor();
  const binding = await f.bind();
  const { requestId } = (await f.json("computer.status"))!.result;
  await f.authorize(other);
  const inputReply = f.json("computer.act", input(binding));
  await expect.poll(() => helper.act.mock.calls.length).toBe(1);
  helper.onCancelRequested.mock.calls[0][0]();
  expect(await f.json("computer.status", { requestId })).toMatchObject({
    result: { status: "cancelled" },
  });
  expect(await f.json("computer.cancel")).toMatchObject({ result: canceled });
  expect(await f.json("computer.bind", { window: 1 }, other)).toMatchObject(
    error("window_already_bound"),
  );
  finish({ binding: nativeId, dispatched: true });
  expect(await inputReply).toMatchObject(error("session_stopped"));
  helper.close(new ComputerUseError("session_stopped"));
  expect(await f.json("computer.cancel")).toMatchObject({ result: confirmed });
  expect(await f.json("computer.bind", { window: 1 }, other)).toMatchObject({ ok: true });
});

it("offers focus and Accessibility alternatives when keyboard dispatch is unavailable", async () => {
  const helper = fakeHelper();
  mock.launch.mockResolvedValue(helper);
  helper.act.mockRejectedValueOnce(new ComputerUseError("window_focus_unavailable"));
  const f = executor();
  const binding = await f.bind();
  expect(await f.json("computer.act", input(binding))).toMatchObject({
    ok: false,
    error: {
      code: "window_focus_unavailable",
      message: expect.stringMatching(/Focus that window.*set_value or press/),
    },
  });
});

it("routes JSON and PNG by peer and writes only metadata to the host audit", async () => {
  const root = await mkdtemp(join(tmpdir(), "rome-cu-audit-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const audit = await AuditStore.open({ path: join(root, "audit.db"), entry: "cli", hint: "" });
  cleanups.push(() => audit.close());
  const helper = fakeHelper();
  const otherHelper = fakeHelper();
  mock.launch.mockResolvedValueOnce(helper).mockResolvedValueOnce(otherHelper);
  const f = executor(audit);
  const info = await f.json("system.info");
  expect(info).toMatchObject({
    result: {
      actions: expect.arrayContaining([
        "computer.request_access",
        "computer.status",
        "computer.windows",
        "computer.bind",
        "computer.unbind",
        "computer.observe",
        "computer.act",
        "computer.cancel",
      ]),
      usage: {
        "computer.windows": expect.stringContaining("{application?}"),
        "computer.bind": expect.stringContaining("{window}"),
        "computer.unbind": expect.stringContaining("{binding}"),
        "computer.observe": expect.stringMatching(
          /\{binding, element\?, screenshot\?\}.*screenshot: true requires a binary request frame and returns raw PNG bytes in the response body/,
        ),
        "computer.cancel": expect.stringContaining("No arguments"),
      },
      capabilities: [
        {
          id: "computer_use",
          prefix: "computer",
          title: "Window Control",
          state: "needs_permission",
          personal: true,
          actions: expect.arrayContaining(["computer.windows", "computer.observe"]),
        },
      ],
    },
  });
  for (const fields of [
    "{binding, actionId, action, ...}. Use a new UUID actionId per intended action.",
    "{element, action: press|increment|decrement}",
    "{element, action: set_value, value}",
    "click {x, y, button?, clickCount?}",
    "move {x, y}",
    "drag {x, y, toX, toY, button?, steps?}",
    "scroll {x, y, deltaX, deltaY}",
    "key_press {key}",
    "type_text {text}",
    "except type_text accepts an optional modifiers array",
  ]) {
    expect(info).toMatchObject({
      result: { usage: { "computer.act": expect.stringContaining(fields) } },
    });
  }
  expect(mock.launch).not.toHaveBeenCalled();
  await f.authorize();
  expect(await f.json("computer.windows", { application: shellToken })).toMatchObject({
    result: { windows: [{ title }] },
  });
  const binding = await f.bind();
  expect(await f.json("system.info")).toMatchObject({
    result: { capabilities: [{ state: "on" }] },
  });
  expect(binding).not.toBe(nativeId);
  await f.authorize(other);
  expect(await f.json("computer.bind", { window: 1 }, other)).toMatchObject(
    error("window_already_bound"),
  );
  const otherBinding = await f.bind(other, 2);
  expect(otherBinding).not.toBe(binding);
  expect(await f.json("computer.act", input(binding), other)).toMatchObject(
    error("binding_not_found"),
  );
  expect(await f.json("computer.unbind", { binding }, other)).toMatchObject(
    error("binding_not_found"),
  );
  expect(await f.json("computer.cancel", {}, other)).toMatchObject({ result: canceled });
  expect(otherHelper.cancel).toHaveBeenCalledTimes(1);
  expect(helper.cancel).not.toHaveBeenCalled();
  expect(await f.json("computer.observe", { binding })).toMatchObject({
    result: { binding, tree },
  });
  expect(await f.json("computer.observe", { binding, screenshot: true })).toMatchObject(
    error("screenshot_requires_binary"),
  );
  const screenshot = await f.binary("computer.observe", { binding, screenshot: true });
  expect(screenshot.response).toMatchObject({
    result: { binding, screenshot: { mimeType: "image/png", bytes: png.length } },
  });
  expect(screenshot.body).toEqual(png);
  expect(
    (await f.binary("computer.act", input(binding), Buffer.from(text))).response,
  ).toMatchObject(error("invalid_request"));
  helper.act.mockImplementationOnce(async () => {
    expect(
      audit.list({ action: "computer.act" }).some((item) => item.record.actionId === actionId),
    ).toBe(true);
    return { binding: nativeId, dispatched: true };
  });
  expect(await f.json("computer.act", input(binding))).toMatchObject({
    result: { binding, actionId, dispatched: true },
  });
  await f.binary("computer.act", input(binding));
  expect(helper.act).toHaveBeenCalledTimes(1);
  expect(await f.json("computer.unbind", { binding })).toMatchObject({
    result: { binding, released: true },
  });
  expect(await f.json("computer.act", input(binding))).toMatchObject(error("binding_not_found"));
  const auditJson = JSON.stringify(audit.list({ limit: 100 }));
  for (const secret of [text, shellToken, title, tree.title, png.toString(), '"content"', '"args"'])
    expect(auditJson).not.toContain(secret);
  expect(auditJson).toContain(actionId);
  expect(auditJson).toContain("durationMs");
  expect(auditJson).toContain('"operation":"type_text"');
});

it("discards oversized screenshots and keeps uncertain input outcomes without replay", async () => {
  const helper = fakeHelper();
  mock.launch.mockResolvedValue(helper);
  const f = executor();
  const binding = await f.bind();
  const oversize = Buffer.alloc(PNG_LIMIT + 1);
  helper.observe.mockResolvedValueOnce({
    binding: nativeId,
    tree,
    truncated: false,
    refTTLms: 1,
    screenshot: {
      mimeType: "image/png",
      bytes: oversize.length,
      width: 2,
      height: 2,
      png: oversize,
    },
  });
  expect(await f.binary("computer.observe", { binding, screenshot: true })).toMatchObject({
    response: error("output_too_large"),
    body: Buffer.alloc(0),
  });
  helper.act.mockRejectedValueOnce(new ComputerUseError("action_outcome_unknown"));
  expect(await f.json("computer.act", input(binding))).toMatchObject(
    error("action_outcome_unknown"),
  );
  expect(await f.json("computer.act", input(binding))).toMatchObject(
    error("action_outcome_unknown"),
  );
  expect(helper.act).toHaveBeenCalledTimes(1);
});

it("seals input immediately on cancel during an audit wait and confirms only after helper cleanup", async () => {
  const helper = fakeHelper();
  mock.launch.mockResolvedValue(helper);
  let allowAudit!: (seq: number) => void;
  const audit = {
    ...noAudit,
    start: async (action: string) => {
      if (action === "computer.act")
        return new Promise<number>((resolve) => {
          allowAudit = resolve;
        });
      if (action === "computer.cancel") throw new Error("disk failed");
      return 1;
    },
  };
  const f = executor(audit);
  const binding = await f.bind();
  const inputStarting = f.json("computer.act", input(binding));
  const stop = f.json("computer.cancel");
  expect(helper.cancel).toHaveBeenCalledTimes(1);
  allowAudit(2);
  expect(await inputStarting).toMatchObject(error("session_stopped"));
  expect(helper.act).not.toHaveBeenCalled();
  expect(await stop).toMatchObject({ result: canceled });
  await expect.poll(() => helper.closed).toBe(true);
  expect(await f.json("computer.cancel")).toMatchObject({ result: confirmed });
});

it("confirms cancel without waiting for discovery", async () => {
  expect(await executor().json("computer.cancel")).toMatchObject({ result: confirmed });
  expect(mock.discover).not.toHaveBeenCalled();

  const f = executor();
  let missing!: () => void;
  mock.discover.mockImplementationOnce(
    () =>
      new Promise<string>((_, reject) => {
        missing = () => reject(new ComputerUseError("computer_use_helper_missing"));
      }),
  );
  const opening = f.json("computer.request_access");
  await expect.poll(() => missing).toBeTypeOf("function");
  expect(await f.json("computer.cancel")).toMatchObject({ result: confirmed });
  expect((await f.binary("computer.cancel", {})).response).toMatchObject({ result: confirmed });
  expect(mock.discover).toHaveBeenCalledTimes(1);
  missing();
  await opening;
  expect(await f.json("computer.bind", { window: 1 })).toMatchObject(error("consent_required"));
  expect(mock.launch).not.toHaveBeenCalled();
});

it("aborts consent before confirming that no input was admitted", async () => {
  let started!: (signal: AbortSignal) => void;
  const launching = new Promise<AbortSignal>((resolve) => {
    started = resolve;
  });
  mock.launch.mockImplementationOnce(({ signal }: { signal: AbortSignal }) => {
    started(signal);
    return new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(new ComputerUseError("request_aborted")), {
        once: true,
      }),
    );
  });
  const f = executor();
  const opening = f.json("computer.request_access");
  const signal = await launching;
  expect(await f.json("computer.cancel")).toMatchObject({ result: confirmed });
  expect(signal.aborted).toBe(true);
  const request = (await opening)!.result;
  expect(request.status).toBe("pending_consent");
  expect(await f.json("computer.status", { requestId: request.requestId })).toMatchObject({
    result: { status: "cancelled", revision: 2 },
  });
  expect(await f.json("system.info")).toMatchObject({
    result: {
      actions: [
        "system.info",
        "exec",
        "fs.list",
        "computer.request_access",
        "computer.status",
        "computer.cancel",
      ],
      capabilities: [{ state: "off" }],
      usage: { "computer.cancel": expect.stringContaining("No arguments") },
    },
  });
});

it("closes an unconfirmed helper and retains the terminal cancel result", async () => {
  const helper = fakeHelper();
  helper.status.mockResolvedValue({ instance: helper.instanceId, ...canceled });
  mock.launch.mockResolvedValue(helper);
  const f = executor();
  const binding = await f.bind();
  expect(await f.json("computer.cancel")).toMatchObject({ result: canceled });
  await expect.poll(() => helper.closed, { timeout: 3000 }).toBe(true);
  expect(await f.json("computer.cancel")).toMatchObject({ result: canceled });
  expect(await f.json("computer.act", input(binding))).toMatchObject(error("session_stopped"));
  expect(helper.cancel).toHaveBeenCalledTimes(1);
});

it("preserves an unconfirmed stop and its window across refused and audited access requests", async () => {
  const helper = fakeHelper();
  helper.status.mockResolvedValue({ instance: helper.instanceId, ...canceled });
  mock.launch.mockResolvedValueOnce(helper).mockResolvedValueOnce(fakeHelper());
  let refuse = false;
  const f = executor({
    ...noAudit,
    start: async (action) => (refuse && action === "computer.request_access" ? null : 1),
  });
  await f.bind();
  await f.authorize(other);
  expect(await f.json("computer.cancel")).toMatchObject({ result: canceled });
  await expect.poll(() => helper.closed, { timeout: 3000 }).toBe(true);
  expect(helper.status).toHaveBeenCalled();
  refuse = true;
  expect(await f.json("computer.request_access")).toMatchObject(error("audit_unavailable"));
  expect(await f.json("computer.cancel")).toMatchObject({ result: canceled });
  refuse = false;
  expect(await f.json("computer.request_access")).toMatchObject(error("session_stopped"));
  expect(await f.json("computer.bind", { window: 1 }, other)).toMatchObject(
    error("window_already_bound"),
  );
  expect(mock.launch).toHaveBeenCalledTimes(2);
});

it("coalesces audited replacements and honors the active peer limit", async () => {
  const host = new ComputerUseHost({ launch: async () => new Promise(() => {}) });
  cleanups.push(() => host.disconnect());
  await runHost(host, "computer.cancel");
  const auditing = host.prepare("computer.request_access", peer, {})!;
  await runHost(host, "computer.cancel");
  expect((await auditing.run()).response).toMatchObject(error("session_stopped"));
  auditing.release();
  const others = Array.from({ length: 8 }, () => randomUUID());
  for (const id of others) await runHost(host, "computer.request_access", {}, id);
  expect(await runHost(host, "computer.request_access")).toMatchObject(error("busy"));
  expect(await runHost(host, "computer.cancel")).toMatchObject({ result: confirmed });
  await runHost(host, "computer.cancel", {}, others[0]);
  const requests = Array.from(
    { length: 2 },
    () => host.prepare("computer.request_access", peer, {})!,
  );
  try {
    const [first, second] = await Promise.all(requests.map((r) => r.run()));
    expect(first.response).toMatchObject({
      result: { status: "pending_consent", requestId: expect.any(String) },
    });
    expect(second.response).toMatchObject({
      result: { requestId: (first.response as { result: { requestId: string } }).result.requestId },
    });
  } finally {
    for (const request of requests) request.release();
  }
});

it.each(["cancel", "disconnect"])("does not revive discovery after %s", async (stop) => {
  let found!: (path: string) => void;
  mock.discover.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        found = resolve;
      }),
  );
  const host = new ComputerUseHost();
  cleanups.push(() => host.disconnect());
  const requests = [
    runHost(host, "computer.request_access"),
    runHost(host, "computer.request_access"),
  ];
  expect(mock.discover).toHaveBeenCalledTimes(1);
  expect(await runHost(host, "computer.status")).toMatchObject({ result: { status: "idle" } });
  if (stop === "cancel") await runHost(host, "computer.cancel");
  else host.disconnect();
  found("/fake/helper.app");
  for (const response of await Promise.all(requests))
    expect(response).toMatchObject(
      error(stop === "cancel" ? "session_stopped" : "connection_closed"),
    );
  expect(await runHost(host, "computer.status")).toMatchObject({ result: { status: "idle" } });
  expect(mock.launch).not.toHaveBeenCalled();
});

it("retains method_unavailable from a helper missing initial access", async () => {
  mock.launch.mockRejectedValueOnce(new ComputerUseError("method_unavailable"));
  const f = executor();
  const { requestId } = (await f.json("computer.request_access"))!.result;
  expect(await f.json("computer.status", { requestId })).toMatchObject({
    result: { status: "cancelled", reason: "method_unavailable", requestId, revision: 2 },
  });
});

it("retains the launch validation error for an existing but incomplete helper app", async () => {
  const root = await mkdtemp(join(tmpdir(), "rome-cu-invalid-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const app = join(root, "Rome Computer Use.app");
  await mkdir(app);
  const host = new ComputerUseHost({
    discover: () => discovery.discoverHelper({ platform: "darwin", envPath: app }),
    launch: (options) =>
      bridge.ComputerUseBridge.launch({
        ...options,
        launcher: () => {
          throw new Error("unexpected launch");
        },
      }),
  });
  cleanups.push(() => host.disconnect());
  const request = await runHost(host, "computer.request_access");
  if (!request.ok) throw new Error("Expected a request ID");
  const { requestId } = request.result as { requestId: string };
  await expect
    .poll(() => runHost(host, "computer.status", { requestId }))
    .toMatchObject({
      result: { status: "cancelled", reason: "invalid_helper_bundle", requestId },
    });
});

it.each([
  "access_status",
  "disconnect",
])("reports local revocation via %s to an idle authorized peer", async (via) => {
  const helper = fakeHelper();
  let revoke!: (cause: ComputerUseError) => void;
  helper.accessStatus.mockImplementation(
    () =>
      new Promise((_, reject) => {
        revoke = reject;
      }),
  );
  mock.launch.mockResolvedValue(helper);
  const f = executor();
  await f.authorize();
  const { requestId, revision } = (await f.json("computer.status"))!.result;
  expect(helper.accessStatus).toHaveBeenCalledWith(1, expect.any(Object));
  if (via === "access_status") revoke(new ComputerUseError("session_stopped"));
  else helper.close();
  await Promise.resolve();
  expect(await f.json("computer.status", { requestId })).toMatchObject({
    result: { status: "cancelled", revision: revision + 1 },
  });
  expect(helper.closed).toBe(true);
});

it("keeps authorization when an earlier guide refocus times out", async () => {
  const helper = fakeHelper();
  helper.initialAccess = {
    status: "needs_system_permission",
    missing: ["accessibility"],
    guideOpened: true,
    revision: 1,
  };
  let grant!: (access: Results["access_status"]) => void;
  let rejectGuide!: (error: ComputerUseError) => void;
  helper.accessStatus.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        grant = resolve;
      }),
  );
  helper.openPermissionGuide.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectGuide = reject;
      }),
  );
  mock.launch.mockResolvedValue(helper);
  const f = executor();
  const { requestId } = (await f.json("computer.request_access"))!.result;
  expect(await f.json("computer.request_access")).toMatchObject({
    result: { status: "needs_system_permission" },
  });
  grant({ status: "authorized", revision: 2 });
  await expect
    .poll(() => f.json("computer.status", { requestId }))
    .toMatchObject({ result: { status: "authorized" } });
  rejectGuide(new ComputerUseError("request_timeout"));
  await Promise.resolve();
  expect(await f.json("computer.status", { requestId })).toMatchObject({
    result: { status: "authorized", revision: 3 },
  });
  expect(helper.closed).toBe(false);
});

it("aborts launch and closes active bridges immediately on disconnect", async () => {
  const f = executor();
  let started!: (signal: AbortSignal) => void;
  const launching = new Promise<AbortSignal>((resolve) => {
    started = resolve;
  });
  mock.launch.mockImplementationOnce(({ signal }: { signal: AbortSignal }) => {
    started(signal);
    return new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(new ComputerUseError("request_aborted")), {
        once: true,
      }),
    );
  });
  const pending = await f.json("computer.request_access");
  const signal = await launching;
  f.exec.disconnect();
  expect(signal.aborted).toBe(true);
  expect(await f.json("computer.status", { requestId: pending!.result.requestId })).toMatchObject({
    result: { status: "cancelled" },
  });

  const first = fakeHelper();
  const replacement = fakeHelper();
  mock.launch.mockResolvedValueOnce(first).mockResolvedValueOnce(replacement);
  const old = await f.bind();
  f.exec.disconnect();
  expect(first.closed).toBe(true);
  const current = await f.bind();
  expect(current).not.toBe(old);
  expect(await f.json("computer.act", input(old))).toMatchObject(error("binding_not_found"));
  expect(replacement.act).not.toHaveBeenCalled();
});

it("expires a binding and closes its helper within a bounded session lease", async () => {
  const helper = fakeHelper();
  mock.launch.mockResolvedValue(helper);
  const host = new ComputerUseHost({ discover: discoverHelper, sessionTtlMs: 20 });
  cleanups.push(() => host.disconnect());
  await authorizeHost(host);
  const bind = host.prepare("computer.bind", peer, { window: 1 })!;
  const bound = await bind.run();
  bind.release();
  expect(bound.response).toMatchObject({ ok: true });
  const binding = (bound.response as { result: { binding: string } }).result.binding;
  await delay(30);
  expect(helper.closed).toBe(true);
  const act = host.prepare("computer.act", peer, input(binding))!;
  expect((await act.run()).response).toMatchObject(error("binding_not_found"));
  act.release();
});

it("keeps holding windows on unconfirmed local revocation even after sessionTtlMs elapses", async () => {
  const helper = fakeHelper();
  mock.launch.mockResolvedValueOnce(helper).mockResolvedValueOnce(fakeHelper());
  const host = new ComputerUseHost({ discover: discoverHelper, sessionTtlMs: 30 });
  cleanups.push(() => host.disconnect());
  await authorizeHost(host);
  const run = async (action: string, args: unknown, from = peer) => {
    const op = host.prepare(action, from, args)!;
    try {
      return (await op.run()).response;
    } finally {
      op.release();
    }
  };
  expect(await run("computer.bind", { window: 1 })).toMatchObject({ ok: true });
  helper.onCancelRequested.mock.calls[0][0]();
  await delay(50);
  await authorizeHost(host, other);
  expect(await run("computer.cancel", undefined)).toMatchObject({ result: canceled });
  expect(await run("computer.bind", { window: 1 }, other)).toMatchObject(
    error("window_already_bound"),
  );
  helper.close(new ComputerUseError("session_stopped"));
  expect(await run("computer.cancel", undefined)).toMatchObject({ result: confirmed });
  expect(await run("computer.bind", { window: 1 }, other)).toMatchObject({ ok: true });
});

it.each([
  "local",
  "remote",
])("releases windows after an unconfirmed %s stop when the helper exits", async (stop) => {
  const helper = fakeHelper();
  mock.launch.mockResolvedValueOnce(helper).mockResolvedValue(fakeHelper());
  const isProcessAlive = rs.fn(() => true);
  const host = new ComputerUseHost({ isProcessAlive, stopPollMs: 5 });
  cleanups.push(() => host.disconnect());
  await authorizeHost(host);
  await authorizeHost(host, other);
  expect(await runHost(host, "computer.bind", { window: 1 })).toMatchObject({ ok: true });

  if (stop === "local") {
    helper.onCancelRequested.mock.calls[0][0]();
    helper.close();
  } else {
    helper.status.mockResolvedValue({ instance: helper.instanceId, ...canceled });
    expect(await runHost(host, "computer.cancel")).toMatchObject({ result: canceled });
  }
  await expect.poll(() => helper.closed, { timeout: 3_000 }).toBe(true);
  await expect.poll(() => isProcessAlive.mock.calls.length).toBeGreaterThan(0);
  expect(isProcessAlive).toHaveBeenCalledWith(helper.helperPid);
  expect(await runHost(host, "computer.cancel")).toMatchObject({ result: canceled });
  expect(await runHost(host, "computer.bind", { window: 1 }, other)).toMatchObject(
    error("window_already_bound"),
  );
  expect(await runHost(host, "computer.request_access")).toMatchObject(error("session_stopped"));

  isProcessAlive.mockReturnValue(false);
  await expect.poll(() => runHost(host, "computer.cancel")).toMatchObject({ result: confirmed });
  expect(await runHost(host, "computer.bind", { window: 1 }, other)).toMatchObject({ ok: true });
  expect(await runHost(host, "computer.request_access")).toMatchObject({ ok: true });
});

it("coalesces requests, keeps status private and read-only, and starts the lease only when ready", async () => {
  let now = 0;
  const helper = fakeHelper();
  let consent!: (bridge: typeof helper) => void;
  mock.launch.mockImplementation(
    () =>
      new Promise((resolve) => {
        consent = resolve;
      }),
  );
  const missing = ["screen_recording"] as const;
  const waiting: Results["access_status"] = {
    status: "needs_system_permission",
    revision: 1,
    missing: [...missing],
    guideOpened: false,
  };
  let grant!: (access: Results["access_status"]) => void;
  helper.initialAccess = waiting;
  helper.accessStatus.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        grant = resolve;
      }),
  );
  helper.openPermissionGuide.mockResolvedValue({ ...waiting, revision: 2, guideOpened: true });
  const host = new ComputerUseHost({ now: () => now });
  cleanups.push(() => host.disconnect());
  const call = (action: string, args?: unknown, from?: string) => runHost(host, action, args, from);
  expect(await call("computer.status")).toMatchObject({ result: { status: "idle" } });
  expect(await call("computer.windows")).toMatchObject(error("consent_required"));
  expect(await call("computer.bind", { window: 1 })).toMatchObject(error("consent_required"));
  expect(mock.discover).not.toHaveBeenCalled();
  const [first, second] = await Promise.all([
    call("computer.request_access"),
    call("computer.request_access"),
  ]);
  expect(first).toEqual(second);
  if (!first.ok) throw new Error("Expected a request ID");
  const { requestId } = first.result as { requestId: string };
  const details = { requestId, revision: 1, expiresInMs: 180_000 };
  expect(first.result).toEqual({ ...details, status: "pending_consent" });
  for (const action of ["computer.windows", "computer.bind"]) {
    expect(await call(action, action.endsWith("bind") ? { window: 1 } : {})).toMatchObject({
      error: { code: "pending_consent", details },
    });
  }
  expect(await call("computer.status", { requestId }, other)).toMatchObject({
    result: { status: "not_found", requestId },
  });
  await expect.poll(() => consent).toBeTypeOf("function");
  now = 170_000;
  consent(helper);
  await expect
    .poll(() => call("computer.status", { requestId }))
    .toMatchObject({ result: { status: "needs_system_permission" } });
  const permissions = { requestId, revision: 2, expiresInMs: 300_000, missing, guideOpened: false };
  for (const action of ["computer.windows", "computer.bind"]) {
    expect(await call(action, action.endsWith("bind") ? { window: 1 } : {})).toMatchObject({
      error: { code: "needs_system_permission", details: permissions },
    });
  }
  expect(helper.openPermissionGuide).not.toHaveBeenCalled();
  expect(helper.bind).not.toHaveBeenCalled();
  expect(helper.windows).not.toHaveBeenCalled();
  now += 299_000;
  expect(await call("computer.request_access")).toMatchObject({
    result: { ...permissions, expiresInMs: 1000 },
  });
  expect(helper.openPermissionGuide).toHaveBeenCalledTimes(1);
  expect(await call("computer.status")).toMatchObject({
    result: { revision: 3, guideOpened: true, expiresInMs: 1000 },
  });
  grant({ status: "authorized", revision: 3 });
  await expect
    .poll(() => call("computer.status"))
    .toMatchObject({
      result: { status: "authorized", requestId, revision: 4, expiresInMs: 300_000 },
    });
  expect(await call("computer.request_access")).toEqual(await call("computer.status"));
  expect(await call("computer.bind", { window: 1 })).toMatchObject({ ok: true });
  expect(mock.launch).toHaveBeenCalledTimes(1);
});

it.each([
  "consent_denied",
  "consent_expired",
] as const)("retains %s by request ID after a new request", async (code) => {
  mock.launch.mockRejectedValueOnce(new ComputerUseError(code)).mockResolvedValueOnce(fakeHelper());
  const f = executor();
  const { requestId } = (await f.json("computer.request_access"))!.result;
  await expect
    .poll(() => f.json("computer.status", { requestId }))
    .toMatchObject({ result: { status: code, requestId, revision: 2 } });
  expect(await f.json("computer.status")).toMatchObject({ result: { status: "idle" } });
  await f.authorize();
  expect(await f.json("computer.status", { requestId })).toMatchObject({
    result: { status: code, revision: 2 },
  });
  expect(await f.json("computer.status", { requestId }, other)).toMatchObject({
    result: { status: "not_found" },
  });
});

it.each([
  "cancel",
  "disconnect",
  "helper_exit",
  "local_stop",
  "permissions_expired",
] as const)("ignores a late permission grant after %s", async (stop) => {
  const helper = fakeHelper();
  const missing = ["accessibility", "screen_recording"] as const;
  let grant!: (access: Results["access_status"]) => void;
  helper.initialAccess = {
    status: "needs_system_permission",
    revision: 1,
    missing: [...missing],
    guideOpened: true,
  };
  helper.accessStatus.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        grant = resolve;
      }),
  );
  mock.launch.mockResolvedValueOnce(helper).mockResolvedValueOnce(fakeHelper());
  const host = new ComputerUseHost({
    permissionTtlMs: stop === "permissions_expired" ? 35 : 300_000,
  });
  cleanups.push(() => host.disconnect());
  const request = await runHost(host, "computer.request_access");
  if (!request.ok) throw new Error("Expected a request ID");
  const { requestId } = request.result as { requestId: string };
  await expect.poll(() => grant, { interval: 1 }).toBeTypeOf("function");
  if (stop === "cancel") await runHost(host, "computer.cancel");
  if (stop === "disconnect") host.disconnect();
  if (stop === "helper_exit") helper.close();
  if (stop === "local_stop") helper.close(new ComputerUseError("session_stopped"));
  const outcome =
    stop === "permissions_expired" ? { status: stop, missing } : { status: "cancelled" };
  await expect
    .poll(() => runHost(host, "computer.status", { requestId }))
    .toMatchObject({ result: { ...outcome, requestId, revision: 3 } });
  expect(helper.closed).toBe(true);
  await authorizeHost(host);
  grant({ status: "authorized", revision: 2 });
  expect(await runHost(host, "computer.status", { requestId })).toMatchObject({
    result: { ...outcome, requestId, revision: 3 },
  });
  expect(await runHost(host, "computer.status")).toMatchObject({
    result: { status: "authorized", revision: 2, requestId: expect.not.stringMatching(requestId) },
  });
});

it("expires outstanding consent, closes a late helper and forgets the terminal ID after retention", async () => {
  rs.useFakeTimers();
  cleanups.push(() => rs.useRealTimers());
  let consent!: (bridge: ReturnType<typeof fakeHelper>) => void;
  mock.launch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        consent = resolve;
      }),
  );
  const host = new ComputerUseHost({ consentTtlMs: 30, terminalTtlMs: 150, now: Date.now });
  cleanups.push(() => host.disconnect());
  const request = await runHost(host, "computer.request_access");
  if (!request.ok) throw new Error("Expected a request ID");
  const { requestId } = request.result as { requestId: string };
  const status = () => runHost(host, "computer.status", { requestId });
  await rs.advanceTimersByTimeAsync(30);
  expect(await status()).toMatchObject({ result: { status: "pending_consent", expiresInMs: 0 } });
  await rs.advanceTimersByTimeAsync(10_000);
  expect(await status()).toMatchObject({ result: { status: "consent_expired", revision: 2 } });
  const late = fakeHelper();
  consent(late);
  await Promise.resolve();
  expect(late.closed).toBe(true);
  expect(late.accessStatus).not.toHaveBeenCalled();
  await rs.advanceTimersByTimeAsync(150);
  expect(await status()).toMatchObject({ result: { status: "not_found", requestId } });
});

it("accepts the permission guide reply after the displayed consent deadline", async () => {
  rs.useFakeTimers();
  cleanups.push(() => rs.useRealTimers());
  const helper = fakeHelper();
  helper.initialAccess = {
    status: "needs_system_permission",
    revision: 1,
    missing: ["accessibility"],
    guideOpened: true,
  };
  let allow!: (result: typeof helper) => void;
  mock.launch.mockReturnValue(
    new Promise<typeof helper>((resolve) => {
      allow = resolve;
    }),
  );
  const host = new ComputerUseHost({ now: Date.now });
  cleanups.push(() => host.disconnect());
  const request = await runHost(host, "computer.request_access");
  if (!request.ok) throw new Error("Expected a request ID");
  const { requestId } = request.result as { requestId: string };
  expect(request.result).toMatchObject({ status: "pending_consent", expiresInMs: 180_000 });
  expect(mock.launch).toHaveBeenCalledWith(
    expect.objectContaining({ consentDialogTimeoutMs: 180_000 }),
  );
  await rs.advanceTimersByTimeAsync(181_000);
  for (const action of ["computer.status", "computer.request_access"]) {
    expect(await runHost(host, action)).toMatchObject({
      result: { requestId, status: "pending_consent", expiresInMs: 0 },
    });
  }
  allow(helper);
  await Promise.resolve();
  expect(await runHost(host, "computer.status", { requestId })).toMatchObject({
    result: {
      status: "needs_system_permission",
      guideOpened: true,
      revision: 2,
      expiresInMs: 300_000,
    },
  });
  expect(mock.launch).toHaveBeenCalledTimes(1);
});

it("bounds terminal records without evicting another watcher's unexpired result", async () => {
  const host = new ComputerUseHost({ launch: async () => new Promise(() => {}) });
  cleanups.push(() => host.disconnect());
  let oldest = "";
  for (let index = 0; index < 64; index++) {
    const response = await runHost(host, "computer.request_access");
    if (!response.ok) throw new Error("Expected a request ID");
    oldest ||= (response.result as { requestId: string }).requestId;
    await runHost(host, "computer.cancel");
  }
  expect(await runHost(host, "computer.request_access")).toMatchObject(error("busy"));
  expect(await runHost(host, "computer.status", { requestId: oldest })).toMatchObject({
    result: { status: "cancelled", requestId: oldest, revision: 2 },
  });
  expect(await runHost(host, "computer.request_access", {}, other)).toMatchObject({
    result: { status: "pending_consent", revision: 1 },
  });
});
