import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { context, propagation, trace } from "@opentelemetry/api";
import { isTracingSuppressed } from "@opentelemetry/core";
import { node as nodeTracing } from "@opentelemetry/sdk-node";

const spawnMock = rs.fn();

rs.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

class MockChildProcess extends EventEmitter {
  pid: number;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(_signal?: NodeJS.Signals): boolean {
    queueMicrotask(() => {
      this.emit("exit", 0, null);
    });
    return true;
  }
}

describe("HealthCheckDaemon", () => {
  const originalFetch = globalThis.fetch;
  const originalDockerAppCodeMode = process.env.ROME_DOCKER_APP_CODE_MODE;

  beforeEach(() => {
    rs.clearAllMocks();
    process.env.ROME_DOCKER_APP_CODE_MODE = "source";
    let nextPid = 100;
    spawnMock.mockImplementation(() => new MockChildProcess(nextPid++));
  });

  afterEach(() => {
    if (originalDockerAppCodeMode === undefined) {
      delete process.env.ROME_DOCKER_APP_CODE_MODE;
    } else {
      process.env.ROME_DOCKER_APP_CODE_MODE = originalDockerAppCodeMode;
    }
    rs.restoreAllMocks();
  });

  it("restarts rome and resumes the session after the new process becomes healthy", async () => {
    const fetchMock = rs.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.endsWith("/api/health")) {
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.endsWith("/api/chat/send")) {
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe(
          JSON.stringify({
            threadId: "sess-1",
            text: "Rome reloaded.",
          }),
        );
        return new Response("", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }

      return originalFetch(input, init);
    });
    rs.stubGlobal("fetch", fetchMock);

    const { HealthCheckDaemon } = await import("./index.js");
    const { HostFilesystemManager } = await import("./host-filesystem.js");
    rs.spyOn(HostFilesystemManager.prototype, "restore").mockResolvedValue(undefined);

    const daemon = new HealthCheckDaemon({
      appDir: "/tmp/rome",
      healthCheckIntervalMs: 60_000,
      healthRetryDelayMs: 100,
      healthTimeoutMs: 1_000,
      actionHost: "127.0.0.1",
      actionPort: 0,
      romePort: 4141,
    });

    await daemon.start();

    try {
      const result = await (
        daemon as never as {
          enqueueAction: (request: { action: "restart_rome"; threadId: string }) => Promise<{
            ok: boolean;
            action: string;
          }>;
        }
      ).enqueueAction({ action: "restart_rome", threadId: "sess-1" });

      expect(result.ok).toBe(true);
      expect(result.action).toBe("restart_rome");
      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(spawnMock).toHaveBeenNthCalledWith(
        1,
        "node",
        ["--import", "tsx", "packages/core/src/index.ts"],
        expect.objectContaining({
          cwd: "/tmp/rome",
        }),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:4141/api/chat/send",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            threadId: "sess-1",
            text: "Rome reloaded.",
          }),
        }),
      );
    } finally {
      await daemon.stop();
    }
  });

  it("starts the compiled core entrypoint when compiled Docker mode is enabled", async () => {
    process.env.ROME_DOCKER_APP_CODE_MODE = "compiled";
    rs.stubGlobal(
      "fetch",
      rs.fn(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })),
    );

    const { HealthCheckDaemon } = await import("./index.js");
    const { HostFilesystemManager } = await import("./host-filesystem.js");
    rs.spyOn(HostFilesystemManager.prototype, "restore").mockResolvedValue(undefined);

    const daemon = new HealthCheckDaemon({
      appDir: "/tmp/rome",
      healthCheckIntervalMs: 60_000,
      healthRetryDelayMs: 100,
      healthTimeoutMs: 1_000,
      actionHost: "127.0.0.1",
      actionPort: 0,
      romePort: 4141,
    });

    await daemon.start();

    try {
      expect(spawnMock).toHaveBeenCalledWith(
        "node",
        ["packages/core/dist/index.js"],
        expect.objectContaining({
          cwd: "/tmp/rome",
        }),
      );
    } finally {
      await daemon.stop();
    }
  });

  describe("health probe tracing", () => {
    // Registers a real context manager, so a suppressed context survives the
    // awaits between the caller and fetch.
    const provider = new nodeTracing.NodeTracerProvider();

    beforeAll(() => {
      provider.register();
    });

    afterAll(async () => {
      context.disable();
      propagation.disable();
      trace.disable();
      await provider.shutdown();
    });

    it("probes the starting server untraced and steady-state health traced", async () => {
      const probes: boolean[] = [];
      let refuseNext = true;
      rs.stubGlobal(
        "fetch",
        rs.fn(async () => {
          probes.push(isTracingSuppressed(context.active()));
          if (refuseNext) {
            refuseNext = false;
            throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:4141");
          }
          return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
        }),
      );

      const { HealthCheckDaemon } = await import("./index.js");
      const { HostFilesystemManager } = await import("./host-filesystem.js");
      rs.spyOn(HostFilesystemManager.prototype, "restore").mockResolvedValue(undefined);

      const daemon = new HealthCheckDaemon({
        appDir: "/tmp/rome",
        healthCheckIntervalMs: 60_000,
        healthRetryDelayMs: 100,
        healthTimeoutMs: 1_000,
        actionHost: "127.0.0.1",
        actionPort: 0,
        romePort: 4141,
      });

      await daemon.start();
      try {
        expect(probes).toEqual([true, true]);

        probes.length = 0;
        await (daemon as never as { runHealthChecks: () => Promise<void> }).runHealthChecks();
        expect(probes).toEqual([false]);
      } finally {
        await daemon.stop();
      }
    });
  });
});
