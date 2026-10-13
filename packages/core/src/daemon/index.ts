import { spawn, type ChildProcess } from "node:child_process";
import { Mutex } from "async-mutex";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createLogger } from "../logger.js";
import {
  initTelemetry,
  shutdown as shutdownTelemetry,
  withTracingSuppressed,
} from "../telemetry.js";
import {
  parseDaemonActionRequest,
  type DaemonActionRequest,
  type DaemonActionResult,
  type DaemonStatusPayload,
  type ManagedServiceName,
  type ManagedServiceSnapshot,
  type ManagedServiceState,
} from "./actions.js";
import { HostFilesystemManager } from "./host-filesystem.js";

const log = createLogger("daemon");

// Bound on `shutdownTelemetry()` so a degraded OTLP collector (e.g. `rome-obs`
// restarting) doesn't hold the daemon open past its BatchLogRecordProcessor
// flush timeout during shutdown. Mirrors the worker's bound in
// `actions/worker.ts`.
const SHUTDOWN_FLUSH_TIMEOUT_MS = 5_000;

async function flushTelemetry(): Promise<void> {
  await Promise.race([
    shutdownTelemetry(),
    new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_FLUSH_TIMEOUT_MS)),
  ]);
}

interface ServiceCommand {
  command: string;
  args: string[];
  cwd: string;
  healthUrl: string;
  startTimeoutMs: number;
}

interface DaemonConfig {
  appDir: string;
  healthCheckIntervalMs: number;
  healthRetryDelayMs: number;
  healthTimeoutMs: number;
  actionHost: string;
  actionPort: number;
  romePort: number;
}

type ServiceMap = Record<ManagedServiceName, ManagedServiceRunner>;

interface AgentCapabilityInfo {
  status: "running" | "degraded";
  base_url: string;
  health_url: string;
  last_health_check: string | null;
}

interface CdpServerInfo {
  name: string;
  port: number;
  status: "running";
}

interface CapabilityManifest {
  name: string;
  version: string;
  hostname: string;
  tailscale_ip: string | null;
  capabilities: {
    agent: AgentCapabilityInfo;
    cdp_servers: CdpServerInfo[];
    mcp_servers: [];
  };
  uptime_seconds: number;
}

const dockerAppCodeModeSchema = z.enum(["source", "compiled"]).catch("source");
const ROME_START_TIMEOUT_MS = 300_000;

const hostFilesystemConfigSchema = z.object({
  enabled: z.boolean(),
  connection: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    username: z.string().min(1),
    privateKey: z.string(),
  }),
  mounts: z.array(
    z.object({
      name: z.string().min(1),
      remotePath: z.string().min(1),
      containerPath: z.string().min(1),
      aliases: z
        .array(
          z.object({
            containerPath: z.string().min(1),
            relativePath: z.string().min(1),
          }),
        )
        .optional(),
    }),
  ),
  remoteAccess: z
    .object({
      username: z.string().min(1),
      port: z.number().int().min(1).max(65535),
      sshPublicKey: z.string().min(1),
    })
    .nullable(),
});

function getDockerAppCodeMode(): "source" | "compiled" {
  return dockerAppCodeModeSchema.parse(process.env.ROME_DOCKER_APP_CODE_MODE);
}

function getRomeServiceArgs(): string[] {
  if (getDockerAppCodeMode() === "compiled") {
    return ["packages/core/dist/index.js"];
  }

  return ["--import", "tsx", "packages/core/src/index.ts"];
}

function stripIpv6Brackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

function formatUrlHost(host: string): string {
  const normalizedHost = stripIpv6Brackets(host);
  if (normalizedHost.includes(":")) {
    return `[${normalizedHost}]`;
  }
  return normalizedHost;
}

function getChromeCdpProbeHosts(bindAddress: string | undefined): string[] {
  const configuredBindAddress = stripIpv6Brackets(bindAddress?.trim() ?? "");
  const hosts = new Set<string>();

  const addHost = (host: string): void => {
    const normalizedHost = stripIpv6Brackets(host.trim());
    if (normalizedHost.length > 0) {
      hosts.add(normalizedHost);
    }
  };

  switch (configuredBindAddress) {
    case "":
    case "0.0.0.0":
      addHost("127.0.0.1");
      addHost("localhost");
      break;
    case "::":
      addHost("::1");
      addHost("localhost");
      break;
    default:
      addHost(configuredBindAddress);
      if (configuredBindAddress === "localhost") {
        addHost("127.0.0.1");
        addHost("::1");
      }
      break;
  }

  return [...hosts];
}

class ManagedServiceRunner {
  private child: ChildProcess | null = null;
  private expectedExit = false;
  private state: ManagedServiceState = "stopped";
  private restartCount = 0;
  private lastStartedAt: string | null = null;
  private lastExitedAt: string | null = null;
  private lastExitCode: number | null = null;
  private lastExitSignal: NodeJS.Signals | null = null;
  private lastHealthCheckAt: string | null = null;
  private lastHealthyAt: string | null = null;
  private lastUnhealthyAt: string | null = null;
  private lastRestartAt: string | null = null;

  constructor(
    readonly name: ManagedServiceName,
    private readonly command: ServiceCommand,
    private readonly healthTimeoutMs: number,
    private readonly onUnexpectedExit: (service: ManagedServiceName) => void,
  ) {}

  getSnapshot(): ManagedServiceSnapshot {
    return {
      name: this.name,
      state: this.state,
      pid: this.child?.pid ?? null,
      restartCount: this.restartCount,
      lastStartedAt: this.lastStartedAt,
      lastExitedAt: this.lastExitedAt,
      lastExitCode: this.lastExitCode,
      lastExitSignal: this.lastExitSignal,
      lastHealthCheckAt: this.lastHealthCheckAt,
      lastHealthyAt: this.lastHealthyAt,
      lastUnhealthyAt: this.lastUnhealthyAt,
      lastRestartAt: this.lastRestartAt,
    };
  }

  async start(reason: string): Promise<void> {
    if (this.child) {
      return;
    }

    this.expectedExit = false;
    this.state = this.state === "restarting" ? "restarting" : "starting";
    log.info("starting service", { service: this.name, reason });

    const child = spawn(this.command.command, this.command.args, {
      cwd: this.command.cwd,
      stdio: "inherit",
      env: process.env,
    });

    this.child = child;
    this.lastStartedAt = new Date().toISOString();

    child.once("exit", (code, signal) => {
      const wasExpected = this.expectedExit;
      this.child = null;
      this.lastExitedAt = new Date().toISOString();
      this.lastExitCode = typeof code === "number" ? code : null;
      this.lastExitSignal = signal ?? null;
      this.state = "stopped";
      const exitFields = {
        service: this.name,
        exitCode: code ?? null,
        exitSignal: signal ?? null,
        expected: wasExpected,
      };
      if (wasExpected) {
        log.info("service exited", exitFields);
      } else {
        log.warn("service exited unexpectedly", exitFields);
      }
      if (!wasExpected) {
        this.onUnexpectedExit(this.name);
      }
    });

    try {
      await this.waitUntilHealthy();
      this.state = "running";
      log.info("service is healthy", { service: this.name });
    } catch (error) {
      this.state = "unhealthy";
      await this.stop(`${reason}:startup_failed`);
      throw error;
    }
  }

  async stop(reason: string): Promise<void> {
    if (!this.child) {
      this.state = "stopped";
      return;
    }

    const child = this.child;
    this.expectedExit = true;
    this.state = "stopped";
    log.info("stopping service", { service: this.name, reason });
    child.kill("SIGTERM");

    const exited = await this.waitForExit(10_000);
    if (!exited && this.child) {
      log.warn("service did not exit cleanly, sending SIGKILL", { service: this.name });
      this.child.kill("SIGKILL");
      await this.waitForExit(5_000);
    }
  }

  async restart(reason: string): Promise<void> {
    this.restartCount += 1;
    this.lastRestartAt = new Date().toISOString();
    this.state = "restarting";
    await this.stop(reason);
    await this.start(reason);
  }

  async markBuilding<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.state;
    this.state = "building";
    try {
      return await operation();
    } finally {
      if (!this.child && this.state === "building") {
        this.state = "stopped";
      } else if (this.state === "building") {
        this.state = previous === "unhealthy" ? "unhealthy" : "running";
      }
    }
  }

  async probeHealth(): Promise<boolean> {
    this.lastHealthCheckAt = new Date().toISOString();
    try {
      const response = await fetch(this.command.healthUrl, {
        signal: AbortSignal.timeout(this.healthTimeoutMs),
      });
      if (!response.ok) {
        this.lastUnhealthyAt = new Date().toISOString();
        this.state = "unhealthy";
        return false;
      }
      this.lastHealthyAt = new Date().toISOString();
      if (this.child) {
        this.state = "running";
      }
      return true;
    } catch {
      this.lastUnhealthyAt = new Date().toISOString();
      this.state = "unhealthy";
      return false;
    }
  }

  private async waitUntilHealthy(): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < this.command.startTimeoutMs) {
      if (!this.child) {
        throw new Error(`${this.name} exited before becoming healthy`);
      }
      // Refused probes are expected until the child listens, and the timeout
      // below reports a real failure, so they stay out of the Error spans.
      // runHealthChecks calls probeHealth traced: a refusal there is an outage.
      if (await withTracingSuppressed(() => this.probeHealth())) {
        return;
      }
      await delay(2_000);
    }
    throw new Error(`${this.name} did not become healthy within ${this.command.startTimeoutMs}ms`);
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (!this.child) {
        return true;
      }
      await delay(100);
    }
    return !this.child;
  }
}

export class HealthCheckDaemon {
  private readonly services: ServiceMap;
  private readonly hostFilesystem = new HostFilesystemManager();
  private server: Server | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private activeActionCount = 0;
  private healthCheckPending = false;
  private readonly operationMutex = new Mutex();
  private startedAt = Date.now();

  constructor(private readonly config: DaemonConfig) {
    this.services = {
      rome: new ManagedServiceRunner(
        "rome",
        {
          command: "node",
          args: getRomeServiceArgs(),
          cwd: this.config.appDir,
          healthUrl: `http://127.0.0.1:${this.config.romePort}/api/health`,
          startTimeoutMs: ROME_START_TIMEOUT_MS,
        },
        this.config.healthTimeoutMs,
        (service) => {
          void this.scheduleUnexpectedExitRecovery(service);
        },
      ),
    };
  }

  async start(): Promise<void> {
    this.startedAt = Date.now();
    await this.startHttpServer();
    await this.services.rome.start("startup");
    try {
      await this.hostFilesystem.restore();
    } catch (error) {
      log.error("failed to restore host filesystem mounts", { error });
    }

    this.intervalHandle = setInterval(() => {
      if (this.healthCheckPending) return;
      this.healthCheckPending = true;
      void this.operationMutex.runExclusive(async () => {
        try {
          await this.runHealthChecks();
        } finally {
          this.healthCheckPending = false;
        }
      });
    }, this.config.healthCheckIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    await this.operationMutex.runExclusive(async () => {
      await this.services.rome.stop("daemon_shutdown");
    });

    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server?.close((error) => (error ? reject(error) : resolve()));
      });
      this.server = null;
    }
  }

  private async startHttpServer(): Promise<void> {
    this.server = createServer(async (req, res) => {
      try {
        await this.routeRequest(req, res);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error("request failed", { error });
        this.writeJson(res, 500, { error: message });
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.config.actionPort, this.config.actionHost, () => resolve());
    });

    log.info("listening", {
      url: `http://${this.config.actionHost}:${this.config.actionPort}`,
    });
  }

  private async routeRequest(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

    if (req.method === "GET" && url.pathname === "/") {
      this.writeJson(res, 200, await this.getCapabilityManifest(url.hostname));
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      const status = this.getStatusPayload();
      this.writeJson(res, status.status === "ok" ? 200 : 503, { status: status.status });
      return;
    }

    if (req.method === "GET" && url.pathname === "/status") {
      this.writeJson(res, 200, this.getStatusPayload());
      return;
    }

    if (req.method === "GET" && url.pathname === "/host-filesystem/status") {
      this.writeJson(res, 200, await this.hostFilesystem.getStatus());
      return;
    }

    if (req.method === "PUT" && url.pathname === "/host-filesystem/config") {
      const body = await this.readJsonBody<unknown>(req);
      const parsed = hostFilesystemConfigSchema.safeParse(body);
      if (!parsed.success) {
        this.writeJson(res, 400, { error: "Invalid host filesystem config" });
        return;
      }
      const payload = parsed.data;
      const result = await this.hostFilesystem.configure(payload);
      this.writeJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/actions") {
      const body = await this.readJsonBody<unknown>(req);
      const actionRequest = parseDaemonActionRequest(body);
      if (!actionRequest) {
        this.writeJson(res, 400, { error: "Unsupported daemon action" });
        return;
      }

      const result = await this.enqueueAction(actionRequest);
      this.writeJson(res, result.ok ? 200 : 500, result);
      return;
    }

    this.writeJson(res, 404, { error: "Not found" });
  }

  private getStatusPayload(): DaemonStatusPayload {
    const services = {
      rome: this.services.rome.getSnapshot(),
    };

    const allHealthy = Object.values(services).every((service) => service.state === "running");
    return {
      status: allHealthy ? "ok" : "degraded",
      intervalMs: this.config.healthCheckIntervalMs,
      actionInProgress: this.activeActionCount > 0,
      updatedAt: new Date().toISOString(),
      services,
    };
  }

  private async getCapabilityManifest(requestHost: string): Promise<CapabilityManifest> {
    const status = this.getStatusPayload();
    const advertisedIp = await this.resolveAdvertisedIp(requestHost);
    const romeOrigin = this.getOrigin(advertisedIp, this.config.romePort);
    const cdpServers = await this.getCdpServers();

    return {
      name: "rome-daemon",
      version: process.env.npm_package_version ?? "0.1.0",
      hostname: hostname(),
      tailscale_ip: advertisedIp,
      capabilities: {
        agent: {
          status: status.status === "ok" ? "running" : "degraded",
          base_url: romeOrigin,
          health_url: `${romeOrigin}/api/health`,
          last_health_check: status.services.rome.lastHealthCheckAt,
        },
        cdp_servers: cdpServers,
        mcp_servers: [],
      },
      uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  private async getCdpServers(): Promise<CdpServerInfo[]> {
    if (process.env.ROME_ENABLE_CHROME === "0") {
      return [];
    }

    const port = Number.parseInt(process.env.ROME_CHROME_CDP_PORT ?? "9222", 10);
    if (!Number.isFinite(port)) {
      return [];
    }

    for (const host of getChromeCdpProbeHosts(process.env.ROME_CHROME_BIND_ADDRESS)) {
      try {
        const response = await fetch(`http://${formatUrlHost(host)}:${port}/json/version`, {
          signal: AbortSignal.timeout(1_500),
        });
        if (!response.ok) {
          continue;
        }

        return [
          {
            name: process.env.ROME_CHROME_NAME ?? "Chrome",
            port,
            status: "running",
          },
        ];
      } catch {
        continue;
      }
    }

    return [];
  }

  private getOrigin(host: string | null, port: number): string {
    const resolvedHost = host ?? "127.0.0.1";
    if (port === 80) {
      return `http://${formatUrlHost(resolvedHost)}`;
    }
    if (port === 443) {
      return `https://${formatUrlHost(resolvedHost)}`;
    }
    return `http://${formatUrlHost(resolvedHost)}:${port}`;
  }

  private async resolveAdvertisedIp(requestHost: string): Promise<string | null> {
    try {
      const { stdout } = await this.execFile("tailscale", ["status", "--json"]);
      const parsed = JSON.parse(stdout) as {
        Self?: {
          TailscaleIPs?: string[];
        };
      };
      const ip = parsed.Self?.TailscaleIPs?.[0];
      if (typeof ip === "string" && ip.length > 0) {
        return ip;
      }
    } catch {
      // Fall back to the address the caller used when it looks routable.
    }

    if (!this.isLocalHost(requestHost)) {
      return requestHost;
    }

    return null;
  }

  private isLocalHost(host: string): boolean {
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  }

  private async execFile(
    command: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: this.config.appDir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(
          new Error(`${command} exited with code=${code ?? "null"} signal=${signal ?? "null"}`),
        );
      });
    });
  }

  private async enqueueAction(actionRequest: DaemonActionRequest): Promise<DaemonActionResult> {
    const startedAt = new Date().toISOString();
    this.activeActionCount += 1;
    try {
      await this.operationMutex.runExclusive(async () => {
        await this.executeAction(actionRequest);
      });
      return {
        ok: true,
        action: actionRequest.action,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: this.getStatusPayload().status,
        services: this.getStatusPayload().services,
      };
    } catch (error) {
      return {
        ok: false,
        action: actionRequest.action,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: this.getStatusPayload().status,
        services: this.getStatusPayload().services,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.activeActionCount -= 1;
    }
  }

  private async executeAction(actionRequest: DaemonActionRequest): Promise<void> {
    switch (actionRequest.action) {
      case "restart_rome":
        await this.restartRome(actionRequest.threadId);
        return;
    }
  }

  private async restartRome(threadId: string): Promise<void> {
    await this.services.rome.restart("restart_rome");
    await this.sendRomeReloadedMessage(threadId);
  }

  private async sendRomeReloadedMessage(threadId: string): Promise<void> {
    const response = await fetch(`${this.getRomeOrigin()}/api/chat/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId,
        text: "Rome reloaded.",
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const contentType = response.headers.get("content-type") ?? "";
    if (response.ok && contentType.includes("text/event-stream")) {
      await response.body?.cancel();
      return;
    }

    const errorText = await response.text().catch(() => "");
    let message = `Rome returned status ${response.status}`;
    if (errorText) {
      try {
        const parsed = JSON.parse(errorText) as Record<string, unknown>;
        if (typeof parsed.error === "string" && parsed.error.length > 0) {
          message = parsed.error;
        } else {
          message = errorText;
        }
      } catch {
        message = errorText;
      }
    }

    throw new Error(`Failed to resume thread ${threadId}: ${message}`);
  }

  private getRomeOrigin(): string {
    return `http://127.0.0.1:${this.config.romePort}`;
  }

  private async runHealthChecks(): Promise<void> {
    log.debug("running scheduled health checks");
    for (const service of Object.values(this.services)) {
      const healthy = await service.probeHealth();
      if (healthy) {
        continue;
      }

      log.warn("service failed health check, retrying", { service: service.name });
      await delay(this.config.healthRetryDelayMs);
      if (await service.probeHealth()) {
        log.info("service recovered on retry", { service: service.name });
        continue;
      }

      log.warn("service still unhealthy, restarting", { service: service.name });
      try {
        await service.restart("health_check_failed");
      } catch (error) {
        log.error("restart failed", { service: service.name, error });
      }
    }
  }

  private async scheduleUnexpectedExitRecovery(serviceName: ManagedServiceName): Promise<void> {
    await this.operationMutex.runExclusive(async () => {
      log.warn("recovering service after unexpected exit", { service: serviceName });
      await delay(1_000);
      try {
        await this.services[serviceName].start("unexpected_exit");
      } catch (error) {
        log.error("failed to restart service after unexpected exit", {
          service: serviceName,
          error,
        });
      }
    });
  }

  private async runCommand(command: string, args: string[], cwd: string): Promise<void> {
    log.info("running command", { command, args });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        stdio: "inherit",
        env: process.env,
      });

      child.once("exit", (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(`${command} exited with code=${code ?? "null"} signal=${signal ?? "null"}`),
        );
      });
      child.once("error", reject);
    });
  }

  private writeJson(res: ServerResponse<IncomingMessage>, status: number, body: unknown): void {
    res.writeHead(status, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify(body));
  }

  private async readJsonBody<T>(req: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (chunks.length === 0) {
      return {} as T;
    }
    return JSON.parse(Buffer.concat(chunks).toString()) as T;
  }
}

function createDaemonConfig(): DaemonConfig {
  return {
    appDir: process.env.ROME_APP_DIR ?? "/app",
    healthCheckIntervalMs: Number.parseInt(
      process.env.HEALTH_CHECK_INTERVAL_MS ?? `${5 * 60 * 1000}`,
      10,
    ),
    healthRetryDelayMs: Number.parseInt(process.env.HEALTH_CHECK_RETRY_DELAY_MS ?? "15000", 10),
    healthTimeoutMs: Number.parseInt(process.env.HEALTH_CHECK_TIMEOUT_MS ?? "10000", 10),
    actionHost: process.env.HEALTH_DAEMON_HOST ?? "0.0.0.0",
    actionPort: Number.parseInt(process.env.HEALTH_DAEMON_PORT ?? "9368", 10),
    romePort: Number.parseInt(process.env.INTERNAL_API_PORT ?? "4141", 10),
  };
}

export async function main(): Promise<void> {
  initTelemetry();

  const daemon = new HealthCheckDaemon(createDaemonConfig());

  const shutdown = async (signal: string) => {
    log.info("received shutdown signal", { signal });
    await daemon.stop();
    await flushTelemetry();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await daemon.start();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(async (error) => {
    log.error("daemon fatal", { error });
    await flushTelemetry();
    process.exit(1);
  });
}
