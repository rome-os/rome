import { describe, expect, it, rs } from "@rstest/core";
import type { RomeCreditsView } from "@rome/api-types/rome-credits";
import type { CodexLoginChoice } from "../../../domain/model-login.js";
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
  private currentLogin: CodexLoginChoice = { kind: "subscription" };

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

  login(): CodexLoginChoice {
    return this.currentLogin;
  }

  useLogin(login: CodexLoginChoice): void {
    this.currentLogin = login;
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
  it.each([
    [false, true, false, undefined, "usage_limit_reached"],
    [true, true, false, undefined, "available"],
    [true, false, false, undefined, "usage_limit_reached"],
    [true, false, true, undefined, "available"],
    [true, true, false, "workspace_owner_usage_limit_reached", "usage_limit_reached"],
  ])("gates exhausted subscription windows with credits enabled=%s, available=%s, unlimited=%s, limit=%s", async (enabled, hasCredits, unlimited, rateLimitReachedType, state) => {
    const rpc = new FakeAccountRpc();
    rpc.queue("account/read", { account: { type: "chatgpt", planType: "plus" } });
    rpc.queue("account/rateLimits/read", {
      rateLimits: {
        primary: { usedPercent: 100 },
        secondary: { usedPercent: 100 },
        credits: { hasCredits, unlimited },
        rateLimitReachedType,
      },
    });
    const service = createService(rpc, { allowChatgptCredits: async () => enabled });
    try {
      const report = await service.report();
      expect(report.state).toBe(state);
      expect(report.requiresChatgptCredits === true).toBe(state === "available");
      expect(report.usage?.fiveHour?.usedPercent).toBe(100);
    } finally {
      service.close();
    }
  });

  it("marks only availability that currently requires ChatGPT credits", async () => {
    const rpc = new FakeAccountRpc();
    let enabled = true;
    let now = Date.now();
    const service = createService(rpc, {
      allowChatgptCredits: async () => enabled,
      now: () => now,
    });
    const read = async (usedPercent: number, failed = false, spendControlReached = false) => {
      rpc.queue("account/read", { account: { type: "chatgpt", planType: "plus" } });
      rpc.queue(
        "account/rateLimits/read",
        failed
          ? new Error("Offline")
          : {
              rateLimits: {
                primary: { usedPercent },
                credits: { hasCredits: true, unlimited: false },
                spendControlReached,
              },
            },
      );
      return service.report();
    };
    try {
      expect((await read(100)).requiresChatgptCredits).toBe(true);
      expect((await read(10)).requiresChatgptCredits).not.toBe(true);
      expect((await read(100)).requiresChatgptCredits).toBe(true);
      const failed = await read(100, true);
      expect(failed.state).toBe("usage_limit_reached");
      expect(failed.requiresChatgptCredits).not.toBe(true);
      expect((await read(100, false, true)).state).toBe("usage_limit_reached");
      expect((await read(100)).requiresChatgptCredits).toBe(true);
      enabled = false;
      expect((await read(100)).requiresChatgptCredits).not.toBe(true);
      enabled = true;
      service.refusedTurn({ kind: "usage" });
      const refused = await read(100);
      expect(refused.state).toBe("usage_limit_reached");
      expect(refused.requiresChatgptCredits).not.toBe(true);
      now += USAGE_REFUSAL_HOLD_MS + 1;
      expect((await read(100)).requiresChatgptCredits).toBe(true);
      expect((await read(0)).requiresChatgptCredits).not.toBe(true);
    } finally {
      service.close();
    }
  });

  it.each([
    ["125.75", "125.75"],
    ["0", "0"],
    [null, undefined],
    ["", undefined],
    ["not-a-number", undefined],
    ["Infinity", undefined],
  ])("retains a reported credit balance %s without requiring usage windows", async (balance, expected) => {
    const rpc = new FakeAccountRpc();
    rpc.queue("account/rateLimits/read", {
      rateLimits: {
        credits: { hasCredits: true, unlimited: false, balance },
      },
    });
    const service = createService(rpc);
    try {
      const usage = await service.usage();
      expect(usage?.error).toBeUndefined();
      expect(usage?.credits).toEqual({
        hasCredits: true,
        unlimited: false,
        ...(expected !== undefined ? { balance: expected } : {}),
      });
    } finally {
      service.close();
    }
  });

  it("keeps a real usage refusal even with credits, and applies disabling immediately", async () => {
    const rpc = new FakeAccountRpc();
    let enabled = true;
    let now = Date.now();
    const service = createService(rpc, {
      allowChatgptCredits: async () => enabled,
      now: () => now,
    });
    const read = async () => {
      rpc.queue("account/read", { account: { type: "chatgpt", planType: "plus" } });
      rpc.queue("account/rateLimits/read", {
        rateLimits: {
          primary: { usedPercent: 100 },
          credits: { hasCredits: true, unlimited: false },
        },
      });
      return service.report();
    };
    try {
      expect((await read()).state).toBe("available");
      enabled = false;
      expect((await read()).state).toBe("usage_limit_reached");
      enabled = true;
      expect((await read()).state).toBe("available");
      service.refusedTurn({ kind: "usage" });
      expect((await read()).state).toBe("usage_limit_reached");
      now += USAGE_REFUSAL_HOLD_MS + 1;
      expect((await read()).state).toBe("available");
    } finally {
      service.close();
    }
  });

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
    await expect(service.report()).resolves.toMatchObject({
      state: "usage_limit_reached",
      usageLimitUntil: "2026-11-07T03:00:00.000Z",
    });
    now += USAGE_REFUSAL_HOLD_MS;
    await expect(service.report()).resolves.toMatchObject({ state: "available" });
  });

  it("drops a refusal when an authorization completes, since it may name another account", async () => {
    const rpc = new FakeAccountRpc();
    rpc.queue("account/login/start", {
      type: "chatgptDeviceCode",
      loginId: "device-1",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device",
    });
    rpc.queue("account/read", ...Array(2).fill({ account: { type: "chatgpt", planType: "pro" } }));
    const inThreeDays = new Date(Date.now() + 3 * 24 * 3_600_000).toISOString();
    rpc.queue(
      "account/rateLimits/read",
      {
        rateLimits: {
          primary: { usedPercent: 10 },
          secondary: { usedPercent: 100, resetsAt: Date.parse(inThreeDays) / 1000 },
        },
      },
      new Error("app-server restarting"),
    );
    const service = createService(rpc);
    service.refusedTurn({ kind: "usage" });
    await expect(service.report()).resolves.toMatchObject({ state: "usage_limit_reached" });
    await service.startDeviceAuthorization();
    rpc.notify("account/login/completed", { loginId: "device-1", success: true, error: null });
    // The first read of the new account fails its usage read; the old
    // account's limit does not carry over to it.
    await expect(service.report()).resolves.toMatchObject({
      state: "available",
      usage: { error: "app-server restarting" },
    });
    service.close();
  });

  it("reports a usage read the app-server never answers as an error read", async () => {
    const rpc = new FakeAccountRpc();
    rpc.queue("account/read", { account: { type: "chatgpt", planType: "pro" } });
    const never = new Promise<never>(() => {});
    const request = rpc.request.bind(rpc);
    rpc.request = ((method: string, params?: unknown) =>
      method === "account/rateLimits/read" ? never : request(method, params)) as typeof rpc.request;
    const service = createService(rpc, { usageTimeoutMs: 5 });
    await expect(service.report()).resolves.toMatchObject({
      state: "available",
      usage: { error: "Codex rate limit read timed out after 5ms" },
    });
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

    // On Rome credits Codex hides the account, and the marker keeps
    // the same login reading as needing re-login.
    const noAccount = { account: null, requiresOpenaiAuth: false };
    rpc.queue("account/read", noAccount, noAccount);
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
    const noAccount = { account: null, requiresOpenaiAuth: false };
    rpc.queue("account/read", noAccount, noAccount);
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

describe("SharedCodexAccountService login", () => {
  const CREDITS: CodexLoginChoice = { kind: "rome_credits", credentialId: "romeinst_123" };
  const view = (models?: string[]): RomeCreditsView => ({
    grantedMicros: "5000000",
    balanceMicros: "5000000",
    availableMicros: "5000000",
    enabled: true,
    ...(models ? { models } : {}),
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const onCredits = (readRomeCredits: () => Promise<RomeCreditsView | null>) => {
    const rpc = new FakeAccountRpc();
    const noAccount = { account: null, requiresOpenaiAuth: false };
    rpc.queue("account/read", noAccount, noAccount);
    return { rpc, service: createService(rpc, { readRomeCredits }) };
  };

  it("does not read the gateway on the guardian's own login", async () => {
    const read = rs.fn(async () => view(["gpt-5.6-terra"]));
    const { service } = onCredits(read);
    await service.report();
    expect(service.login()).toEqual({ kind: "subscription" });
    expect(read).not.toHaveBeenCalled();
    service.close();
  });

  it("reads the gateway's list when Rome credits start, and reports it on the login", async () => {
    const { service } = onCredits(async () => view(["gpt-5.6-terra"]));
    service.useLogin(CREDITS);
    expect(service.login()).toEqual({ ...CREDITS, modelsServed: null });
    await flush();
    expect(service.login()).toEqual({ ...CREDITS, modelsServed: ["gpt-5.6-terra"] });
    service.close();
  });

  it("reads the list again on each account read and keeps it when a read fails", async () => {
    const reads: Array<() => RomeCreditsView> = [
      () => view(["gpt-6-luna"]),
      () => view(["gpt-5.6-terra"]),
      () => {
        throw new Error("down");
      },
    ];
    const { service } = onCredits(async () => reads.shift()!());
    service.useLogin(CREDITS);
    await flush();
    await service.report();
    await flush();
    expect(service.login()).toMatchObject({ modelsServed: ["gpt-5.6-terra"] });
    await service.report();
    await flush();
    expect(service.login()).toMatchObject({ modelsServed: ["gpt-5.6-terra"] });
    service.close();
  });

  it("treats a gateway that reports no list as not having said", async () => {
    const { service } = onCredits(async () => view());
    service.useLogin(CREDITS);
    await flush();
    expect(service.login()).toMatchObject({ modelsServed: null });
    service.close();
  });

  it("drops the list and a read in flight when the credential changes", async () => {
    const answers: Array<(v: RomeCreditsView) => void> = [];
    const { service } = onCredits(
      () => new Promise<RomeCreditsView>((resolve) => answers.push(resolve)),
    );
    service.useLogin(CREDITS);
    answers[0]?.(view(["gpt-6.1-sol"]));
    await flush();
    const stale = service.refusedModel();
    service.useLogin({ kind: "rome_credits", credentialId: "romeinst_456" });
    expect(service.login()).toMatchObject({ modelsServed: null });
    answers[1]?.(view(["gpt-6-luna"]));
    await stale;
    expect(service.login()).toMatchObject({ modelsServed: null });
    answers[2]?.(view(["gpt-5.6-terra"]));
    await flush();
    expect(service.login()).toMatchObject({ modelsServed: ["gpt-5.6-terra"] });
    service.close();
  });

  it("re-reads the list after a refused model, then tells its listeners", async () => {
    let served = ["gpt-6.1-sol"];
    const { service } = onCredits(async () => view(served));
    const changed = rs.fn();
    service.onChanged(changed);
    service.useLogin(CREDITS);
    await flush();
    served = ["gpt-5.6-terra"];
    await service.refusedModel();
    expect(service.login()).toMatchObject({ modelsServed: ["gpt-5.6-terra"] });
    expect(changed).toHaveBeenCalledTimes(1);
    service.close();
  });

  it("reads the guardian's own login from the account's last report", async () => {
    const rpc = new FakeAccountRpc();
    rpc.queue("account/read", { account: { type: "apiKey" }, requiresOpenaiAuth: false });
    const service = createService(rpc);
    expect(service.login()).toEqual({ kind: "subscription" });
    await service.report();
    expect(service.login()).toEqual({ kind: "api_credential" });
    service.close();
  });

  it("refuses a login once closed", () => {
    const { service } = onCredits(async () => view());
    service.close();
    expect(() => service.useLogin(CREDITS)).toThrow("closed");
  });
});
