import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";

const auth = rs.hoisted(() => ({ authorizeServer: rs.fn() }));
const daemon = rs.hoisted(() => ({
  startDaemon: rs.fn(),
  nodeConfigFromEnvironment: rs.fn(() => ({ directory: "/tmp/rome-node-test", port: 12345 })),
  readOptionalCallerCredential: rs.fn(),
}));
rs.mock("@rome-os/node-core/auth", () => auth);
rs.mock("@rome-os/node-core/client", () => daemon);

import { createNodeCallerProvisioner } from "./rome-node-provisioning.js";
import { setInstanceTokenInMemory } from "./instance-identity.js";

const originalEnv = { ...process.env };
const token = "romeinst_current";
let finish: (error: Error | null) => void;

beforeEach(() => {
  auth.authorizeServer.mockReset();
  daemon.startDaemon.mockReset();
  daemon.startDaemon.mockResolvedValue({ pid: 1234 });
  daemon.readOptionalCallerCredential.mockReset();
  daemon.readOptionalCallerCredential.mockResolvedValue(null);
  auth.authorizeServer.mockImplementation(
    () =>
      new Promise<void>((resolve, reject) => {
        finish = (error) => (error ? reject(error) : resolve());
      }),
  );
  process.env.PANTHEON_BASE_ORIGIN = "https://rome-cloud.example";
  process.env.ROME_INSTANCE_TOKEN = "romeinst_stale_env";
  delete process.env.PANTHEON_DOMAIN;
  setInstanceTokenInMemory(token);
});
afterEach(() => {
  process.env = { ...originalEnv };
  setInstanceTokenInMemory(null);
});

describe("Rome Node startup authorization", () => {
  it("passes the current token to the API without changing the environment and shares overlapping calls", async () => {
    const ensure = createNodeCallerProvisioner();
    const first = ensure();
    const second = ensure();
    await Promise.resolve();
    expect(auth.authorizeServer).toHaveBeenCalledTimes(1);
    const [origin, credential] = auth.authorizeServer.mock.calls[0];
    expect(origin).toBe("https://rome-cloud.example");
    expect(credential).toBe(token);
    expect(process.env.ROME_INSTANCE_TOKEN).toBe("romeinst_stale_env");
    expect(daemon.startDaemon).not.toHaveBeenCalled();
    finish(null);
    await Promise.all([first, second]);
    expect(daemon.startDaemon).toHaveBeenCalledTimes(1);
    expect(daemon.startDaemon).toHaveBeenCalledWith(auth.authorizeServer.mock.calls[0][2]);
  });

  it("does not start an unconfigured caller without an enrolled instance and Cloud origin", async () => {
    const ensure = createNodeCallerProvisioner();
    setInstanceTokenInMemory(null);
    await ensure();
    setInstanceTokenInMemory(token);
    delete process.env.PANTHEON_BASE_ORIGIN;
    await ensure();
    expect(auth.authorizeServer).not.toHaveBeenCalled();
    expect(daemon.startDaemon).not.toHaveBeenCalled();
  });

  it("starts a manually configured caller on boot without instance enrollment", async () => {
    setInstanceTokenInMemory(null);
    daemon.readOptionalCallerCredential.mockResolvedValue({
      cloudUrl: "https://rome-cloud.example",
      token: "romedev_existing",
    });
    const ensure = createNodeCallerProvisioner();
    await ensure();
    expect(auth.authorizeServer).not.toHaveBeenCalled();
    expect(daemon.startDaemon).toHaveBeenCalledTimes(1);
  });

  it("does not reject or retry authorization failures and can run again on the next lifecycle trigger", async () => {
    const ensure = createNodeCallerProvisioner();
    const first = ensure();
    await Promise.resolve();
    finish(new Error("Authorization failed"));
    await expect(first).resolves.toBeUndefined();
    expect(auth.authorizeServer).toHaveBeenCalledTimes(1);
    expect(daemon.startDaemon).not.toHaveBeenCalled();
    const next = ensure();
    await Promise.resolve();
    expect(auth.authorizeServer).toHaveBeenCalledTimes(2);
    finish(null);
    await next;
    expect(daemon.startDaemon).toHaveBeenCalledTimes(1);
  });

  it("does not block boot if the daemon fails to start and can retry on the next trigger", async () => {
    daemon.startDaemon.mockRejectedValueOnce(new Error("Port in use"));
    const ensure = createNodeCallerProvisioner();
    const first = ensure();
    await Promise.resolve();
    finish(null);
    await expect(first).resolves.toBeUndefined();
    expect(daemon.startDaemon).toHaveBeenCalledTimes(1);

    const next = ensure();
    await Promise.resolve();
    finish(null);
    await next;
    expect(daemon.startDaemon).toHaveBeenCalledTimes(2);
  });
});
