import type { McpServerConfig } from "../types.js";
import { createLogger } from "../logger.js";

const log = createLogger("capability-discovery");

export interface DiscoveredBrowserEndpoint {
  name: string;
  browserUrl: string;
}

const PROBE_TIMEOUT_MS = 3000;
const REFRESH_INTERVAL_MS = 60_000;
const LOCAL_CHROMIUM_HOST = "127.0.0.1";
const LOCAL_CHROMIUM_PORT = Number.parseInt(process.env.ROME_CHROME_CDP_PORT ?? "9222", 10);

export class CapabilityDiscovery {
  private cdpMcpServers: Record<string, McpServerConfig> = {};
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly cdpAutomationEnabled = false) {}

  /** Start periodic discovery of the local browser when enabled. */
  async start(): Promise<void> {
    if (!this.cdpAutomationEnabled) return;

    log.info("capability discovery started");

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

    this.cdpMcpServers = newServers;
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
}

function extractBrowserUrl(config: McpServerConfig): string | null {
  const arg = config.args.find((value) => value.startsWith("--browser-url="));
  if (!arg) {
    return null;
  }

  const browserUrl = arg.slice("--browser-url=".length).trim();
  return browserUrl.length > 0 ? browserUrl : null;
}

export { extractBrowserUrl };
