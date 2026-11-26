import { afterEach, beforeEach, expect, it, rs } from "@rstest/core";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AuditStore } from "../audit.js";
import { createExecutor, type HostAudit } from "../executor.js";
import { decodeMeta, encodeMeta, FRAME_TYPE, type Frame } from "../frame.js";
import type { OutboundEnvelope } from "../protocol.js";
import type { ComputerUseBridge } from "./bridge.js";
import { discoverHelper } from "./discovery.js";
import * as discovery from "./discovery.js" with { rstest: "importActual" };
import { ComputerUseHost } from "./host.js";
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
    closed: false,
    onDisconnect: (listener: Disconnect) => {
      disconnect = listener;
      return () => {
        disconnect = undefined;
      };
    },
    close: rs.fn(() => {
      if (helper.closed) return;
      helper.closed = true;
      disconnect?.(new ComputerUseError("connection_closed"));
    }),
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
    return replies.get(id)?.payload as { result: { binding: string }; ok: boolean } | undefined;
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
  const bind = async (from = peer, windowId = 1) =>
    (await json("computer.bind", { window: windowId }, from))!.result.binding;
  return { exec, json, binary, bind };
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

it("passes the host's bundled app to discovery", async () => {
  const bundledAppPath = "/resources/native/Rome Computer Use.app";
  await executor(noAudit, bundledAppPath).json("system.info");
  expect(mock.discover).toHaveBeenCalledWith({ bundledAppPath });
});

it.each([
  "computer_use_unsupported_platform",
  "computer_use_helper_missing",
  "invalid_helper_bundle",
] as const)("advertises off and returns %s without launching", async (code) => {
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
  expect(await f.json("computer.windows")).toMatchObject(error(code));
  expect((await f.binary("computer.bind", { window: 1 })).response).toMatchObject(error(code));
  expect(await f.json("computer.cancel")).toMatchObject({ result: confirmed });
  expect(await f.json("computer.windows")).toMatchObject(error(code));
  expect(mock.launch).not.toHaveBeenCalled();
});

it("refuses helper launch while the host cannot record the request", async () => {
  const f = executor({ ...noAudit, start: async () => null });
  expect(await f.json("computer.bind", { window: 1 })).toMatchObject(error("audit_unavailable"));
  expect(mock.launch).not.toHaveBeenCalled();
  expect(await f.json("computer.cancel")).toMatchObject({ result: confirmed });
  expect(await f.json("computer.bind", { window: 1 })).toMatchObject(error("session_stopped"));
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
  expect(await f.json("computer.windows", { application: shellToken })).toMatchObject({
    result: { windows: [{ title }] },
  });
  const binding = await f.bind();
  expect(await f.json("system.info")).toMatchObject({
    result: { capabilities: [{ state: "on" }] },
  });
  expect(binding).not.toBe(nativeId);
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
  const opening = f.json("computer.windows");
  await expect.poll(() => missing).toBeTypeOf("function");
  expect(await f.json("computer.cancel")).toMatchObject({ result: confirmed });
  expect((await f.binary("computer.cancel", {})).response).toMatchObject({ result: confirmed });
  expect(mock.discover).toHaveBeenCalledTimes(1);
  missing();
  await opening;
  expect(await f.json("computer.bind", { window: 1 })).toMatchObject(error("session_stopped"));
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
  const opening = f.json("computer.windows");
  const signal = await launching;
  expect(await f.json("computer.cancel")).toMatchObject({ result: confirmed });
  expect(signal.aborted).toBe(true);
  expect(await opening).toMatchObject(error("request_aborted"));
  expect(await f.json("system.info")).toMatchObject({
    result: {
      actions: ["system.info", "exec", "fs.list", "computer.cancel"],
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
  const pending = f.json("computer.windows");
  const signal = await launching;
  f.exec.disconnect();
  expect(signal.aborted).toBe(true);
  expect(await pending).toBeUndefined();

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
