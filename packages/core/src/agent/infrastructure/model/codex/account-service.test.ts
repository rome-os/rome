import { describe, expect, it, rs } from "@rstest/core";
import { USAGE_REFUSAL_HOLD_MS } from "../refused-turn.js";
import {
  RESTRICTED_PLAN_DENIED_MODELS,
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

    await expect(service.status()).resolves.toEqual({
      loggedIn: true,
      authMode: "chatgpt",
      planType: "pro",
      accountType: "pro",
      email: "live@example.com",
      usageLimited: true,
    });
    await expect(service.usage()).resolves.toMatchObject({
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

  it("reports what the plan withholds and whether the provider limits usage", async () => {
    const rpc = new FakeAccountRpc();
    rpc.queue(
      "account/read",
      { account: { type: "chatgpt", email: "free@example.com", planType: "free" } },
      { account: { type: "chatgpt", email: "plus@example.com", planType: "plus" } },
      { account: { type: "apiKey" } },
    );
    const service = createService(rpc);
    await expect(service.status()).resolves.toMatchObject({
      usageLimited: true,
      modelsDenied: RESTRICTED_PLAN_DENIED_MODELS,
    });
    const plus = await service.status();
    expect(plus).toMatchObject({ usageLimited: true });
    expect(plus).not.toHaveProperty("modelsDenied");
    const apiKey = await service.status();
    expect(apiKey).toMatchObject({ usageLimited: false });
    expect(apiKey).not.toHaveProperty("modelsDenied");
  });

  it("holds a refused turn until a usage read after the hold shows capacity", async () => {
    let now = Date.parse("2026-11-07T00:00:00.000Z");
    const rpc = new FakeAccountRpc();
    const capacity = {
      rateLimits: { primary: { usedPercent: 10 }, secondary: { usedPercent: 10 } },
    };
    rpc.queue("account/read", ...Array(2).fill({ account: { type: "chatgpt", planType: "pro" } }));
    rpc.queue("account/rateLimits/read", capacity, capacity);
    const service = createService(rpc, { now: () => now });
    const changed = rs.fn();
    service.onChanged(changed);

    service.refusedTurn({ kind: "usage", until: "2026-11-07T03:00:00.000Z" });
    expect(changed).toHaveBeenCalledTimes(1);
    // The usage read in the hold shows capacity but describes the account
    // before the refused turn.
    await expect(service.availability()).resolves.toMatchObject({
      state: "usage_limit_reached",
      usageLimitUntil: "2026-11-07T03:00:00.000Z",
    });
    now += USAGE_REFUSAL_HOLD_MS;
    await expect(service.availability()).resolves.toMatchObject({ state: "available" });
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

    const usage = await service.usage();

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

    await expect(service.status()).resolves.toMatchObject({
      loggedIn: false,
      authMode: "chatgpt",
      needsReauth: true,
    });
    expect(markAuthRevoked).toHaveBeenCalledTimes(1);
    service.close();
  });

  it("marks the login when account/read fails workspace routing discovery", async () => {
    const rpc = new FakeAccountRpc();
    rpc.queue("account/read", new Error("workspace routing discovery unauthorized (401)"));
    let marked = false;
    const markAuthRevoked = rs.fn(async () => {
      marked = true;
    });
    const service = createService(rpc, {
      markAuthRevoked,
      readFileStatus: async () =>
        marked
          ? { loggedIn: false, authMode: "chatgpt", planType: "plus", needsReauth: true }
          : { loggedIn: true, authMode: "chatgpt", planType: "plus" },
    });

    await expect(service.status()).resolves.toMatchObject({
      loggedIn: false,
      authMode: "chatgpt",
      needsReauth: true,
    });
    expect(markAuthRevoked).toHaveBeenCalledTimes(1);
    service.close();
  });

  it("marks a saved ChatGPT login that Codex reports as signed out", async () => {
    const rpc = new FakeAccountRpc();
    rpc.queue("account/read", { account: null, requiresOpenaiAuth: true });
    let marked = false;
    const markAuthRevoked = rs.fn(async () => {
      marked = true;
    });
    const service = createService(rpc, {
      markAuthRevoked,
      readFileStatus: async () =>
        marked
          ? { loggedIn: false, authMode: "chatgpt", planType: "plus", needsReauth: true }
          : { loggedIn: true, authMode: "chatgpt", planType: "plus" },
    });

    await expect(service.status()).resolves.toMatchObject({
      loggedIn: false,
      authMode: "chatgpt",
      needsReauth: true,
    });
    expect(markAuthRevoked).toHaveBeenCalledTimes(1);

    // Under the credits payer Codex hides the account, and the marker keeps
    // the same login reading as needing re-login.
    rpc.queue("account/read", { account: null, requiresOpenaiAuth: false });
    await expect(service.status()).resolves.toMatchObject({
      loggedIn: false,
      needsReauth: true,
    });
    expect(markAuthRevoked).toHaveBeenCalledTimes(1);
    service.close();
  });

  it("does not mark a signed-out account that has no saved ChatGPT login", async () => {
    for (const fileStatus of [
      { loggedIn: false, authMode: null },
      { loggedIn: true, authMode: "apikey", accountType: "api_key" },
    ] as const) {
      const rpc = new FakeAccountRpc();
      rpc.queue("account/read", { account: null, requiresOpenaiAuth: true });
      const markAuthRevoked = rs.fn(async () => {});
      const service = createService(rpc, {
        markAuthRevoked,
        readFileStatus: async () => fileStatus,
      });

      await expect(service.status()).resolves.toEqual({
        loggedIn: false,
        authMode: fileStatus.authMode,
      });
      expect(markAuthRevoked).not.toHaveBeenCalled();
      service.close();
    }
  });

  it("does not mark the saved ChatGPT login while a login is in progress", async () => {
    const rpc = new FakeAccountRpc();
    rpc.queue("account/login/start", {
      loginId: "device-1",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device",
    });
    rpc.queue("account/read", { account: null, requiresOpenaiAuth: true });
    const markAuthRevoked = rs.fn(async () => {});
    const service = createService(rpc, { markAuthRevoked });

    await service.startDeviceAuthorization();
    await expect(service.status()).resolves.toEqual({
      loggedIn: false,
      authMode: "chatgpt",
    });
    expect(markAuthRevoked).not.toHaveBeenCalled();
    service.close();
  });

  it("does not mark tokens from a login that finished during account/read", async () => {
    const rpc = new FakeAccountRpc();
    let answerRead!: (value: unknown) => void;
    rpc.queue(
      "account/read",
      new Promise((resolve) => {
        answerRead = resolve;
      }),
    );
    rpc.queue("account/login/start", {
      loginId: "device-1",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device",
    });
    const markAuthRevoked = rs.fn(async () => {});
    const service = createService(rpc, { markAuthRevoked });

    const status = service.status();
    await service.startDeviceAuthorization();
    rpc.notify("account/login/completed", { loginId: "device-1", success: true, error: null });
    answerRead({ account: null, requiresOpenaiAuth: true });

    await expect(status).resolves.toEqual({ loggedIn: false, authMode: "chatgpt" });
    expect(markAuthRevoked).not.toHaveBeenCalled();
    service.close();
  });

  it("does not mark tokens from a login that finished during a failed account/read", async () => {
    const rpc = new FakeAccountRpc();
    let failRead!: (error: Error) => void;
    rpc.queue(
      "account/read",
      new Promise((_resolve, reject) => {
        failRead = reject;
      }),
    );
    rpc.queue("account/login/start", {
      loginId: "device-1",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device",
    });
    const markAuthRevoked = rs.fn(async () => {});
    const service = createService(rpc, { markAuthRevoked });

    const status = service.status();
    await service.startDeviceAuthorization();
    rpc.notify("account/login/completed", { loginId: "device-1", success: true, error: null });
    failRead(new Error("workspace routing discovery unauthorized (401)"));

    await expect(status).resolves.toMatchObject({ loggedIn: true, authMode: "chatgpt" });
    expect(markAuthRevoked).not.toHaveBeenCalled();
    service.close();
  });

  it("uses auth.json when the credits default hides the guardian's OpenAI account", async () => {
    const rpc = new FakeAccountRpc();
    rpc.queue("account/read", { account: null, requiresOpenaiAuth: false });
    const service = createService(rpc);

    await expect(service.status()).resolves.toMatchObject({
      loggedIn: true,
      authMode: "chatgpt",
      planType: "plus",
      email: "file@example.com",
    });
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
    service.onChanged(changed);

    await expect(service.startBrowserAuthorization()).resolves.toMatchObject({
      authorizationId: "browser-1",
      authUrl: "https://auth.openai.com/browser-1",
    });
    expect(service.authorizationState()).toMatchObject({ running: true, mode: "browser" });

    await expect(service.startDeviceAuthorization()).resolves.toMatchObject({
      authorizationId: "device-1",
      userCode: "ABCD-EFGH",
    });
    expect(service.authorizationState()).toEqual({
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
    expect(service.authorizationState()).toMatchObject({ running: false, lastError: null });
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
    service.onChanged(changed);
    await service.startDeviceAuthorization();

    rpc.notify("account/login/completed", {
      loginId: "device-1",
      success: false,
      error: "device authorization declined",
    });
    expect(service.authorizationState()).toMatchObject({
      running: false,
      lastError: "device authorization declined",
    });

    rpc.notify("account/updated", { authMode: "chatgpt", planType: "plus" });
    expect(changed).toHaveBeenCalledTimes(2);
    service.close();
  });

  it.each([
    "account/updated",
    "account/rateLimits/updated",
  ])("preserves %s notifications and unsubscribes on close", (notification) => {
    const rpc = new FakeAccountRpc();
    const service = createService(rpc);
    const changed = rs.fn();
    service.onChanged(changed);

    rpc.notify(notification, {});
    expect(changed).toHaveBeenCalledTimes(1);
    service.close();
    rpc.notify(notification, {});
    expect(changed).toHaveBeenCalledTimes(1);
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
    service.onChanged(changed);
    await service.startDeviceAuthorization();

    await service.revoke();

    expect(service.authorizationState().running).toBe(false);
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

    const starting = service.startDeviceAuthorization();
    await rs.waitFor(() => {
      expect(rpc.requests.some((request) => request.method === "account/login/start")).toBe(true);
    });
    await service.cancelAuthorization();
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
    expect(service.authorizationState().running).toBe(false);
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
    service.onChanged(changed);

    const starting = service.startDeviceAuthorization();
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

    await expect(starting).resolves.toMatchObject({ authorizationId: "device-1" });
    expect(service.authorizationState().running).toBe(false);
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
    service.onChanged(changed);
    await service.startDeviceAuthorization();

    rpc.exit(new Error("codex app-server exited (code 137)"));

    expect(service.authorizationState()).toMatchObject({
      running: false,
      lastError: "Codex sign-in stopped: codex app-server exited (code 137)",
    });
    expect(changed).toHaveBeenCalledTimes(1);
    service.close();
  });
});
