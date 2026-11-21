import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  type ComputerUseAct,
  type ComputerUseBinding,
  ComputerUseError,
  type ComputerUseHello,
  type ComputerUseObservation,
  type ComputerUseReceipt,
  type ComputerUseWindow,
  createComputerUseHost,
  createComputerUseNativeBridge,
  mergeComputerUseObservation,
} from "../../dist/computer-use.js";
import { createNativeRpcTransport } from "../../dist/computer-use/native-bridge.js";

type Identity = { pid: number; seconds: number; micros: number; executable: string };
type Owned = { child: ChildProcess; executable: string; started: number; identity?: Identity };
type FixtureState = {
  pid: number;
  window: number;
  exact: number;
  onScreen: boolean;
  front: number;
  key: boolean;
  fullScreen: boolean;
  clicks: number;
  groupPresses: number;
  samples: number;
  violations: number;
  uptime: number;
};
type Diagnostics = ComputerUseHello & {
  activeSessions: number;
  focus: {
    frontPID: number;
    keyFocusPID: number;
    virtualPointer: { visible: boolean };
    sessions: Array<{
      sessionId: string;
      targetPID: number;
      targetWindowId: number;
      eventsPosted: number;
      localFocus: { held: boolean };
      controlCapture: { stopConfirmed?: boolean };
    }>;
  };
};

const run = promisify(execFile);
const preference = ["com.rome.computer-use", "stateDirectory"];
const title = "Rome Space Acceptance B";
const targetBundle = "com.rome.tests.window-space-b";

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string) {
  const deadline = performance.now() + 12_000;
  while (performance.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function buildFixtures(directory: string) {
  const env = { ...process.env };
  delete env.DEVELOPER_DIR;
  delete env.SDKROOT;
  delete env.TOOLCHAINS;
  const xcode = async (...args: string[]) =>
    (await run("/usr/bin/xcrun", ["--sdk", "macosx", ...args], { env })).stdout.trim();
  const sdk = await xcode("--show-sdk-path");
  const native = join(import.meta.dirname, "..");
  const object = join(directory, "identity.o");
  await xcode("clang", "-isysroot", sdk, "-c", join(native, "ProcessIdentity.c"), "-o", object);
  const fixtures = await Promise.all(
    ["A", "B"].map(async (role) => {
      const data = join(directory, role);
      const bundle = join(data, `Rome Space Acceptance ${role}.app`);
      const executable = join(bundle, "Contents/MacOS/WindowSpaceFixture");
      await mkdir(join(bundle, "Contents/MacOS"), { recursive: true, mode: 0o700 });
      await writeFile(
        join(bundle, "Contents/Info.plist"),
        `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.rome.tests.window-space-${role.toLowerCase()}</string><key>CFBundleExecutable</key><string>WindowSpaceFixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
      );
      return { bundle, executable, data };
    }),
  );
  const [a, b] = fixtures;
  assert(a && b);
  await xcode(
    "swiftc",
    "-sdk",
    sdk,
    "-swift-version",
    "5",
    "-parse-as-library",
    "-import-objc-header",
    join(native, "ProcessIdentity.h"),
    join(import.meta.dirname, "WindowSpaceFixture.swift"),
    object,
    "-o",
    a.executable,
  );
  await copyFile(a.executable, b.executable);
  await Promise.all(
    fixtures.map(({ bundle }) => run("/usr/bin/codesign", ["--force", "--sign", "-", bundle])),
  );
  return { a, b };
}

async function main() {
  const app = process.argv[2];
  assert.equal(process.argv.length, 3, "Pass a private, signed Rome Computer Use.app candidate");
  assert(app && process.platform === "darwin");
  const appPath = await realpath(app);
  assert(
    appPath.includes("/.scratch/"),
    "Use a private candidate outside the installed helper path",
  );
  await run("/usr/bin/codesign", ["--verify", "--strict", appPath]);
  const directory = await mkdtemp("/private/tmp/rome-window-space-");
  console.log(JSON.stringify({ directory }));
  const { a, b } = await buildFixtures(directory);
  const stateDir = join(directory, "helper");
  await mkdir(stateDir, { mode: 0o700 });
  const options = { appPath, stateDir, requestTimeoutMs: 5000 };
  const rpc = createNativeRpcTransport(options);
  const bridge = createComputerUseNativeBridge(options);
  const children: Owned[] = [];
  const createLocalClient = (hostOptions: Parameters<typeof createComputerUseHost>[0]) => {
    const host = createComputerUseHost(hostOptions);
    const peer = `window-space-${randomUUID()}`;
    const observations = new Map<string, ComputerUseObservation>();
    const unwrap = <T>(response: Awaited<ReturnType<typeof host.run>>): T => {
      if (!response.ok)
        throw new ComputerUseError(
          response.error.code,
          response.error.message,
          response.error.details,
        );
      return response.result as T;
    };
    return {
      async windows() {
        return unwrap<{ windows: ComputerUseWindow[] }>(
          await host.run("computer.windows", {}, peer),
        ).windows;
      },
      async bind(windowRef: string) {
        return unwrap<ComputerUseBinding>(await host.run("computer.bind", { windowRef }, peer));
      },
      async observe(sessionId: string, screenshot = false, opts: { full?: boolean } = {}) {
        const previous = opts.full ? undefined : observations.get(sessionId);
        const args = {
          sessionId,
          screenshot,
          ...(previous ? { sinceObservationId: previous.observationId } : {}),
        };
        const { response, body } = screenshot
          ? await host.runBinary("computer.observe", args, new Uint8Array(), peer)
          : { response: await host.run("computer.observe", args, peer), body: undefined };
        const changes = unwrap<ComputerUseObservation>(response);
        const observation = mergeComputerUseObservation(previous, changes);
        observations.set(sessionId, observation);
        return { observation, changes, image: body };
      },
      async act(args: ComputerUseAct) {
        return unwrap<ComputerUseReceipt>(await host.run("computer.act", args, peer));
      },
      async cancel(sessionId: string) {
        observations.delete(sessionId);
        return unwrap(await host.run("computer.cancel", { sessionId }, peer));
      },
      async close() {
        host.disconnect();
        await host.idle();
      },
    };
  };
  let client: ReturnType<typeof createLocalClient> | undefined;
  let helper: Owned | undefined;
  let sessionId: string | undefined;
  let actCalls = 0;
  const cleanupErrors: unknown[] = [];
  const cleanup = async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      cleanupErrors.push(error);
    }
  };
  const identity = async (owned: Owned): Promise<Identity | undefined> => {
    if (owned.child.exitCode !== null || owned.child.signalCode !== null || !owned.child.pid)
      return;
    const { stdout } = await run(a.executable, ["--identity", String(owned.child.pid)], {
      timeout: 2000,
    });
    const current = JSON.parse(stdout) as Identity;
    assert.equal(current.pid, owned.child.pid);
    assert.equal(current.executable, owned.executable);
    assert(current.seconds * 1000 + current.micros / 1000 >= owned.started - 1000);
    return current;
  };
  const launch = async (executable: string, args: string[]) => {
    const started = Date.now();
    const child = spawn(executable, args, { stdio: "ignore" });
    const owned = { child, executable, started } as Owned;
    children.push(owned);
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    owned.identity = await identity(owned);
    assert(owned.identity, "Could not record the launched fixture or helper kernel identity");
    return owned;
  };
  const state = async (data: string): Promise<FixtureState | undefined> => {
    const json = await readFile(join(data, "state.json"), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return;
        throw error;
      },
    );
    return json === undefined ? undefined : (JSON.parse(json) as FixtureState);
  };
  const hello = async () => (await rpc.call("hello", {})) as Diagnostics;
  const previous = await run("/usr/bin/defaults", ["read", ...preference]).then(
    ({ stdout }) => stdout.trimEnd(),
    (error: { code?: number }) => {
      if (error.code !== 1) throw error;
      return undefined;
    },
  );
  let phase = "helper startup";
  let failure: unknown;
  try {
    await assert.rejects(rpc.call("hello", {}), { code: "helper_unavailable" });
    helper = await launch(await realpath(join(appPath, "Contents/MacOS/RomeComputerUse")), [
      "--state-dir",
      stateDir,
    ]);
    client = createLocalClient({
      ...options,
      native: {
        async call(method, params) {
          if (method === "act") actCalls++;
          return bridge.call(method, params);
        },
      },
    });
    const status = await waitFor(
      () =>
        hello().catch((error: unknown) => {
          if (error instanceof ComputerUseError && error.code === "helper_unavailable")
            return undefined;
          throw error;
        }),
      (value) => value !== undefined,
      "private helper RPC",
    );
    assert(status);
    assert.equal(status.pid, helper.child.pid);
    assert(
      status.permissions.accessibility && status.permissions.screenCapture,
      "Existing macOS grants required",
    );
    assert.equal(status.activeSessions, 0);
    phase = "B visible in the original Space";
    const second = await launch(b.executable, ["B", b.data]);
    const visible = await waitFor(
      () => state(b.data),
      (value) => !!value?.onScreen && value.exact === 1,
      phase,
    );
    assert(visible && visible.window > 0);
    assert.equal(visible.pid, second.child.pid);
    assert.notEqual(visible.front, visible.pid, "B must never become foreground");
    const before = (await client.windows()).filter(
      (row) => row.bundleId === targetBundle && row.title === title,
    );
    assert.equal(before.length, 1);

    phase = "A fullscreen and B off-screen";
    const first = await launch(a.executable, [
      "A",
      a.data,
      String(visible.pid),
      String(visible.window),
    ]);
    const offscreen = await waitFor(
      () => state(a.data),
      (value) =>
        !!value?.fullScreen &&
        value.front === first.child.pid &&
        value.key &&
        value.exact === 1 &&
        !value.onScreen,
      phase,
    );
    assert(offscreen);
    const assertInputIsolation = async () => {
      const value = await hello();
      assert.equal(value.focus.frontPID, offscreen.pid);
      assert.equal(value.focus.keyFocusPID, offscreen.pid);
      assert.equal(value.focus.virtualPointer.visible, false);
      if (sessionId !== undefined) {
        const entry = value.focus.sessions.find((entry) => entry.sessionId === sessionId);
        assert(entry);
        assert.equal(entry.targetPID, visible.pid);
        assert.equal(entry.targetWindowId, visible.window);
        assert.equal(entry.eventsPosted, 0);
        assert.equal(entry.localFocus.held, false);
      }
      return value;
    };
    await assertInputIsolation();
    await writeFile(join(a.data, "arm"), "", { flag: "wx", mode: 0o600 });
    await waitFor(
      () => state(a.data),
      (value) => !!value?.samples,
      "independent focus and pointer monitor",
    );

    phase = "discover B in the other Space";
    const candidates = (await client.windows()).filter(
      (row) => row.bundleId === targetBundle && row.title === title,
    );
    assert.equal(candidates.length, 1, "Exact B disappeared from discovery after the Space change");
    assert.notEqual(
      candidates[0].windowRef,
      before[0].windowRef,
      "The prior input mode must stay fixed",
    );
    const rediscovered = (await client.windows()).filter(
      (row) => row.bundleId === targetBundle && row.title === title,
    );
    assert.equal(rediscovered.length, 1);
    assert.notEqual(
      rediscovered[0].windowRef,
      candidates[0].windowRef,
      "A new listing must not inherit an older reference's expiry",
    );
    phase = "bind exact B";
    const binding = await client.bind(rediscovered[0].windowRef);
    sessionId = binding.sessionId;
    const capabilities = binding.capabilities as {
      inputIsolation: string;
      transport: string;
      actions: string[];
    };
    assert.equal(capabilities.inputIsolation, "window_semantics");
    assert.equal(capabilities.transport, "ax_only");
    assert.deepEqual([...capabilities.actions].sort(), [
      "click",
      "press",
      "selectText",
      "setValue",
    ]);
    await assertInputIsolation();

    phase = "observe full AX snapshot and window image";
    const full = await client.observe(sessionId, true, { full: true });
    assert(full.image && full.image.length > 8);
    assert.equal(full.changes.delta?.mode, "full");
    assert(
      !full.observation.elements.some((element) => element.identifier === "space-a-increment"),
    );
    const button = full.observation.elements.find(
      (element) => element.identifier === "space-b-increment",
    );
    assert(button && Array.isArray(button.actions) && button.actions.includes("press"));
    phase = "observe delta and reject unsafe actions";
    const freshArgs = async (
      action: ComputerUseAct["action"],
      ref = button.ref,
    ): Promise<ComputerUseAct> => {
      assert(sessionId);
      const { observation, changes } = await client!.observe(sessionId);
      assert.equal(changes.delta?.mode, "delta");
      assert(observation.elements.some((element) => element.ref === ref));
      return {
        sessionId,
        actionId: randomUUID(),
        observationId: observation.observationId,
        stateVersion: observation.stateVersion,
        ref,
        action,
      };
    };
    for (const action of [
      { type: "key", key: "Q" },
      { type: "click", x: 1, y: 1 },
    ] as const) {
      await assert.rejects(client.act(await freshArgs(action)), { code: "unsupported_action" });
      assert.equal(actCalls, 0, "Invalid input reached the native act method");
      await assert.rejects(
        rpc.call("act", { ...(await freshArgs(action)) }),
        (error: unknown) =>
          error instanceof ComputerUseError &&
          (error.code === "unsupported_window_semantics" ||
            (action.type === "click" && error.code === "invalid_element_ref")) &&
          error.details.effectStatus === "not_dispatched",
      );
      await assertInputIsolation();
    }
    assert.equal((await state(b.data))?.clicks, 0);

    phase = "press in B and verify receiver state";
    const receipt = await client.act(await freshArgs({ type: "press" }));
    assert.equal(receipt.eventsPosted, 0);
    assert.equal(receipt.operationsDispatched, 1);
    assert.equal(actCalls, 1);
    const affected = await waitFor(
      () => state(b.data),
      (value) => value?.clicks === 1,
      "one AppKit button handler call",
    );
    assert(
      affected &&
        affected.pid === visible.pid &&
        affected.window === visible.window &&
        !affected.onScreen,
    );
    const delta = await client.observe(sessionId);
    assert.equal(delta.changes.delta?.mode, "delta");
    assert(
      delta.observation.elements.some(
        (element) =>
          element.identifier === "space-fixture-count" &&
          (element.value === "Count: 1" || element.title === "Count: 1"),
      ),
    );
    await assertInputIsolation();

    phase = "observe the deep Workspace result and reject its group press";
    const elements = delta.observation.elements;
    const workspace = elements.find((element) => element.identifier === "space-b-workspace");
    assert(
      workspace?.role === "AXStaticText" &&
        (workspace.title === "Workspace" || workspace.value === "Workspace"),
    );
    assert.deepEqual(workspace.actions, []);
    const parents = new Map(elements.map((element) => [element.ref, element]));
    const group = parents.get(String(workspace.parentRef));
    assert(group?.role === "AXGroup" && group.identifier === "space-b-workspace-result");
    assert.deepEqual(group.actions, []);
    let depth = 0;
    for (let parent = workspace.parentRef; typeof parent === "string"; ) {
      const node = parents.get(parent);
      assert(node && ++depth < elements.length, "Invalid AX ancestry");
      parent = node.parentRef;
    }
    assert(depth >= 22, "Workspace must exercise the deep result hierarchy");
    assert.equal((await state(b.data))?.groupPresses, 0);
    await assert.rejects(client.act(await freshArgs({ type: "press" }, group.ref)), {
      code: "unsupported_action",
    });
    assert.equal(actCalls, 1, "A group press escaped the Host's semantic action check");
    await assert.rejects(
      rpc.call("act", { ...(await freshArgs({ type: "press" }, group.ref)) }),
      (error: unknown) =>
        error instanceof ComputerUseError &&
        error.code === "invalid_element_ref" &&
        error.details.effectStatus === "not_dispatched",
    );
    await assertInputIsolation();
    const lastB = await state(b.data);
    assert(lastB);
    const receiver = await waitFor(
      () => state(b.data),
      (value) => (value?.uptime ?? 0) > lastB.uptime,
      "independent receiver sample after the group press rejections",
    );
    assert(
      receiver &&
        receiver.pid === visible.pid &&
        receiver.window === visible.window &&
        !receiver.onScreen &&
        receiver.clicks === 1 &&
        receiver.groupPresses === 0,
    );
    const cancelled = sessionId;
    await client.cancel(cancelled);
    await waitFor(
      hello,
      (value) =>
        value.activeSessions === 0 &&
        value.focus.sessions.some(
          (entry) => entry.sessionId === cancelled && entry.controlCapture.stopConfirmed === true,
        ),
      "private capture shutdown",
    );
    const monitored = await waitFor(
      () => state(a.data),
      (value) => (value?.uptime ?? 0) > receiver.uptime,
      "final independent sample",
    );
    assert(monitored && monitored.samples > 1);
    assert.equal(monitored.violations, 0);
    assert.equal(monitored.clicks, 0);
    assert.equal(monitored.groupPresses, 0);
    sessionId = undefined;
    console.log(
      JSON.stringify({
        helperVersion: status.version,
        implementationSha256: status.implementationSha256,
        discoveredAcrossSpaces: true,
        axPresses: 1,
        workspaceLabelAXDepth: depth,
        groupPressRejections: 2,
        coordinateAndKeyRejections: 4,
        agentCGEvents: 0,
        samples: monitored.samples,
      }),
    );
  } catch (error) {
    failure = new Error(`Window Space acceptance failed during: ${phase}`, { cause: error });
  } finally {
    if (sessionId && client) await cleanup(() => client!.cancel(sessionId!));
    if (client) await cleanup(() => client!.close());
    if (helper?.identity && helper.child.exitCode === null && helper.child.signalCode === null) {
      await cleanup(async () => {
        assert.equal((await hello()).pid, helper?.child.pid);
        await rpc.call("shutdown", {});
      });
    }
    await Promise.all(
      [a.data, b.data].map((data) =>
        cleanup(() => writeFile(join(data, "stop"), "", { mode: 0o600 })),
      ),
    );
    await Promise.all(
      children.map((owned) =>
        cleanup(async () => {
          for (const signal of ["SIGTERM", "SIGKILL"] as const) {
            const end = performance.now() + 1500;
            while (
              owned.child.exitCode === null &&
              owned.child.signalCode === null &&
              performance.now() < end
            )
              await delay(20);
            const current = await identity(owned);
            if (!current) return;
            assert.deepEqual(
              current,
              owned.identity,
              "Refusing to signal a process whose kernel identity changed",
            );
            process.kill(current.pid, signal);
          }
          await waitFor(
            async () => owned.child.exitCode !== null || owned.child.signalCode !== null,
            Boolean,
            "owned process exit",
          );
        }),
      ),
    );
    await cleanup(async () => {
      const current = await run("/usr/bin/defaults", ["read", ...preference]).then(
        ({ stdout }) => stdout.trimEnd(),
        (error: { code?: number }) => {
          if (error.code !== 1) throw error;
          return undefined;
        },
      );
      if (current !== stateDir) return;
      if (previous === undefined) await run("/usr/bin/defaults", ["delete", ...preference]);
      else await run("/usr/bin/defaults", ["write", ...preference, "-string", previous]);
    });
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      failure ? [failure, ...cleanupErrors] : cleanupErrors,
      "Window Space acceptance cleanup failed",
    );
  if (failure) throw failure;
  console.log(JSON.stringify({ cleanup: "passed", processes: children.length }));
}

await main();
