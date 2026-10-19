import { describe, expect, it, rs } from "@rstest/core";

rs.mock("../logger", () => ({
  createLogger: () => ({ error: rs.fn(), info: rs.fn(), warn: rs.fn() }),
}));

import { EventEmitter } from "events";
import type { CloudInstance } from "@rome-os/libs/native-auth";
import type { CloudAccount } from "../cloud/account";
import { RuntimeController } from "./controller";
import type { RuntimeStatus } from "./provider";
import { RemoteRuntime } from "./remote";
import type { Runtime } from "./runtime";
import type { RuntimeTarget } from "./target";

class FakeRuntime extends EventEmitter {
  ready = false;
  ensureReady = rs.fn(async () => {});
  getStatus = () => ({ phase: this.ready ? "ready" : "starting_rome" }) as RuntimeStatus;
  isReady = () => this.ready;
  getDashboardUrl = () => "http://127.0.0.1:47823";
  isServing = async () => this.ready;
  stopForQuit = async () => {};
  upgradeRuntime = async () => {};
  openInstallPage = async () => {};
  startRuntimeApp = async () => {};
  openRuntimeFolder = async () => {};
  openLogs = async () => {};
}

function controller(
  saved: RuntimeTarget,
  options: {
    remoteReady?: boolean;
    signedIn?: boolean;
    listInstances?: () => Promise<CloudInstance[]>;
  } = {},
) {
  const writes: RuntimeTarget[] = [];
  const relaunch = rs.fn();
  const local = new FakeRuntime();
  const signOut = rs.fn(async () => {});
  const account = { signOut } as unknown as CloudAccount;
  const created: RemoteRuntime[] = [];
  const subject = new RuntimeController({
    cloudAccount: account,
    savedTarget: saved,
    writeTarget: (target) => writes.push(target),
    createLocal: () => local as unknown as Runtime,
    createRemote: (instance, onSelect) => {
      const remote = new RemoteRuntime(instance, {
        account: {
          isSignedIn: async () => options.signedIn ?? false,
          listInstances: options.listInstances ?? (async () => []),
          openSession: async () => {},
        },
        fetchImpl: fetch,
        openLogs: async () => {},
        openCloud: async () => {},
        onSelect,
      });
      if (options.remoteReady) rs.spyOn(remote, "isReady").mockReturnValue(true);
      created.push(remote);
      return remote;
    },
    relaunch,
  });
  return { subject, writes, relaunch, local, signOut, created };
}

const welcome: RuntimeTarget = { kind: "remote", instance: null };

describe("RuntimeController", () => {
  it("switches from the welcome screen to the VM without a relaunch", () => {
    const { subject, writes, relaunch, local } = controller(welcome);
    expect(subject.setTarget({ kind: "local" })).toBe("switched");
    expect(writes).toEqual([{ kind: "local" }]);
    expect(relaunch).not.toHaveBeenCalled();
    expect(subject.runtime.inner).toBe(local);
    expect(local.ensureReady).toHaveBeenCalled();
    expect(subject.activeTarget()).toEqual({ kind: "local" });
  });

  it("relaunches to leave the VM", () => {
    const { subject, relaunch, local } = controller({ kind: "local" });
    expect(subject.setTarget(welcome)).toBe("relaunching");
    expect(relaunch).toHaveBeenCalled();
    expect(subject.runtime.inner).toBe(local);
  });

  it("relaunches to leave an open hosted Rome", () => {
    const { subject, relaunch } = controller(
      { kind: "remote", instance: { id: "i", name: "ray", origin: "https://ray.romeos.cc" } },
      { remoteReady: true },
    );
    expect(subject.setTarget({ kind: "local" })).toBe("relaunching");
    expect(relaunch).toHaveBeenCalled();
  });

  it("returns to the welcome screen on sign-out, never to the VM", async () => {
    const { subject, writes, signOut, created } = controller(welcome);
    await subject.signOut();
    expect(signOut).toHaveBeenCalled();
    expect(writes).toEqual([welcome]);
    expect(subject.runtime.inner).toBe(created[1]);
  });

  it("leaves a VM target alone on sign-out", async () => {
    const { subject, writes } = controller({ kind: "local" });
    await subject.signOut();
    expect(writes).toEqual([]);
  });

  it("keeps the VM when a replaced Rome Cloud lookup answers late", async () => {
    let answer: (instances: CloudInstance[]) => void = () => {};
    const { subject, writes } = controller(welcome, {
      signedIn: true,
      listInstances: () => new Promise((resolve) => (answer = resolve)),
    });
    const connecting = subject.runtime.ensureReady();
    await new Promise((resolve) => setImmediate(resolve));
    expect(subject.setTarget({ kind: "local" })).toBe("switched");
    answer([
      { id: "i", name: "ray", slug: "ray", origin: "https://ray.romeos.cc", status: "running" },
    ]);
    await connecting;
    expect(writes).toEqual([{ kind: "local" }]);
    expect(subject.activeTarget()).toEqual({ kind: "local" });
  });
});
