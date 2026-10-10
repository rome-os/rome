import { execFile } from "node:child_process";
import { z } from "zod";
import type { McpServerConfig } from "../types.js";
import { createLogger } from "../logger.js";

function execFileAsync(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}

const log = createLogger("capability-discovery");

// Zod schemas for the Capability Discovery Protocol (port 9368)

const CdpServerInfoSchema = z.object({
  name: z.string(),
  port: z.number(),
  status: z.string(),
  last_activity_at: z.string().nullable().optional(),
});

const McpServerInfoSchema = z.object({
  name: z.string(),
  host: z.string(),
  port: z.number(),
  status: z.string(),
  last_check: z.string().nullable(),
});

const CapabilityInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  hostname: z.string(),
  tailscale_ip: z.string().nullable(),
  capabilities: z.object({
    cdp_servers: z.array(CdpServerInfoSchema),
    mcp_servers: z.array(McpServerInfoSchema),
  }),
  uptime_seconds: z.number(),
});

type CapabilityInfo = z.infer<typeof CapabilityInfoSchema>;

export interface DiscoveredBrowserEndpoint {
  name: string;
  browserUrl: string;
}

// Tailscale status types (subset)

const TailscalePeerSchema = z.object({
  TailscaleIPs: z.array(z.string()).min(1),
  HostName: z.string(),
  Online: z.boolean(),
});

const TailscaleStatusSchema = z.object({
  Peer: z.record(z.string(), TailscalePeerSchema).nullable().optional(),
});

const DISCOVERY_PORT = 9368;
const PROBE_TIMEOUT_MS = 3000;
const REFRESH_INTERVAL_MS = 60_000;
const LOCAL_CHROMIUM_HOST = "127.0.0.1";
const LOCAL_CHROMIUM_PORT = Number.parseInt(process.env.ROME_CHROME_CDP_PORT ?? "9222", 10);

const TAILSCALE_PATHS = [
  "/usr/local/bin/tailscale",
  "/usr/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

export class CapabilityDiscovery {
  private cdpMcpServers: Record<string, McpServerConfig> = {};
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private tailscaleBin: string | null = null;

  constructor(private readonly cdpAutomationEnabled = false) {}

  /** Start periodic discovery when enabled. Safe to call without Tailscale installed. */
  async start(): Promise<void> {
    if (!this.cdpAutomationEnabled) return;

    this.tailscaleBin = await this.findTailscale();
    if (!this.tailscaleBin) {
      log.debug("tailscale not installed, remote capability discovery disabled");
    }

    log.info("capability discovery started", { tailscale: this.tailscaleBin });

    await this.refresh();

    this.refreshTimer = setInterval(() => {
      this.refresh().catch((err) => {
        log.error("refresh failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, REFRESH_INTERVAL_MS);
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.cdpMcpServers = {};
    log.info("capability discovery stopped");
  }

  getCdpMcpServers(): Record<string, McpServerConfig> {
    return { ...this.cdpMcpServers };
  }

  getBrowserEndpoints(): DiscoveredBrowserEndpoint[] {
    return Object.entries(this.cdpMcpServers)
      .map(([name, config]) => {
        const browserUrl = extractBrowserUrl(config);
        return browserUrl ? { name, browserUrl } : null;
      })
      .filter((entry): entry is DiscoveredBrowserEndpoint => entry !== null)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private async refresh(): Promise<void> {
    const peers = await this.getTailscalePeers();
    const newServers: Record<string, McpServerConfig> = {};

    const localBrowserRunning = await this.probeLocalChromium();
    if (localBrowserRunning) {
      newServers["cdp-local-chromium"] = {
        command: "npx",
        args: [
          "-y",
          "chrome-devtools-mcp@latest",
          `--browser-url=http://${LOCAL_CHROMIUM_HOST}:${LOCAL_CHROMIUM_PORT}`,
          "--no-usage-statistics",
        ],
      };
    }

    if (peers.length === 0) {
      this.cdpMcpServers = newServers;
      return;
    }

    const results = await Promise.allSettled(
      peers.map(async (peer) => {
        const info = await this.probeCapabilities(peer.ip);
        if (info) {
          return { peer, info };
        }
        return null;
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        const { peer, info } = result.value;
        for (const cdp of info.capabilities.cdp_servers) {
          if (cdp.status !== "running") continue;
          const serverName = sanitizeName(`cdp-${info.hostname}-${cdp.name}`);
          newServers[serverName] = {
            command: "npx",
            args: [
              "-y",
              "chrome-devtools-mcp@latest",
              `--browser-url=http://${peer.ip}:${cdp.port}`,
              "--no-usage-statistics",
            ],
          };
        }
      }
    }

    // Log changes
    const oldNames = new Set(Object.keys(this.cdpMcpServers));
    const newNames = new Set(Object.keys(newServers));

    const added = [...newNames].filter((n) => !oldNames.has(n));
    const removed = [...oldNames].filter((n) => !newNames.has(n));

    if (added.length > 0 || removed.length > 0) {
      log.info("capability changes detected", {
        added,
        removed,
        total: newNames.size,
      });
    }

    this.cdpMcpServers = newServers;
  }

  private async getTailscalePeers(): Promise<{ ip: string; hostname: string }[]> {
    if (!this.tailscaleBin) {
      return [];
    }

    try {
      const { stdout } = await execFileAsync(this.tailscaleBin!, ["status", "--json"]);
      const parsed = TailscaleStatusSchema.safeParse(JSON.parse(stdout));
      if (!parsed.success) {
        log.warn("failed to parse tailscale status", {
          error: parsed.error.message,
        });
        return [];
      }

      const peers: { ip: string; hostname: string }[] = [];
      for (const peer of Object.values(parsed.data.Peer ?? {})) {
        if (peer.Online && peer.TailscaleIPs.length > 0) {
          peers.push({
            ip: peer.TailscaleIPs[0],
            hostname: peer.HostName,
          });
        }
      }
      return peers;
    } catch (err) {
      log.warn("tailscale status failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  private async probeCapabilities(ip: string): Promise<CapabilityInfo | null> {
    const url = `http://${ip}:${DISCOVERY_PORT}/`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) return null;

      const json = await response.json();
      const parsed = CapabilityInfoSchema.safeParse(json);
      if (!parsed.success) {
        log.debug("invalid capability response", { ip, error: parsed.error.message });
        return null;
      }
      return parsed.data;
    } catch {
      // Connection refused, timeout, etc. — peer not running Rome
      return null;
    }
  }

  private async probeLocalChromium(): Promise<boolean> {
    if (!Number.isFinite(LOCAL_CHROMIUM_PORT)) {
      return false;
    }

    const url = `http://${LOCAL_CHROMIUM_HOST}:${LOCAL_CHROMIUM_PORT}/json/version`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      return response.ok;
    } catch {
      return false;
    }
  }

  private async findTailscale(): Promise<string | null> {
    for (const path of TAILSCALE_PATHS) {
      try {
        await execFileAsync(path, ["version"]);
        return path;
      } catch {}
    }

    try {
      await execFileAsync("tailscale", ["version"]);
      return "tailscale";
    } catch {
      return null;
    }
  }
}

/** Sanitize a name for use as an MCP server key (lowercase, alphanumeric + hyphens). */
function sanitizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function extractBrowserUrl(config: McpServerConfig): string | null {
  const arg = config.args.find((value) => value.startsWith("--browser-url="));
  if (!arg) {
    return null;
  }

  const browserUrl = arg.slice("--browser-url=".length).trim();
  return browserUrl.length > 0 ? browserUrl : null;
}

export { sanitizeName, extractBrowserUrl };
