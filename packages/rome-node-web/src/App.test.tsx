import { afterEach, beforeEach, describe, expect, it, rstest } from "@rstest/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import type { AuditItem, HostSnapshot } from "./types";

function makeSnapshot(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    phase: "unconfigured",
    since: Date.now() - 5_000,
    configured: false,
    executionEnabled: true,
    autoConnect: true,
    cloudUrl: "https://rome.ai",
    deviceName: "container-node",
    deviceId: null,
    platform: "linux/arm64",
    version: "0.1.0",
    pendingAuth: null,
    lastError: null,
    audit: {
      summary: {
        path: "/home/node/.rome-node/audit.db",
        status: { state: "ok" },
        bytes: 4096,
        records: 2,
        requests: 1,
        oldestAt: Date.now() - 10_000,
        newestAt: Date.now() - 1_000,
        lastPrune: null,
        retention: { maxAgeDays: 30, maxBytes: 1024 * 1024 * 1024 },
      },
      counts: { all: 1, succeeded: 1, failed: 0, no_result: 0 },
    },
    ...overrides,
  };
}

const sampleAuditItem: AuditItem = {
  seq: 1,
  at: Date.now() - 2_000,
  kind: "start",
  action: "exec",
  startSeq: null,
  outcome: null,
  record: {
    requestId: "req-1",
    from: "instance-1",
    args: { command: "echo", args: ["hello-rome"], cwd: "/workspace" },
  },
  end: {
    seq: 2,
    at: Date.now() - 1_900,
    kind: "end",
    action: "exec",
    startSeq: 1,
    outcome: "ok",
    record: {
      exitCode: 0,
      durationMs: 100,
      stdout: { bytes: 11, keptBytes: 11, truncated: false },
    },
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Rome Node Web UI", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.setItem("rome-node-locale", "en");
    window.location.hash = "";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rstest.restoreAllMocks();
  });

  it("renders login gate when auth is required and unlocks with token", async () => {
    let unlocked = false;
    const onlineSnapshot = makeSnapshot({
      phase: "online",
      configured: true,
      deviceId: "dev_123",
    });

    globalThis.fetch = rstest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/auth/session") {
        return jsonResponse({ authRequired: true, authenticated: unlocked });
      }
      if (url === "/api/auth/login" && init?.method === "POST") {
        unlocked = true;
        return jsonResponse({ authRequired: true, authenticated: true });
      }
      if (url === "/api/status") {
        return jsonResponse(onlineSnapshot);
      }
      return jsonResponse({ error: "not_found" }, 404);
    }) as typeof fetch;

    render(<App />);

    expect(await screen.findByText("Unlock Rome Node")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "secret-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));

    expect(await screen.findByText("dev_123")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Lock UI" })).toBeTruthy();
  });

  it("starts OAuth2 Device Code authorization and shows user code + verification link", async () => {
    let snapshot = makeSnapshot();

    globalThis.fetch = rstest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/auth/session") {
        return jsonResponse({ authRequired: false, authenticated: true });
      }
      if (url === "/api/status") {
        return jsonResponse(snapshot);
      }
      if (url === "/api/host/authorize" && init?.method === "POST") {
        snapshot = makeSnapshot({
          phase: "authorizing",
          pendingAuth: {
            verificationUri: "https://rome.ai/device",
            verificationUriComplete: "https://rome.ai/device?user_code=ABCD-EFGH",
            userCode: "ABCD-EFGH",
            expiresAt: Date.now() + 600_000,
          },
        });
        return jsonResponse(snapshot);
      }
      return jsonResponse({ error: "not_found" }, 404);
    }) as typeof fetch;

    render(<App />);

    const startBtn = await screen.findByRole("button", { name: "Authorize device" });
    fireEvent.click(startBtn);

    expect(await screen.findByText("ABCD-EFGH")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open Rome Cloud" });
    expect(link.getAttribute("href")).toBe("https://rome.ai/device?user_code=ABCD-EFGH");
  });

  it("toggles remote execution and inspects audit log output in detail sheet", async () => {
    let snapshot = makeSnapshot({
      phase: "online",
      configured: true,
      deviceId: "dev_999",
      executionEnabled: true,
    });

    globalThis.fetch = rstest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/auth/session") {
        return jsonResponse({ authRequired: false, authenticated: true });
      }
      if (url === "/api/status") {
        return jsonResponse(snapshot);
      }
      if (url === "/api/host/execution" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { enabled: boolean };
        snapshot = { ...snapshot, executionEnabled: body.enabled };
        return jsonResponse(snapshot);
      }
      if (url.startsWith("/api/audit/stats")) {
        return jsonResponse({
          since: Date.now() - 86_400_000,
          until: Date.now(),
          bucketMs: 600_000,
          groups: [],
        });
      }
      if (url.startsWith("/api/audit/items?")) {
        return jsonResponse({ items: [sampleAuditItem], hasMore: false });
      }
      if (url === "/api/audit/items/1/content/stdout") {
        return new Response("hello-rome\n", {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "x-content-total-bytes": "11",
            "x-content-truncated": "false",
          },
        });
      }
      return jsonResponse({ error: "not_found" }, 404);
    }) as typeof fetch;

    render(<App />);

    const toggle = await screen.findByRole("switch", { name: "Allow remote execution" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("false");
    });

    fireEvent.click(screen.getByRole("link", { name: "Audit log" }));

    const rowBtn = await screen.findByRole("button", { name: /echo hello-rome/i });
    fireEvent.click(rowBtn);

    expect(await screen.findByText("hello-rome")).toBeTruthy();
  });
});
