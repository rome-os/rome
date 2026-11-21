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
});
