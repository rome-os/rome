import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { context, propagation, trace } from "@opentelemetry/api";
import { isTracingSuppressed } from "@opentelemetry/core";
import { node as nodeTracing } from "@opentelemetry/sdk-node";

const auth = rs.hoisted(() => ({ authorizeServer: rs.fn(), configureSignerCaller: rs.fn() }));
const daemon = rs.hoisted(() => ({
  startDaemon: rs.fn(),
  nodeConfigFromEnvironment: rs.fn(() => ({ directory: "/tmp/rome-node-test", port: 12345 })),
  readOptionalCallerCredential: rs.fn(),
}));
rs.mock("@rome-os/node-core/auth", () => auth);
rs.mock("@rome-os/node-core/client", () => daemon);

import { createNodeCallerProvisioner } from "./rome-node-provisioning.js";
import { createNodeDevicesService } from "./node-devices.js";
import { hydrateInstanceToken, setInstanceTokenInMemory } from "./instance-identity.js";

const originalEnv = { ...process.env };
const token = "romeinst_current";
let finish: (error: Error | null) => void;
// The provisioner awaits the Rome Cloud bearer before it calls authorizeServer.
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  auth.authorizeServer.mockReset();
  auth.configureSignerCaller.mockReset();
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
    await flush();
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
    await flush();
    finish(new Error("Authorization failed"));
    await expect(first).resolves.toBeUndefined();
    expect(auth.authorizeServer).toHaveBeenCalledTimes(1);
    expect(daemon.startDaemon).not.toHaveBeenCalled();
    const next = ensure();
    await flush();
    expect(auth.authorizeServer).toHaveBeenCalledTimes(2);
    finish(null);
    await next;
    expect(daemon.startDaemon).toHaveBeenCalledTimes(1);
  });

  it("does not block boot if the daemon fails to start and can retry on the next trigger", async () => {
    daemon.startDaemon.mockRejectedValueOnce(new Error("Port in use"));
    const ensure = createNodeCallerProvisioner();
    const first = ensure();
    await flush();
    finish(null);
    await expect(first).resolves.toBeUndefined();
    expect(daemon.startDaemon).toHaveBeenCalledTimes(1);

    const next = ensure();
    await flush();
    finish(null);
    await next;
    expect(daemon.startDaemon).toHaveBeenCalledTimes(2);
  });
});

describe("Rome Node caller in signer mode", () => {
  const SOCKET = "/run/rome-signer/signer.sock";
  const store = (initial: Record<string, unknown>) => ({
    get: async <T>(key: string) => (initial[key] as T) ?? null,
    set: async () => {},
    delete: async () => {},
  });

  beforeEach(() => {
    process.env.ROME_SIGNER_SOCKET = SOCKET;
  });
  afterEach(() => hydrateInstanceToken(store({})));

  it("points the caller at the signer without exchanging the instance token", async () => {
    await hydrateInstanceToken(store({ instanceKeyId: "jkt-1" }));
    await createNodeCallerProvisioner()();
    expect(auth.authorizeServer).not.toHaveBeenCalled();
    expect(auth.configureSignerCaller).toHaveBeenCalledWith(
      "https://rome-cloud.example",
      SOCKET,
      expect.anything(),
    );
    expect(daemon.startDaemon).toHaveBeenCalledTimes(1);
  });

  it("waits until Rome Cloud holds the signer key", async () => {
    await hydrateInstanceToken(store({}));
    await createNodeCallerProvisioner()();
    expect(auth.configureSignerCaller).not.toHaveBeenCalled();
    expect(daemon.startDaemon).not.toHaveBeenCalled();
  });
});

describe("Rome Node caller daemon tracing", () => {
  // Registers a real context manager, so a suppressed context survives the
  // awaits between the caller and startDaemon.
  const provider = new nodeTracing.NodeTracerProvider();
  let startSuppressed: boolean[];
  let authorizeSuppressed: boolean[];

  beforeAll(() => {
    provider.register();
  });

  afterAll(async () => {
    context.disable();
    propagation.disable();
    trace.disable();
    await provider.shutdown();
  });

  beforeEach(() => {
    startSuppressed = [];
    authorizeSuppressed = [];
    daemon.startDaemon.mockImplementation(async () => {
      startSuppressed.push(isTracingSuppressed(context.active()));
      return { pid: 1234 };
    });
    auth.authorizeServer.mockImplementation(async () => {
      authorizeSuppressed.push(isTracingSuppressed(context.active()));
    });
  });

  it("starts the caller daemon untraced at boot and keeps Rome Cloud authorization traced", async () => {
    await createNodeCallerProvisioner()();
    expect(authorizeSuppressed).toEqual([false]);
    expect(startSuppressed).toEqual([true]);
  });

  it("starts the caller daemon untraced from the devices service", async () => {
    await createNodeDevicesService().start();
    expect(startSuppressed).toEqual([true]);
  });
});
