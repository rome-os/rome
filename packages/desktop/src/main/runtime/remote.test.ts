import { afterEach, describe, expect, it, rs } from "@rstest/core";

rs.mock("../logger", () => ({
  createLogger: () => ({ error: rs.fn(), info: rs.fn(), warn: rs.fn() }),
}));

import { type CloudInstance, NativeAuthError } from "@rome-os/libs/native-auth";
import { RemoteRuntime } from "./remote";
import type { RemoteInstanceRef } from "./target";

const ref = { id: "instance-1", name: "ray", origin: "https://ray.romeos.cc" };
const running: CloudInstance = { ...ref, slug: "ray", status: "running" };
const other: CloudInstance = {
  id: "instance-2",
  name: "lab",
  slug: "lab",
  origin: "https://lab.romeos.cc",
  status: "running",
};

let live: RemoteRuntime[] = [];
afterEach(() => {
  for (const runtime of live) runtime.dispose();
  live = [];
});

function runtime(options: {
  saved?: RemoteInstanceRef | null;
  signedIn?: boolean;
  instances?: CloudInstance[] | Error;
  healthy?: boolean;
}) {
  const openSession = rs.fn(async () => {});
  const onSelect = rs.fn((_ref: RemoteInstanceRef) => {});
  const remote = new RemoteRuntime(options.saved === undefined ? ref : options.saved, {
    account: {
      isSignedIn: async () => options.signedIn ?? true,
      listInstances: async () => {
        const instances = options.instances ?? [running];
        if (instances instanceof Error) throw instances;
        return instances;
      },
      openSession,
    },
    fetchImpl: rs.fn(
      async () => new Response(null, { status: options.healthy === false ? 502 : 200 }),
    ),
    openLogs: async () => {},
    openCloud: async () => {},
    onSelect,
  });
  live.push(remote);
  return { remote, openSession, onSelect };
}

describe("RemoteRuntime", () => {
  it("asks a signed-out user to sign in", async () => {
    const { remote } = runtime({ saved: null, signedIn: false });
    await remote.ensureReady();
    expect(remote.getStatus()).toMatchObject({
      phase: "waiting_for_user",
      primaryAction: "sign_in",
    });
  });

  it("opens the only instance without asking and saves it", async () => {
    const { remote, openSession, onSelect } = runtime({ saved: null });
    await remote.ensureReady();
    expect(onSelect).toHaveBeenCalledWith(ref);
    expect(openSession).toHaveBeenCalledWith(running);
    expect(remote.isReady()).toBe(true);
    expect(remote.getDashboardUrl()).toBe("https://ray.romeos.cc");
  });

  it("asks which one when there are several and none is saved", async () => {
    const { remote, openSession } = runtime({ saved: null, instances: [running, other] });
    await remote.ensureReady();
    expect(remote.getStatus()).toMatchObject({ primaryAction: "choose_instance" });
    expect(openSession).not.toHaveBeenCalled();
    await remote.chooseInstance("instance-2");
    expect(openSession).toHaveBeenCalledWith(other);
    expect(remote.getDashboardUrl()).toBe("https://lab.romeos.cc");
  });

  it("keeps the saved one among several", async () => {
    const { remote, openSession } = runtime({ instances: [other, running] });
    await remote.ensureReady();
    expect(openSession).toHaveBeenCalledWith(running);
  });

  it("saves a new origin Rome Cloud reports for the same instance", async () => {
    const moved = { ...running, origin: "https://ray2.romeos.cc" };
    const { remote, onSelect } = runtime({ instances: [moved] });
    await remote.ensureReady();
    expect(onSelect).toHaveBeenCalledWith({ ...ref, origin: "https://ray2.romeos.cc" });
    expect(remote.getDashboardUrl()).toBe("https://ray2.romeos.cc");
  });

  it.each([
    ["there is no instance", [], "open_cloud", /don't have a Rome/],
    ["the instance is stopped", [{ ...running, status: "stopped" }], "open_cloud", /stopped/],
  ] as const)("waits on Rome Cloud when %s", async (_case, instances, action, title) => {
    const { remote } = runtime({ instances: [...instances] });
    await remote.ensureReady();
    expect(remote.getStatus()).toMatchObject({ phase: "waiting_for_user", primaryAction: action });
    expect(remote.getStatus().title).toMatch(title);
  });

  it("waits without asking while the instance is being set up", async () => {
    const { remote } = runtime({ instances: [{ ...running, status: "provisioning" }] });
    await remote.ensureReady();
    expect(remote.getStatus()).toMatchObject({ phase: "starting_rome", primaryAction: "none" });
  });

  it("goes back to sign-in when Rome Cloud rejects the credential", async () => {
    const { remote } = runtime({ instances: new NativeAuthError("cloud_unauthorized", "x") });
    await remote.ensureReady();
    expect(remote.getStatus()).toMatchObject({ primaryAction: "sign_in" });
  });

  it("offers a retry when the network or the instance is down", async () => {
    const offline = runtime({ instances: new NativeAuthError("network", "x") }).remote;
    await offline.ensureReady();
    expect(offline.getStatus()).toMatchObject({ phase: "failed", primaryAction: "retry" });

    const silent = runtime({ healthy: false }).remote;
    await silent.ensureReady();
    expect(silent.getStatus().title).toMatch(/Can't reach/);
  });

  it("commits nothing when Rome Cloud answers after the runtime was swapped out", async () => {
    let answer: (instances: CloudInstance[]) => void = () => {};
    const openSession = rs.fn(async () => {});
    const onSelect = rs.fn();
    const remote = new RemoteRuntime(null, {
      account: {
        isSignedIn: async () => true,
        listInstances: () => new Promise<CloudInstance[]>((resolve) => (answer = resolve)),
        openSession,
      },
      fetchImpl: rs.fn(async () => new Response(null, { status: 200 })),
      openLogs: async () => {},
      openCloud: async () => {},
      onSelect,
    });
    const statuses: string[] = [];
    remote.on("status", (status) => statuses.push(status.phase));
    const connecting = remote.ensureReady();
    await new Promise((resolve) => setImmediate(resolve));
    remote.dispose();
    answer([running]);
    await connecting;
    expect(onSelect).not.toHaveBeenCalled();
    expect(openSession).not.toHaveBeenCalled();
    expect(statuses).not.toContain("ready");
    expect(remote.isReady()).toBe(false);
  });

  it("shares one connect between concurrent callers", async () => {
    const { remote, openSession } = runtime({});
    await Promise.all([remote.ensureReady(), remote.ensureReady()]);
    expect(openSession).toHaveBeenCalledTimes(1);
  });
});
