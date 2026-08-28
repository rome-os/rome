import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import { CapabilityDiscovery, extractBrowserUrl, sanitizeName } from "./capability-discovery.js";

// Mock child_process.execFile
rs.mock("node:child_process", () => ({
  execFile: rs.fn(),
}));

import { execFile } from "node:child_process";
import { promisify } from "node:util";

// We need to mock the promisified version. The module calls promisify(execFile)
// at import time, so we intercept execFile itself and control its callback behavior.

function mockExecFile(impl: (cmd: string, args: string[]) => { stdout: string; stderr: string }) {
  (execFile as unknown as ReturnType<typeof rs.fn>).mockImplementation(
    (
      cmd: string,
      args: string[],
      callback: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      try {
        const result = impl(cmd, args);
        callback(null, result.stdout, result.stderr);
      } catch (err) {
        callback(err as Error, "", "");
      }
    },
  );
}

function mockExecFileFail() {
  (execFile as unknown as ReturnType<typeof rs.fn>).mockImplementation(
    (
      _cmd: string,
      _args: string[],
      callback: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      callback(new Error("command not found"), "", "");
    },
  );
}

// Mock global fetch
const mockFetch = rs.fn();
rs.stubGlobal("fetch", mockFetch);
const LOCAL_BROWSER_URL = "http://127.0.0.1:9222/json/version";

describe("CapabilityDiscovery", () => {
  let discovery: CapabilityDiscovery;

  beforeEach(() => {
    rs.useFakeTimers();
    discovery = new CapabilityDiscovery();
    mockFetch.mockReset();
  });

  afterEach(() => {
    discovery.stop();
    rs.useRealTimers();
  });

  describe("no Tailscale installed", () => {
    it("returns empty capabilities without errors", async () => {
      mockExecFileFail();
      mockFetch.mockRejectedValue(new Error("Connection refused"));

      await discovery.start();
      expect(discovery.getCdpMcpServers()).toEqual({});
    });

    it("keeps local chromium available without Tailscale", async () => {
      mockExecFileFail();
      mockFetch.mockImplementation(async (url: string) => {
        if (url === LOCAL_BROWSER_URL) {
          return {
            ok: true,
            json: async () => ({ browser: "Chromium" }),
          };
        }
        throw new Error("Connection refused");
      });

      await discovery.start();
      expect(discovery.getCdpMcpServers()).toEqual({
        "cdp-local-chromium": {
          command: "npx",
          args: [
            "-y",
            "chrome-devtools-mcp@latest",
            "--browser-url=http://127.0.0.1:9222",
            "--no-usage-statistics",
          ],
        },
      });
    });
  });

  describe("with Tailscale and peers", () => {
    function setupTailscale(
      peers: Record<string, { TailscaleIPs: string[]; HostName: string; Online: boolean }>,
    ) {
      mockExecFile((cmd, args) => {
        if (args.includes("version")) {
          return { stdout: "1.60.0", stderr: "" };
        }
        if (args.includes("status") && args.includes("--json")) {
          return {
            stdout: JSON.stringify({ Peer: peers }),
            stderr: "",
          };
        }
        throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
      });
    }

    function mockCapabilityResponse(ip: string, response: Record<string, unknown>) {
      mockFetch.mockImplementation(async (url: string) => {
        if (url === LOCAL_BROWSER_URL) {
          throw new Error("Connection refused");
        }
        if (url === `http://${ip}:9368/`) {
          return {
            ok: true,
            json: async () => response,
          };
        }
        throw new Error("Connection refused");
      });
    }

    function mockLocalChromiumAndCapabilityResponses(
      responder: (url: string) => Promise<{ ok: boolean; json?: () => Promise<unknown> }>,
    ) {
      mockFetch.mockImplementation(async (url: string) => {
        if (url === LOCAL_BROWSER_URL) {
          return {
            ok: true,
            json: async () => ({ browser: "Chromium" }),
          };
        }
        return responder(url);
      });
    }

    it("discovers CDP servers from online peers", async () => {
      setupTailscale({
        peer1: {
          TailscaleIPs: ["100.64.1.10"],
          HostName: "macbook-pro",
          Online: true,
        },
      });

      mockLocalChromiumAndCapabilityResponses(async (url: string) => {
        if (url === "http://100.64.1.10:9368/") {
          return {
            ok: true,
            json: async () => ({
              name: "rome-desktop",
              version: "0.1.0",
              hostname: "macbook-pro",
              tailscale_ip: "100.64.1.10",
              capabilities: {
                cdp_servers: [{ name: "Personal Chrome", port: 9222, status: "running" }],
                mcp_servers: [],
              },
              uptime_seconds: 100,
            }),
          };
        }
        throw new Error("Connection refused");
      });

      await discovery.start();
      const servers = discovery.getCdpMcpServers();

      expect(Object.keys(servers)).toEqual([
        "cdp-local-chromium",
        "cdp-macbook-pro-personal-chrome",
      ]);
      expect(servers["cdp-local-chromium"].args).toContain("--browser-url=http://127.0.0.1:9222");
      const key = Object.keys(servers)[1];
      expect(key).toBe("cdp-macbook-pro-personal-chrome");
      expect(servers[key].command).toBe("npx");
      expect(servers[key].args).toContain("-y");
      expect(servers[key].args).toContain("chrome-devtools-mcp@latest");
      expect(servers[key].args).toContain("--browser-url=http://100.64.1.10:9222");
      expect(servers[key].args).toContain("--no-usage-statistics");
    });

    it("discovers multiple CDP servers from multiple peers", async () => {
      setupTailscale({
        peer1: {
          TailscaleIPs: ["100.64.1.10"],
          HostName: "macbook",
          Online: true,
        },
        peer2: {
          TailscaleIPs: ["100.64.1.20"],
          HostName: "desktop",
          Online: true,
        },
      });

      mockLocalChromiumAndCapabilityResponses(async (url: string) => {
        if (url === "http://100.64.1.10:9368/") {
          return {
            ok: true,
            json: async () => ({
              name: "rome-desktop",
              version: "0.1.0",
              hostname: "macbook",
              tailscale_ip: "100.64.1.10",
              capabilities: {
                cdp_servers: [{ name: "Chrome", port: 9222, status: "running" }],
                mcp_servers: [],
              },
              uptime_seconds: 100,
            }),
          };
        }
        if (url === "http://100.64.1.20:9368/") {
          return {
            ok: true,
            json: async () => ({
              name: "rome-desktop",
              version: "0.1.0",
              hostname: "desktop",
              tailscale_ip: "100.64.1.20",
              capabilities: {
                cdp_servers: [
                  { name: "Work Chrome", port: 9222, status: "running" },
                  { name: "Dev Chrome", port: 9223, status: "running" },
                ],
                mcp_servers: [],
              },
              uptime_seconds: 200,
            }),
          };
        }
        throw new Error("Connection refused");
      });

      await discovery.start();
      const servers = discovery.getCdpMcpServers();

      expect(Object.keys(servers)).toHaveLength(4);
      expect(Object.keys(servers)[0]).toBe("cdp-local-chromium");
      expect(servers["cdp-macbook-chrome"]).toBeDefined();
      expect(servers["cdp-desktop-work-chrome"]).toBeDefined();
      expect(servers["cdp-desktop-dev-chrome"]).toBeDefined();
    });

    it("skips offline peers", async () => {
      setupTailscale({
        peer1: {
          TailscaleIPs: ["100.64.1.10"],
          HostName: "macbook",
          Online: false,
        },
      });

      await discovery.start();
      expect(discovery.getCdpMcpServers()).toEqual({});
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        LOCAL_BROWSER_URL,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("skips non-running CDP servers", async () => {
      setupTailscale({
        peer1: {
          TailscaleIPs: ["100.64.1.10"],
          HostName: "macbook",
          Online: true,
        },
      });

      mockCapabilityResponse("100.64.1.10", {
        name: "rome-desktop",
        version: "0.1.0",
        hostname: "macbook",
        tailscale_ip: "100.64.1.10",
        capabilities: {
          cdp_servers: [{ name: "Chrome", port: 9222, status: "stopped" }],
          mcp_servers: [],
        },
        uptime_seconds: 100,
      });

      await discovery.start();
      expect(discovery.getCdpMcpServers()).toEqual({});
    });

    it("handles peers that do not respond on port 9368", async () => {
      setupTailscale({
        peer1: {
          TailscaleIPs: ["100.64.1.10"],
          HostName: "macbook",
          Online: true,
        },
      });

      mockFetch.mockImplementation(async (url: string) => {
        if (url === LOCAL_BROWSER_URL) {
          throw new Error("Connection refused");
        }
        throw new Error("Connection refused");
      });

      await discovery.start();
      expect(discovery.getCdpMcpServers()).toEqual({});
    });

    it("handles invalid JSON responses gracefully", async () => {
      setupTailscale({
        peer1: {
          TailscaleIPs: ["100.64.1.10"],
          HostName: "macbook",
          Online: true,
        },
      });

      mockFetch.mockImplementation(async (url: string) => {
        if (url === LOCAL_BROWSER_URL) {
          throw new Error("Connection refused");
        }
        return {
          ok: true,
          json: async () => ({ invalid: "response" }),
        };
      });

      await discovery.start();
      expect(discovery.getCdpMcpServers()).toEqual({});
    });

    it("treats a null Peer map as no peers", async () => {
      mockExecFile((cmd, args) => {
        if (args.includes("version")) {
          return { stdout: "1.60.0", stderr: "" };
        }
        if (args.includes("status") && args.includes("--json")) {
          return {
            stdout: JSON.stringify({ Peer: null }),
            stderr: "",
          };
        }
        throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
      });

      await discovery.start();
      expect(discovery.getCdpMcpServers()).toEqual({});
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        LOCAL_BROWSER_URL,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });

  describe("start/stop lifecycle", () => {
    it("stop clears discovered servers", async () => {
      mockExecFile((_, args) => {
        if (args.includes("version")) return { stdout: "1.60.0", stderr: "" };
        return {
          stdout: JSON.stringify({
            Peer: {
              p1: { TailscaleIPs: ["100.64.1.10"], HostName: "mac", Online: true },
            },
          }),
          stderr: "",
        };
      });

      mockFetch.mockImplementation(async (url: string) => {
        if (url === LOCAL_BROWSER_URL) {
          throw new Error("Connection refused");
        }
        return {
          ok: true,
          json: async () => ({
            name: "rome-desktop",
            version: "0.1.0",
            hostname: "mac",
            tailscale_ip: "100.64.1.10",
            capabilities: {
              cdp_servers: [{ name: "Chrome", port: 9222, status: "running" }],
              mcp_servers: [],
            },
            uptime_seconds: 100,
          }),
        };
      });

      await discovery.start();
      expect(Object.keys(discovery.getCdpMcpServers())).toHaveLength(1);

      discovery.stop();
      expect(discovery.getCdpMcpServers()).toEqual({});
    });

    it("returns a copy from getCdpMcpServers (immutable)", async () => {
      mockExecFileFail();
      await discovery.start();

      const servers1 = discovery.getCdpMcpServers();
      const servers2 = discovery.getCdpMcpServers();
      expect(servers1).toEqual(servers2);
      expect(servers1).not.toBe(servers2);
    });

    it("exposes discovered browser endpoints", async () => {
      mockExecFileFail();
      mockFetch.mockImplementation(async (url: string) => {
        if (url === LOCAL_BROWSER_URL) {
          return {
            ok: true,
            json: async () => ({ browser: "Chromium" }),
          };
        }
        throw new Error("Connection refused");
      });

      await discovery.start();

      expect(discovery.getBrowserEndpoints()).toEqual([
        {
          name: "cdp-local-chromium",
          browserUrl: "http://127.0.0.1:9222",
        },
      ]);
    });
  });
});

describe("sanitizeName", () => {
  it("lowercases and replaces special chars with hyphens", () => {
    expect(sanitizeName("cdp-MacBook-Pro-Personal Chrome")).toBe("cdp-macbook-pro-personal-chrome");
  });

  it("collapses multiple hyphens", () => {
    expect(sanitizeName("cdp--double---hyphen")).toBe("cdp-double-hyphen");
  });

  it("trims leading/trailing hyphens", () => {
    expect(sanitizeName("-leading-trailing-")).toBe("leading-trailing");
  });

  it("handles names with special characters", () => {
    expect(sanitizeName("cdp-My (Work) Chrome!")).toBe("cdp-my-work-chrome");
  });
});

describe("extractBrowserUrl", () => {
  it("returns the browser url from mcp server args", () => {
    expect(
      extractBrowserUrl({
        command: "npx",
        args: ["-y", "chrome-devtools-mcp@latest", "--browser-url=http://127.0.0.1:9222"],
      }),
    ).toBe("http://127.0.0.1:9222");
  });

  it("returns null when no browser url flag is present", () => {
    expect(
      extractBrowserUrl({
        command: "npx",
        args: ["-y", "chrome-devtools-mcp@latest"],
      }),
    ).toBeNull();
  });
});
