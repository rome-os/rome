import { describe, expect, it, rs } from "@rstest/core";
import {
  SharedCodexAccountService,
  type SharedCodexAccountServiceOptions,
} from "./account-service.js";

interface RequestRecord {
  method: string;
  params: unknown;
}

class FakeAccountRpc {
  readonly requests: RequestRecord[] = [];
  readonly responses = new Map<string, unknown[]>();
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>();
  private readonly exitListeners = new Set<(error: Error) => void>();

  queue(method: string, ...responses: unknown[]): void {
    this.responses.set(method, [...(this.responses.get(method) ?? []), ...responses]);
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    const queue = this.responses.get(method) ?? [];
    const response = queue.shift();
    if (response instanceof Error) throw response;
    return response as T;
  }

  onNotification(method: string, listener: (params: unknown) => void): () => void {
    let listeners = this.listeners.get(method);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(method, listeners);
    }
    listeners.add(listener);
    return () => listeners?.delete(listener);
  }

  onExit(listener: (error: Error) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  notify(method: string, params: unknown): void {
    for (const listener of this.listeners.get(method) ?? []) listener(params);
  }

  exit(error: Error): void {
    for (const listener of this.exitListeners) listener(error);
  }
}

function createService(
  rpc: FakeAccountRpc,
  overrides: SharedCodexAccountServiceOptions = {},
): SharedCodexAccountService {
  return new SharedCodexAccountService(rpc, {
    usageCachePaths: [],
    readFileStatus: async () => ({
      loggedIn: true,
      authMode: "chatgpt",
      planType: "plus",
      accountType: "plus",
      email: "file@example.com",
    }),
    ...overrides,
  });
}

describe("SharedCodexAccountService", () => {
  it("reads account status and rate limits through process-global shared RPCs", async () => {
    const rpc = new FakeAccountRpc();
    rpc.queue("account/read", {
      account: { type: "chatgpt", email: "live@example.com", planType: "pro" },
      requiresOpenaiAuth: true,
    });
    rpc.queue("account/rateLimits/read", {
      rateLimits: {
        primary: { usedPercent: 12, resetsAt: 1_779_250_972 },
        secondary: { usedPercent: 34 },
      },
    });
    const service = createService(rpc);

    await expect(service.getStatus()).resolves.toEqual({
      loggedIn: true,
      authMode: "chatgpt",
      planType: "pro",
      accountType: "pro",
      email: "live@example.com",
    });
    await expect(service.getUsage()).resolves.toMatchObject({
      source: "codex app-server",
      fiveHour: { usedPercent: 12, remainingPercent: 88 },
      sevenDay: { usedPercent: 34, remainingPercent: 66 },
    });
    expect(rpc.requests).toEqual([
      { method: "account/read", params: { refreshToken: true } },
      { method: "account/rateLimits/read", params: undefined },
    ]);
    service.close();
  });

  it("classifies the current single-window rate-limit response by duration", async () => {
    const rpc = new FakeAccountRpc();
    rpc.queue("account/rateLimits/read", {
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          primary: {
            usedPercent: 25,
            windowDurationMins: 10_080,
            resetsAt: 1_787_196_936,
          },
          secondary: null,
          planType: "pro",
        },
      },
    });
    const service = createService(rpc);

    const usage = await service.getUsage();

    expect(usage).toMatchObject({
      source: "codex app-server",
      sevenDay: {
        usedPercent: 25,
        remainingPercent: 75,
        resetsAt: "2026-08-20T03:35:36.000Z",
      },
    });
    expect(usage?.fiveHour).toBeUndefined();
    service.close();
  });

  it("falls back to the auth file and marks a revoked refresh token", async () => {
    const rpc = new FakeAccountRpc();
    rpc.queue("account/read", new Error("refresh token was revoked; log out and sign in again"));
    const markAuthRevoked = rs.fn(async () => {});
    const service = createService(rpc, {
      markAuthRevoked,
      readFileStatus: async () => ({
        loggedIn: false,
        authMode: "chatgpt",
        planType: "plus",
        needsReauth: true,
      }),
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      loggedIn: false,
      authMode: "chatgpt",
      needsReauth: true,
    });
    expect(markAuthRevoked).toHaveBeenCalledTimes(1);
    service.close();
  });

  it("owns browser and device login attempts on the same RPC connection", async () => {
    const rpc = new FakeAccountRpc();
    rpc.queue("account/login/start", {
      type: "chatgpt",
      loginId: "browser-1",
      authUrl: "https://auth.openai.com/browser-1",
    });
    rpc.queue("account/login/cancel", { status: "canceled" });
    rpc.queue("account/login/start", {
      type: "chatgptDeviceCode",
      loginId: "device-1",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device",
    });
    const service = createService(rpc);
    const changed = rs.fn();
    service.onAccountChanged(changed);

    await expect(service.startBrowserLogin()).resolves.toMatchObject({
      loginId: "browser-1",
      authUrl: "https://auth.openai.com/browser-1",
    });
    expect(service.getLoginState()).toMatchObject({ running: true, mode: "browser" });

    await expect(service.startDeviceLogin()).resolves.toMatchObject({
      loginId: "device-1",
      userCode: "ABCD-EFGH",
    });
    expect(service.getLoginState()).toEqual({
      running: true,
      mode: "device",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device",
      lastError: null,
    });
    expect(rpc.requests.map((request) => request.method)).toEqual([
      "account/login/start",
      "account/login/cancel",
      "account/login/start",
    ]);

    rpc.notify("account/login/completed", {
      loginId: "device-1",
      success: true,
      error: null,
    });
    expect(service.getLoginState()).toMatchObject({ running: false, lastError: null });
    expect(changed).toHaveBeenCalledTimes(1);
    service.close();
  });

  it("surfaces failed login completion and emits account updates", async () => {
    const rpc = new FakeAccountRpc();
    rpc.queue("account/login/start", {
      loginId: "device-1",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device",
    });
    const service = createService(rpc);
    const changed = rs.fn();
    service.onAccountChanged(changed);
    await service.startDeviceLogin();

    rpc.notify("account/login/completed", {
      loginId: "device-1",
      success: false,
      error: "device authorization declined",
    });
    expect(service.getLoginState()).toMatchObject({
      running: false,
      lastError: "device authorization declined",
    });

    rpc.notify("account/updated", { authMode: "chatgpt", planType: "plus" });
    expect(changed).toHaveBeenCalledTimes(2);
    service.close();
  });

  it("logs out through the shared RPC and clears an active login", async () => {
    const rpc = new FakeAccountRpc();
    rpc.queue("account/login/start", {
      loginId: "device-1",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device",
    });
    rpc.queue("account/login/cancel", { status: "canceled" });
    rpc.queue("account/logout", {});
    const service = createService(rpc);
    const changed = rs.fn();
    service.onAccountChanged(changed);
    await service.startDeviceLogin();

    await service.logout();

    expect(service.getLoginState().running).toBe(false);
    expect(rpc.requests.map((request) => request.method)).toEqual([
      "account/login/start",
      "account/login/cancel",
      "account/logout",
    ]);
    expect(changed).toHaveBeenCalledTimes(1);
    service.close();
  });

  it("cancels a login that is still waiting for its start response", async () => {
    const rpc = new FakeAccountRpc();
    let resolveStart!: (value: unknown) => void;
    rpc.queue(
      "account/login/start",
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    rpc.queue("account/login/cancel", { status: "canceled" });
    const service = createService(rpc);

    const starting = service.startDeviceLogin();
    await rs.waitFor(() => {
      expect(rpc.requests.some((request) => request.method === "account/login/start")).toBe(true);
    });
    await service.cancelLogin();
    resolveStart({
      loginId: "device-1",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device",
    });

    await expect(starting).rejects.toThrow("Codex login was canceled");
    expect(rpc.requests.map((request) => request.method)).toEqual([
      "account/login/start",
      "account/login/cancel",
    ]);
    expect(service.getLoginState().running).toBe(false);
    service.close();
  });

  it("handles a completion notification delivered before the start promise resumes", async () => {
    const rpc = new FakeAccountRpc();
    let resolveStart!: (value: unknown) => void;
    rpc.queue(
      "account/login/start",
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    const service = createService(rpc);
    const changed = rs.fn();
    service.onAccountChanged(changed);

    const starting = service.startDeviceLogin();
    await rs.waitFor(() => {
      expect(rpc.requests.some((request) => request.method === "account/login/start")).toBe(true);
    });
    rpc.notify("account/login/completed", {
      loginId: "device-1",
      success: true,
      error: null,
    });
    resolveStart({
      loginId: "device-1",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device",
    });

    await expect(starting).resolves.toMatchObject({ loginId: "device-1" });
    expect(service.getLoginState().running).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    service.close();
  });

  it("clears an active login when the shared app-server exits", async () => {
    const rpc = new FakeAccountRpc();
    rpc.queue("account/login/start", {
      loginId: "device-1",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device",
    });
    const service = createService(rpc);
    const changed = rs.fn();
    service.onAccountChanged(changed);
    await service.startDeviceLogin();

    rpc.exit(new Error("codex app-server exited (code 137)"));

    expect(service.getLoginState()).toMatchObject({
      running: false,
      lastError: "Codex sign-in stopped: codex app-server exited (code 137)",
    });
    expect(changed).toHaveBeenCalledTimes(1);
    service.close();
  });
});
