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
  getDashboardUrl = () => "http://127.0.0.1:4141";
  isServing = async () => this.ready;
  openCloud = async () => {};
  openLogs = async () => {};
  reportLoadFailure = () => {};
}

function controller(
  saved: RuntimeTarget,
  options: {
    remoteReady?: boolean;
    signedIn?: boolean;
    listInstances?: () => Promise<CloudInstance[]>;
    override?: Runtime;
  } = {},
) {
  const writes: RuntimeTarget[] = [];
  const relaunch = rs.fn();
  const signOut = rs.fn(async () => {});
  const account = { signOut } as unknown as CloudAccount;
  const created: RemoteRuntime[] = [];
  const subject = new RuntimeController({
    cloudAccount: account,
    savedTarget: saved,
    writeTarget: (target) => writes.push(target),
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
    override: options.override,
  });
  return { subject, writes, relaunch, signOut, created };
}

const welcome: RuntimeTarget = { kind: "remote", instance: null };
const ray: RuntimeTarget = {
  kind: "remote",
  instance: { id: "i", name: "ray", origin: "https://ray.romeos.cc" },
};
const other: RuntimeTarget = {
  kind: "remote",
  instance: { id: "j", name: "work", origin: "https://work.romeos.cc" },
};

describe("RuntimeController", () => {
  it("opens the saved hosted Rome", () => {
    const { subject, created } = controller(ray);
    expect(created).toHaveLength(1);
    expect(subject.runtime.inner).toBe(created[0]);
    expect(subject.activeTarget()).toEqual(ray);
  });

  it("switches from the welcome screen to another Rome without a relaunch", () => {
    const { subject, writes, relaunch, created } = controller(welcome);
    expect(subject.setTarget(ray)).toBe("switched");
    expect(writes).toEqual([ray]);
    expect(relaunch).not.toHaveBeenCalled();
    expect(subject.runtime.inner).toBe(created[1]);
    expect(subject.activeTarget()).toEqual(ray);
  });

  it("relaunches to leave an open hosted Rome", () => {
    const { subject, relaunch, created } = controller(ray, { remoteReady: true });
    expect(subject.setTarget(other)).toBe("relaunching");
    expect(relaunch).toHaveBeenCalled();
    expect(subject.runtime.inner).toBe(created[0]);
  });

  it("returns to the welcome screen on sign-out", async () => {
    const { subject, writes, signOut, created } = controller(welcome);
    await subject.signOut();
    expect(signOut).toHaveBeenCalled();
    expect(writes).toEqual([welcome]);
    expect(subject.runtime.inner).toBe(created[1]);
  });

  it("does not save a pick from a Rome the user already switched away from", async () => {
    let answer: (instances: CloudInstance[]) => void = () => {};
    const { subject, writes } = controller(welcome, {
      signedIn: true,
      listInstances: () => new Promise((resolve) => (answer = resolve)),
    });
    const connecting = subject.runtime.ensureReady();
    await new Promise((resolve) => setImmediate(resolve));
    expect(subject.setTarget(other)).toBe("switched");
    answer([
      { id: "i", name: "ray", slug: "ray", origin: "https://ray.romeos.cc", status: "running" },
    ]);
    await connecting;
    expect(writes).toEqual([other]);
    expect(subject.activeTarget()).toEqual(other);
  });

  it("opens an override instead of the saved target, and saves a pick for the next launch", () => {
    const override = new FakeRuntime();
    override.ready = true;
    const { subject, writes, relaunch, created } = controller(ray, {
      override: override as unknown as Runtime,
    });
    expect(subject.runtime.inner).toBe(override);
    expect(created).toEqual([]);

    expect(subject.setTarget(other)).toBe("relaunching");
    expect(writes).toEqual([other]);
    expect(relaunch).toHaveBeenCalled();
    expect(subject.runtime.inner).toBe(override);
  });
});
