import { describe, expect, it, rs } from "@rstest/core";
import { WechatApp, WechatAppNotInstalled, type WechatAppRuntime } from "./wechat-app.js";

interface FakeOptions {
  installed?: boolean;
  pid?: number | null;
  clientDisplay?: string;
  installInFlight?: boolean;
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
    clientDisplay: rs.fn(async () => options.clientDisplay ?? ":100"),
    installed: rs.fn(async () => installed),
    pid: rs.fn(async () => pid),
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
    exit() {
      pid = null;
    },
  };
}

/** Let the job's promise chain move to its next await. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("WechatApp status", () => {
  it("reports absent, stopped and running from the client", async () => {
    expect(await new WechatApp(fakeRuntime().runtime).status()).toEqual({ state: "absent" });
    expect(await new WechatApp(fakeRuntime({ installed: true }).runtime).status()).toEqual({
      state: "stopped",
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

  it("opens a downloaded client, and refuses one that is not downloaded", async () => {
    const stopped = fakeRuntime({ installed: true });
    const app = new WechatApp(stopped.runtime);
    expect(await app.start()).toEqual({ state: "starting" });
    stopped.gates[0]!.release();
    await app.settled();
    expect(await app.status()).toEqual({ state: "running" });

    await expect(new WechatApp(fakeRuntime().runtime).start()).rejects.toBeInstanceOf(
      WechatAppNotInstalled,
    );
  });

  it("keeps a failed start's reason until the client runs", async () => {
    const { runtime, gates, exit } = fakeRuntime({ installed: true });
    const app = new WechatApp(runtime);
    await app.start();
    gates[0]!.fail(new Error("Could not start WeChat's desktop: port 5901 is busy"));
    await app.settled();
    expect(await app.status()).toEqual({
      state: "stopped",
      error: "Could not start WeChat's desktop: port 5901 is busy",
    });

    // The connection starts the client another way; the old failure no longer
    // describes it, even after that client exits.
    runtime.pid.mockImplementationOnce(async () => 9);
    expect((await app.status()).state).toBe("running");
    exit();
    expect(await app.status()).toEqual({ state: "stopped" });
  });
});
