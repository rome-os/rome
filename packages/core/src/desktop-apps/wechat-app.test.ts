import { describe, expect, it, rs } from "@rstest/core";
import { WechatApp, WechatAppNotInstalled, type WechatAppRuntime } from "./wechat-app.js";

interface FakeOptions {
  installed?: boolean;
  pid?: number | null;
  clientDisplay?: string;
  installInFlight?: boolean;
  lastExit?: number | null;
}

/** A runtime whose install and start wait until the test releases them. */
function fakeRuntime(options: FakeOptions = {}) {
  let installed = options.installed ?? false;
  let pid = options.pid ?? null;
  const gates: { release: () => void; fail: (error: Error) => void }[] = [];
  const gate = (onRelease: () => void) =>
    new Promise<void>((resolve, reject) => {
      gates.push({
        release: () => {
          onRelease();
          resolve();
        },
        fail: reject,
      });
    });
  const runtime = {
    installInFlight: options.installInFlight ?? false,
    captureInProgress: false as boolean,
    display: ":100",
    clientLog: "/home/rome/.local/share/wechat/client.log",
    clientDisplay: rs.fn(async () => options.clientDisplay ?? ":100"),
    installed: rs.fn(async () => installed),
    pid: rs.fn(async () => pid),
    lastExit: rs.fn(async () => options.lastExit ?? null),
    install: rs.fn(() =>
      gate(() => {
        installed = true;
      }),
    ),
    start: rs.fn(() =>
      gate(() => {
        pid = 4242;
      }),
    ),
  } satisfies WechatAppRuntime;
  return {
    runtime,
    gates,
    /** The client exits with `code`, as the launch wrapper records it. */
    exit(code: number) {
      pid = null;
      runtime.lastExit.mockImplementation(async () => code);
    },
  };
}

/** Let the job's promise chain move to its next await. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A booted app watching a running client. */
async function bootedWithRunningClient(now: () => number = Date.now) {
  const fake = fakeRuntime({ installed: true, pid: 7 });
  const app = new WechatApp(fake.runtime, now);
  await app.tick();
  return { ...fake, app };
}

describe("WechatApp status", () => {
  it("reports absent, starting and running from the client", async () => {
    expect(await new WechatApp(fakeRuntime().runtime).status()).toEqual({ state: "absent" });
    // Installed and not running, before the first check: that check starts it.
    expect(await new WechatApp(fakeRuntime({ installed: true }).runtime).status()).toEqual({
      state: "starting",
    });
    expect(await new WechatApp(fakeRuntime({ installed: true, pid: 7 }).runtime).status()).toEqual({
      state: "running",
    });
  });

  it("says when the client runs on the shared desktop instead of its own", async () => {
    const onShared = fakeRuntime({ installed: true, pid: 7, clientDisplay: ":99" });
    expect(await new WechatApp(onShared.runtime).status()).toEqual({
      state: "running",
      sharedDesktop: true,
    });
  });

  it("keeps WeChat's desktop on view while the connection's key capture relaunches the client", async () => {
    const { runtime } = fakeRuntime({ installed: true });
    runtime.captureInProgress = true;
    expect(await new WechatApp(runtime).status()).toEqual({ state: "running" });
  });

  it("reports an install the connection's setup started, so the page offers no second one", async () => {
    const app = new WechatApp(fakeRuntime({ installInFlight: true }).runtime);
    expect(await app.status()).toEqual({ state: "installing" });
  });
});

describe("WechatApp install and start", () => {
  it("downloads the client in the background, then opens it", async () => {
    const { runtime, gates } = fakeRuntime();
    const app = new WechatApp(runtime);

    expect(await app.install()).toEqual({ state: "installing" });
    expect(runtime.start).not.toHaveBeenCalled();

    gates[0]!.release();
    await tick();
    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(await app.status()).toEqual({ state: "installing" });

    gates[1]!.release();
    await app.settled();
    expect(await app.status()).toEqual({ state: "running" });
  });

  it("joins an install already running instead of starting another", async () => {
    const { runtime, gates } = fakeRuntime();
    const app = new WechatApp(runtime);

    await app.install();
    await app.install();
    expect(await app.start()).toEqual({ state: "installing" });
    expect(runtime.install).toHaveBeenCalledTimes(1);

    gates[0]!.release();
    await tick();
    gates[1]!.release();
    await app.settled();
    expect(runtime.start).toHaveBeenCalledTimes(1);
  });

  it("starts nothing while the connection's setup owns the install", async () => {
    const { runtime } = fakeRuntime({ installInFlight: true });
    const app = new WechatApp(runtime);

    expect(await app.install()).toEqual({ state: "installing" });
    expect(await app.start()).toEqual({ state: "installing" });
    expect(runtime.install).not.toHaveBeenCalled();
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it("reports why an install failed, and clears it when the next one begins", async () => {
    const { runtime, gates } = fakeRuntime();
    const app = new WechatApp(runtime);

    await app.install();
    gates[0]!.fail(new Error("Could not download the WeChat client: 503"));
    await app.settled();
    expect(await app.status()).toEqual({
      state: "absent",
      error: "Could not download the WeChat client: 503",
    });

    expect(await app.install()).toEqual({ state: "installing" });
    gates[1]!.release();
    await tick();
    gates[2]!.release();
    await app.settled();
    expect(await app.status()).toEqual({ state: "running" });
  });

  it("refuses to start a client that is not downloaded", async () => {
    await expect(new WechatApp(fakeRuntime().runtime).start()).rejects.toBeInstanceOf(
      WechatAppNotInstalled,
    );
  });

  it("keeps a failed start's reason until the client runs", async () => {
    const { runtime, gates } = fakeRuntime({ installed: true });
    const app = new WechatApp(runtime);
    await app.start();
    gates[0]!.fail(new Error("Could not start WeChat's desktop: port 5901 is busy"));
    await app.settled();
    expect(await app.status()).toEqual({
      state: "stopped",
      error: "Could not start WeChat's desktop: port 5901 is busy",
    });

    await app.start();
    gates[1]!.release();
    await app.settled();
    expect(await app.status()).toEqual({ state: "running" });
  });
});

describe("WechatApp keeps the client running", () => {
  it("starts an installed client when Rome boots, even one the guardian quit", async () => {
    const { runtime, gates } = fakeRuntime({ installed: true, lastExit: 0 });
    const app = new WechatApp(runtime);

    await app.tick();
    expect(runtime.start).toHaveBeenCalledTimes(1);
    gates[0]!.release();
    await app.settled();
    expect(await app.status()).toEqual({ state: "running" });
  });

  it("restarts a client that crashed", async () => {
    const { runtime, app, exit, gates } = await bootedWithRunningClient();

    exit(139);
    expect(await app.status()).toEqual({ state: "starting" });
    await app.tick();
    expect(runtime.start).toHaveBeenCalledTimes(1);
    gates[0]!.release();
    await app.settled();
    expect(await app.status()).toEqual({ state: "running" });
  });

  it("leaves a client the guardian quit stopped until they start it", async () => {
    const { runtime, app, exit, gates } = await bootedWithRunningClient();

    exit(0);
    await app.tick();
    expect(runtime.start).not.toHaveBeenCalled();
    expect(await app.status()).toEqual({ state: "stopped" });

    expect(await app.start()).toEqual({ state: "starting" });
    gates[0]!.release();
    await app.settled();
    expect(await app.status()).toEqual({ state: "running" });
  });

  it("stops restarting a client that keeps crashing, and says where its log is", async () => {
    let now = 1_000_000;
    const { runtime, app, exit, gates } = await bootedWithRunningClient(() => now);

    for (let crash = 0; crash < 3; crash++) {
      exit(139);
      await app.tick();
      gates[crash]!.release();
      await app.settled();
      now += 30_000;
    }
    exit(139);
    await app.tick();

    expect(runtime.start).toHaveBeenCalledTimes(3);
    expect(await app.status()).toEqual({
      state: "stopped",
      error: `WeChat exited 3 times in 5 minutes. Its log is at ${runtime.clientLog}`,
    });

    // Start clears the limit.
    await app.start();
    expect(runtime.start).toHaveBeenCalledTimes(4);
  });

  it("restarts nothing while the connection's key capture holds the client", async () => {
    const { runtime, app, exit } = await bootedWithRunningClient();
    runtime.captureInProgress = true;
    exit(143);
    await app.tick();
    expect(runtime.start).not.toHaveBeenCalled();
  });
});
