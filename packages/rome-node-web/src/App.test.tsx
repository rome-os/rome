import { afterEach, beforeEach, describe, expect, it, rstest } from "@rstest/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import type { HostSnapshot } from "./types";

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
      status: { state: "ok" },
      bytes: 4096,
      requests: 1,
    },
    ...overrides,
  };
}

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
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rstest.restoreAllMocks();
  });

  it("renders password unlock gate when auth is required and unlocks with password", async () => {
    let unlocked = false;
    const onlineSnapshot = makeSnapshot({
      phase: "online",
      configured: true,
      deviceId: "dev_123",
    });

    globalThis.fetch = rstest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/auth/session") {
        return jsonResponse({
          authRequired: true,
          authenticated: unlocked,
          passwordSource: "file",
        });
      }
      if (url === "/api/auth/login" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { password?: string };
        expect(body.password).toBe("my-secret-pass");
        unlocked = true;
        return jsonResponse({ authRequired: true, authenticated: true, passwordSource: "file" });
      }
      if (url === "/api/status") {
        return jsonResponse(onlineSnapshot);
      }
      return jsonResponse({ error: "not_found" }, 404);
    }) as typeof fetch;

    render(<App />);

    expect(await screen.findByText("Unlock Web UI")).toBeTruthy();
    expect(screen.getByText("Rome")).toBeTruthy();
    expect(screen.getByText("Node")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Switch language (简体中文)" }));
    expect(screen.getByText("解锁控制面")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "切换语言 (English)" }));
    expect(screen.getByText("Unlock Web UI")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "my-secret-pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));

    expect(await screen.findByText("dev_123")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Lock UI" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Switch language (简体中文)" })).toBeTruthy();
    expect(screen.getByText("Password set")).toBeTruthy();
  });

  it("allows setting a custom password from local passwordless mode", async () => {
    const snapshot = makeSnapshot();

    globalThis.fetch = rstest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/auth/session") {
        return jsonResponse({ authRequired: false, authenticated: true, passwordSource: "none" });
      }
      if (url === "/api/status") {
        return jsonResponse(snapshot);
      }
      if (url === "/api/auth/password" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { newPassword?: string };
        expect(body.newPassword).toBe("custom-pass-1");
        return jsonResponse({ authRequired: true, authenticated: true, passwordSource: "file" });
      }
      return jsonResponse({ error: "not_found" }, 404);
    }) as typeof fetch;

    render(<App />);

    expect(await screen.findByText("Local passwordless")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Lock UI" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Set password" }));
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "custom-pass-1" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "custom-pass-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save password" }));

    expect(await screen.findByText("Password set")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Lock UI" })).toBeTruthy();
  });

  it("starts OAuth2 Device Code authorization and shows user code + verification link", async () => {
    let snapshot = makeSnapshot();

    globalThis.fetch = rstest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/auth/session") {
        return jsonResponse({ authRequired: false, authenticated: true, passwordSource: "none" });
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

  it("toggles execution and links configured nodes to Rome Cloud for full activity logs", async () => {
    let snapshot = makeSnapshot({
      phase: "online",
      configured: true,
      deviceId: "dev_999",
      executionEnabled: true,
    });

    globalThis.fetch = rstest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/auth/session") {
        return jsonResponse({ authRequired: false, authenticated: true, passwordSource: "none" });
      }
      if (url === "/api/status") {
        return jsonResponse(snapshot);
      }
      if (url === "/api/host/execution" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { enabled: boolean };
        snapshot = { ...snapshot, executionEnabled: body.enabled };
        return jsonResponse(snapshot);
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

    expect(screen.getByText("Healthy")).toBeTruthy();
    const cloudLink = screen.getByRole("link", { name: "Open Rome Cloud" });
    expect(cloudLink.getAttribute("href")).toBe("https://rome.ai/dashboard");
  });

  it("completes one-time setup token initialization and hides Remove password when non-loopback", async () => {
    let initialized = false;
    const snapshot = makeSnapshot();

    globalThis.fetch = rstest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/auth/session") {
        return jsonResponse({
          authRequired: true,
          authenticated: initialized,
          passwordSource: initialized ? "file" : "setup",
          canRemovePassword: false,
        });
      }
      if (url === "/api/auth/setup" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { token?: string; newPassword?: string };
        expect(body).toEqual({ token: "one-time-token-xyz", newPassword: "docker-pass-1" });
        initialized = true;
        return jsonResponse({
          authRequired: true,
          authenticated: true,
          passwordSource: "file",
          canRemovePassword: false,
        });
      }
      if (url === "/api/status") {
        return jsonResponse(snapshot);
      }
      return jsonResponse({ error: "not_found" }, 404);
    }) as typeof fetch;

    render(<App />);

    expect(await screen.findByText("Set up Web UI password")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("One-time setup token"), {
      target: { value: "one-time-token-xyz" },
    });
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "docker-pass-1" },
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "docker-pass-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set password & unlock" }));

    expect(await screen.findByText("Password set")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change password" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove password" })).toBeNull();
  });

  it("navigates to Computer use log, filters, searches, paginates, inspects content previews, and switches locale", async () => {
    const now = Date.now();
    const bucketStart = Math.floor(now / 600_000) * 600_000;
    const snapshot = makeSnapshot({
      phase: "online",
      configured: true,
      deviceName: "prod-runner",
      deviceId: "dev_log_1",
      audit: { status: { state: "ok" }, bytes: 24_576, requests: 3 },
    });

    const execItem = {
      seq: 30,
      at: now - 60_000,
      kind: "start",
      action: "exec",
      startSeq: null,
      outcome: null,
      record: {
        requestId: "req-git-status",
        from: "caller-cloud-1",
        args: { command: "git", args: ["status", "--short"], cwd: "/workspace/app" },
        envKeys: ["PATH", "HOME"],
      },
      end: {
        seq: 31,
        at: now - 59_750,
        kind: "end",
        action: "exec",
        startSeq: 30,
        outcome: "ok",
        record: {
          durationMs: 250,
          exitCode: 0,
          pid: 4242,
          content: {
            stdout: { size: 12, sha256: "abc123stdout", storedBytes: 12 },
            stderr: { size: 512, sha256: "def456stderr", storedBytes: 512 },
          },
        },
      },
    };

    const failItem = {
      seq: 20,
      at: now - 120_000,
      kind: "start",
      action: "exec",
      startSeq: null,
      outcome: null,
      record: {
        requestId: "req-fail-test",
        from: "caller-cloud-2",
        args: { command: "npm", args: ["test"], cwd: "/workspace/app" },
      },
      end: {
        seq: 21,
        at: now - 118_000,
        kind: "end",
        action: "exec",
        startSeq: 20,
        outcome: "exit_nonzero",
        record: {
          durationMs: 2000,
          exitCode: 1,
          content: {
            stderr: { size: 300_000, sha256: "fail789", storedBytes: 300_000 },
          },
        },
      },
    };

    const olderTransferItem = {
      seq: 10,
      at: now - 240_000,
      kind: "start",
      action: "transfer.open",
      startSeq: null,
      outcome: null,
      record: {
        requestId: "req-bin-push",
        from: "caller-cloud-3",
        args: { direction: "push", path: "/tmp/blob.bin" },
      },
      end: {
        seq: 11,
        at: now - 239_900,
        kind: "end",
        action: "transfer.open",
        startSeq: 10,
        outcome: "ok",
        record: {
          durationMs: 100,
          bytes: 2048,
          sha256: "binsha256",
          content: {
            file: { size: 2048, sha256: "binsha256", storedBytes: 2048 },
          },
        },
      },
    };

    const requestedUrls: string[] = [];

    rstest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: 800,
      right: 1200,
      width: 1200,
      height: 800,
      toJSON: () => ({}),
    } as DOMRect);

    globalThis.fetch = rstest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      requestedUrls.push(url);
      if (url === "/api/auth/session") {
        return jsonResponse({ authRequired: false, authenticated: true, passwordSource: "none" });
      }
      if (url === "/api/status") {
        return jsonResponse(snapshot);
      }
      if (url === "/api/audit/summary") {
        return jsonResponse({
          status: { state: "ok" },
          bytes: 24_576,
          records: 7,
          requests: 3,
          oldestAt: now - 240_000,
          newestAt: now - 59_750,
          retention: { maxAgeDays: 30, maxBytes: 1024 * 1024 * 1024 },
          counts: { all: 3, succeeded: 2, failed: 1, no_result: 0 },
        });
      }
      if (url.startsWith("/api/audit/stats")) {
        return jsonResponse({
          since: bucketStart - 24 * 60 * 60 * 1000,
          until: bucketStart + 600_000,
          bucketMs: 600_000,
          groups: [
            { peer: null, bucket: bucketStart, result: "succeeded", count: 2 },
            { peer: null, bucket: bucketStart, result: "failed", count: 1 },
          ],
        });
      }
      if (url === "/api/audit/items" || url.startsWith("/api/audit/items?")) {
        const parsed = new URL(url, "http://localhost");
        const resultFilter = parsed.searchParams.get("result");
        const textFilter = parsed.searchParams.get("text");
        const beforeSeq = parsed.searchParams.get("beforeSeq");
        if (beforeSeq === "20") {
          return jsonResponse({ items: [olderTransferItem], hasMore: false });
        }
        if (resultFilter === "failed") {
          return jsonResponse({ items: [failItem], hasMore: false });
        }
        if (textFilter === "git") {
          return jsonResponse({ items: [execItem], hasMore: false });
        }
        return jsonResponse({ items: [execItem, failItem], hasMore: true });
      }
      if (url === "/api/audit/items/30/content/stdout") {
        return jsonResponse({
          seq: 30,
          name: "stdout",
          available: true,
          size: 12,
          storedBytes: 12,
          sha256: "abc123stdout",
          previewBytes: 12,
          truncated: false,
          isBinary: false,
          text: "M README.md\n",
        });
      }
      if (url === "/api/audit/items/30/content/stderr") {
        return jsonResponse({
          seq: 30,
          name: "stderr",
          available: false,
          size: 512,
          storedBytes: 512,
          sha256: "def456stderr",
          previewBytes: 0,
          truncated: false,
          isBinary: false,
          text: null,
        });
      }
      if (url === "/api/audit/items/10/content/file") {
        return jsonResponse({
          seq: 10,
          name: "file",
          available: true,
          size: 2048,
          storedBytes: 2048,
          sha256: "binsha256",
          previewBytes: 2048,
          truncated: false,
          isBinary: true,
          text: null,
        });
      }
      if (url === "/api/audit/items/20/content/stderr") {
        return jsonResponse({
          seq: 20,
          name: "stderr",
          available: true,
          size: 300_000,
          storedBytes: 300_000,
          sha256: "fail789",
          previewBytes: 262_144,
          truncated: true,
          isBinary: false,
          text: "ERR_TEST_FAILED",
        });
      }
      return jsonResponse({ error: "not_found" }, 404);
    }) as typeof fetch;

    render(<App />);

    // Open Computer use log via the quick "View log" button on Overview.
    const viewLogBtn = await screen.findByRole("button", { name: "View log" });
    fireEvent.click(viewLogBtn);
    expect(window.location.pathname).toBe("/log");

    // Activity summary, storage meta, and initial rows render.
    expect(await screen.findByText(/git status --short/)).toBeTruthy();
    expect(screen.getByText(/npm test/)).toBeTruthy();
    expect(screen.getByText(/3 requests · 30d retention/)).toBeTruthy();

    // Load older page appends the binary transfer row.
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    expect(await screen.findByText(/\/tmp\/blob\.bin/)).toBeTruthy();

    // Select the exec row and verify detail facts + stdout text + pruned stderr.
    fireEvent.click(screen.getByRole("button", { name: /git status --short/ }));
    expect(await screen.findByText("req-git-status")).toBeTruthy();
    expect(screen.getByText("caller-cloud-1")).toBeTruthy();
    expect(screen.getByText("Unverified")).toBeTruthy();
    expect(screen.getByText("2 names, no values")).toBeTruthy();
    expect(await screen.findByText(/M README\.md/)).toBeTruthy();
    expect(await screen.findByText("Removed by the retention rule.")).toBeTruthy();

    // Switch language to Simplified Chinese and verify Log UI + detail labels translate.
    fireEvent.click(screen.getByRole("button", { name: "Switch language (简体中文)" }));
    expect(screen.getByRole("tab", { name: "日志" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "审计日志" })).toBeTruthy();
    expect(screen.getByText("未验证")).toBeTruthy();
    expect(screen.getByText("该内容已按保留策略清理。")).toBeTruthy();

    // Switch back to English for remaining assertions.
    fireEvent.click(screen.getByRole("button", { name: "切换语言 (English)" }));
    expect(screen.getByRole("tab", { name: "Log" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Audit log" })).toBeTruthy();

    // Select the binary transfer row and verify binary notice.
    fireEvent.click(screen.getByRole("button", { name: /\/tmp\/blob\.bin/ }));
    expect(await screen.findByText(/Binary payload.*preview omitted/)).toBeTruthy();

    // Filter by Failed -> queries /api/audit/items?limit=200&result=failed and shows truncated stderr.
    fireEvent.click(screen.getByRole("radio", { name: /Failed/ }));
    await waitFor(() => {
      expect(
        requestedUrls.some((u) => u.includes("/api/audit/items") && u.includes("result=failed")),
      ).toBe(true);
    });
    fireEvent.click(await screen.findByRole("button", { name: /npm test/ }));
    expect(await screen.findByText(/ERR_TEST_FAILED/)).toBeTruthy();
    expect(screen.getByText(/first 256 kB shown/i)).toBeTruthy();

    // Search input debounces and queries with text=git.
    fireEvent.click(screen.getByRole("radio", { name: /All/ }));
    const searchInput = screen.getByRole("searchbox", { name: "Search commands" });
    fireEvent.change(searchInput, { target: { value: "git" } });
    await waitFor(
      () => {
        expect(
          requestedUrls.some((u) => u.includes("/api/audit/items") && u.includes("text=git")),
        ).toBe(true);
      },
      { timeout: 1500 },
    );
  });

  it("shows unavailable alert on /log when audit DB cannot be read and handles 401 session expiry", async () => {
    window.history.replaceState(null, "", "/log");
    const snapshot = makeSnapshot({
      phase: "online",
      configured: true,
      audit: {
        status: { state: "unavailable", code: "unreadable", message: "SQLITE_NOTADB" },
        bytes: 0,
        requests: 0,
      },
    });
    let expireSession = false;

    globalThis.fetch = rstest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/auth/session") {
        return jsonResponse({ authRequired: true, authenticated: true, passwordSource: "file" });
      }
      if (url === "/api/status") {
        return jsonResponse(snapshot);
      }
      if (url === "/api/audit/summary") {
        if (expireSession) return jsonResponse({ error: "Authentication required." }, 401);
        return jsonResponse({
          status: { state: "unavailable", code: "unreadable", message: "SQLITE_NOTADB" },
          bytes: 0,
          records: 0,
          requests: 0,
          oldestAt: null,
          newestAt: null,
          retention: { maxAgeDays: 30, maxBytes: 1024 * 1024 * 1024 },
          counts: null,
        });
      }
      return jsonResponse({ error: "not_found" }, 404);
    }) as typeof fetch;

    render(<App />);

    expect(await screen.findByText(/The audit log file cannot be read\./)).toBeTruthy();
    expect(screen.getByText("SQLITE_NOTADB")).toBeTruthy();
    expect(screen.queryByRole("searchbox", { name: "Search commands" })).toBeNull();

    // Clicking Refresh after session expires transitions back to Unlock Web UI.
    expireSession = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Unlock Web UI")).toBeTruthy();
  });
});
