import { afterEach, beforeEach, describe, expect, it, rstest } from "@rstest/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import type { AuditItem, HostSnapshot } from "./types";

const BUCKET_MS = 600_000;
const WINDOW_MS = 24 * 60 * 60 * 1000;

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

// Mirrors the exact record shape persisted by AuditStore in @rome-os/node-core.
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
    envKeys: ["PATH", "HOME"],
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
      content: {
        stdout: {
          size: 11,
          storedBytes: 11,
          sha256: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
        },
      },
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

    expect(await screen.findByText("Unlock Rome Node")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "my-secret-pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));

    expect(await screen.findByText("dev_123")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Lock UI" })).toBeTruthy();
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

  it("toggles execution, renders real AuditStore bucket indices, and loads record.content stdout preview", async () => {
    let snapshot = makeSnapshot({
      phase: "online",
      configured: true,
      deviceId: "dev_999",
      executionEnabled: true,
    });
    const alignedUntil = (Math.floor(Date.now() / BUCKET_MS) + 1) * BUCKET_MS;
    const alignedSince = alignedUntil - WINDOW_MS;
    const activeBucketIndex = 140;
    const expectedBucketStart = alignedSince + activeBucketIndex * BUCKET_MS;
    const auditItemUrls: string[] = [];

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
      if (url.startsWith("/api/audit/stats")) {
        return jsonResponse({
          since: alignedSince,
          until: alignedUntil,
          bucketMs: BUCKET_MS,
          groups: [{ peer: null, bucket: activeBucketIndex, result: "succeeded", count: 3 }],
        });
      }
      if (url.startsWith("/api/audit/items?")) {
        auditItemUrls.push(url);
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

    // Click the populated histogram bar and verify it filters by computed bucket timestamp (not epoch 0).
    const svg = screen.getByRole("img", { name: "24-hour audit request activity" });
    const clickableBar = svg.querySelector("g.cursor-pointer");
    expect(clickableBar).toBeTruthy();
    fireEvent.click(clickableBar!);

    await waitFor(() => {
      expect(
        auditItemUrls.some(
          (u) =>
            u.includes(`since=${expectedBucketStart}`) &&
            u.includes(`until=${expectedBucketStart + BUCKET_MS}`),
        ),
      ).toBe(true);
    });

    fireEvent.click(rowBtn);

    expect(await screen.findByText("hello-rome")).toBeTruthy();
    expect(
      screen.getByText("SHA-256 b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"),
    ).toBeTruthy();
  });
});
