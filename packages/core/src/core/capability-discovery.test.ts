import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import { CapabilityDiscovery, extractBrowserUrl } from "./capability-discovery.js";

const mockFetch = rs.fn();
rs.stubGlobal("fetch", mockFetch);
const LOCAL_BROWSER_URL = "http://127.0.0.1:9222/json/version";

describe("CapabilityDiscovery", () => {
  let discovery: CapabilityDiscovery;

  beforeEach(() => {
    rs.useFakeTimers();
    discovery = new CapabilityDiscovery(true);
    mockFetch.mockReset();
  });

  afterEach(() => {
    discovery.stop();
    rs.useRealTimers();
  });

  it.each([
    undefined,
    false,
  ])("skips discovery and refreshes when enabled is %s", async (enabled) => {
    discovery = new CapabilityDiscovery(enabled);
    mockFetch.mockResolvedValue({ ok: true });

    await discovery.start();
    await rs.advanceTimersByTimeAsync(120_000);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(discovery.getCdpMcpServers()).toEqual({});
    expect(discovery.getBrowserEndpoints()).toEqual([]);
  });

  it("returns empty capabilities when no local browser answers", async () => {
    mockFetch.mockRejectedValue(new Error("Connection refused"));

    await discovery.start();
    expect(discovery.getCdpMcpServers()).toEqual({});
  });

  it("discovers the local chromium", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ browser: "Chromium" }) });

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
    expect(mockFetch).toHaveBeenCalledWith(
      LOCAL_BROWSER_URL,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("treats a non-OK local probe as no browser", async () => {
    mockFetch.mockResolvedValue({ ok: false });

    await discovery.start();
    expect(discovery.getCdpMcpServers()).toEqual({});
  });

  it("refreshes on an interval and drops a browser that went away", async () => {
    mockFetch.mockResolvedValue({ ok: true });
    await discovery.start();
    expect(Object.keys(discovery.getCdpMcpServers())).toHaveLength(1);

    mockFetch.mockRejectedValue(new Error("Connection refused"));
    await rs.advanceTimersByTimeAsync(60_000);
    expect(discovery.getCdpMcpServers()).toEqual({});
  });

  describe("start/stop lifecycle", () => {
    it("stop clears discovered servers", async () => {
      mockFetch.mockResolvedValue({ ok: true });

      await discovery.start();
      expect(Object.keys(discovery.getCdpMcpServers())).toHaveLength(1);

      discovery.stop();
      expect(discovery.getCdpMcpServers()).toEqual({});
    });

    it("returns a copy from getCdpMcpServers (immutable)", async () => {
      mockFetch.mockRejectedValue(new Error("Connection refused"));
      await discovery.start();

      const servers1 = discovery.getCdpMcpServers();
      const servers2 = discovery.getCdpMcpServers();
      expect(servers1).toEqual(servers2);
      expect(servers1).not.toBe(servers2);
    });

    it("exposes discovered browser endpoints", async () => {
      mockFetch.mockResolvedValue({ ok: true });

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
