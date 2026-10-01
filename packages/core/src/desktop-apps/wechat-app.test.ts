import { describe, expect, it, rs } from "@rstest/core";
import { WechatApp, WechatAppNotInstalled, type WechatAppRuntime } from "./wechat-app.js";

/** A runtime whose install and start wait until the test releases them. */
function fakeRuntime(options: { installed?: boolean; pid?: number | null } = {}) {
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
  return { runtime, gates };
}

/** Let the job's promise chain move to its next await. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("WechatApp", () => {
  it("reports absent, stopped and running from the client", async () => {
    expect(await new WechatApp(fakeRuntime().runtime).status()).toEqual({ state: "absent" });
    expect(await new WechatApp(fakeRuntime({ installed: true }).runtime).status()).toEqual({
      state: "stopped",
    });
    expect(await new WechatApp(fakeRuntime({ installed: true, pid: 7 }).runtime).status()).toEqual({
      state: "running",
    });
  });

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

    const absent = new WechatApp(fakeRuntime().runtime);
    await expect(absent.start()).rejects.toBeInstanceOf(WechatAppNotInstalled);
  });

  it("keeps a failed start's reason on the stopped client", async () => {
    const { runtime, gates } = fakeRuntime({ installed: true });
    const app = new WechatApp(runtime);
    await app.start();
    gates[0]!.fail(new Error("Could not start WeChat's desktop: port 5901 is busy"));
    await app.settled();
    expect(await app.status()).toEqual({
      state: "stopped",
      error: "Could not start WeChat's desktop: port 5901 is busy",
    });
  });
});
