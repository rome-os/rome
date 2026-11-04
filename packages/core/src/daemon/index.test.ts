import { EventEmitter } from "node:events";
import { request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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

  describe("browser callers", () => {
    const RESTART_ACTION = { action: "restart_rome", threadId: "sess-1" };
    // Valid against the daemon's schema, so only the guard keeps it from `configure`.
    const HOST_FILESYSTEM_CONFIG = {
      enabled: true,
      connection: { host: "host.example", port: 22, username: "rome", privateKey: "key" },
      mounts: [{ name: "home", remotePath: "/home/rome", containerPath: "/mnt/home" }],
      remoteAccess: null,
    };

    // The file stubs global fetch, so requests to the daemon go through node:http.
    function send(
      port: number,
      method: string,
      path: string,
      headers: Record<string, string> = {},
      body: unknown = method === "GET" ? undefined : RESTART_ACTION,
    ): Promise<{ status: number; headers: IncomingHttpHeaders }> {
      return new Promise((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0, headers: res.headers });
        });
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
    }

    async function startDaemon() {
      rs.stubGlobal(
        "fetch",
        rs.fn(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })),
      );
      const { HealthCheckDaemon } = await import("./index.js");
      const { HostFilesystemManager } = await import("./host-filesystem.js");
      rs.spyOn(HostFilesystemManager.prototype, "restore").mockResolvedValue(undefined);
      const configure = rs.spyOn(HostFilesystemManager.prototype, "configure").mockResolvedValue({
        configured: true,
        enabled: true,
        connection: null,
        mounts: [],
        remoteAccess: null,
        lastAppliedAt: null,
        lastError: null,
      });
      const enqueueAction = rs
        .spyOn(
          HealthCheckDaemon.prototype as never as { enqueueAction: () => unknown },
          "enqueueAction",
        )
        .mockResolvedValue({ ok: true, action: "restart_rome" });
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
      const { port } = (daemon as never as { server: Server }).server.address() as AddressInfo;
      return { daemon, port, configure, enqueueAction };
    }

    it("refuses a mutation sent by a browser page", async () => {
      const { daemon, port, configure, enqueueAction } = await startDaemon();
      try {
        const restart = await send(port, "POST", "/actions", {
          "content-type": "text/plain;charset=UTF-8",
          origin: "https://evil.example",
        });
        expect(restart.status).toBe(403);
        expect(enqueueAction).not.toHaveBeenCalled();

        const configured = await send(
          port,
          "PUT",
          "/host-filesystem/config",
          { "sec-fetch-site": "cross-site" },
          HOST_FILESYSTEM_CONFIG,
        );
        expect(configured.status).toBe(403);
        expect(configure).not.toHaveBeenCalled();
      } finally {
        await daemon.stop();
      }
    });

    it("serves a caller that is not a browser", async () => {
      const { daemon, port, configure, enqueueAction } = await startDaemon();
      try {
        const restart = await send(port, "POST", "/actions", {
          "content-type": "application/json",
        });
        expect(restart.status).toBe(200);
        expect(enqueueAction).toHaveBeenCalledTimes(1);

        const configured = await send(
          port,
          "PUT",
          "/host-filesystem/config",
          { "content-type": "application/json" },
          HOST_FILESYSTEM_CONFIG,
        );
        expect(configured.status).toBe(200);
        expect(configure).toHaveBeenCalledTimes(1);
      } finally {
        await daemon.stop();
      }
    });

    it("does not let a page on another origin read its responses", async () => {
      const { daemon, port } = await startDaemon();
      try {
        const status = await send(port, "GET", "/status", { origin: "https://evil.example" });
        expect(status.status).toBe(200);
        expect(status.headers["access-control-allow-origin"]).toBeUndefined();
      } finally {
        await daemon.stop();
      }
    });
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
