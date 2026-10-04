import { describe, expect, it, rs } from "@rstest/core";
import { setInstanceTokenInMemory } from "../../lib/instance-identity.js";
import type { AppServerClientOptions } from "./app-server-client.js";
import { SharedCodexAccountService } from "./account-service.js";
import {
  CodexAppServerManager,
  type CodexAppServerConnection,
  type CodexThreadBinding,
} from "./app-server-manager.js";
import { Method, type ThreadStartParams } from "./app-server-protocol.js";

interface FakeRequest {
  method: string;
  params: unknown;
}

class FakeConnection implements CodexAppServerConnection {
  readonly requests: FakeRequest[] = [];
  readonly notifications: FakeRequest[] = [];
  private readonly deferredResponses = new Map<
    string,
    { promise: Promise<unknown>; resolve: (value: unknown) => void }
  >();
  started = 0;
  closed = 0;

  constructor(
    readonly options: AppServerClientOptions,
    private readonly nextThreadId: () => string,
  ) {}

  start(): void {
    this.started += 1;
  }

  defer(method: string): (value: unknown) => void {
    let resolve!: (value: unknown) => void;
    const promise = new Promise<unknown>((resolvePromise) => {
      resolve = resolvePromise;
    });
    this.deferredResponses.set(method, { promise, resolve });
    return (value) => {
      this.deferredResponses.delete(method);
      resolve(value);
    };
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    const deferred = this.deferredResponses.get(method);
    if (deferred) return await deferred.promise;
    if (method === "thread/start") {
      return {
        thread: {
          id: this.nextThreadId(),
          historyMode: (params as ThreadStartParams).historyMode ?? "legacy",
        },
      };
    }
    if (method === "thread/resume") {
      return {
        thread: { id: (params as { threadId: string }).threadId, historyMode: "paginated" },
      };
    }
    if (method === "thread/unsubscribe") return { status: "unsubscribed" };
    if (method === "account/login/start") {
      return {
        loginId: "device-credits",
        userCode: "ABCD-EFGH",
        verificationUrl: "https://auth.openai.com/codex/device",
      };
    }
    return {};
  }

  notify(method: string, params?: unknown): void {
    this.notifications.push({ method, params });
  }

  close(): void {
    this.closed += 1;
  }
}

function config(toolName: string): ThreadStartParams {
  return {
    model: "gpt-5.4-mini",
    cwd: "/workspace",
    historyMode: "paginated",
    dynamicTools: [
      {
        type: "function",
        name: toolName,
        description: toolName,
        inputSchema: { type: "object" },
      },
    ],
  };
}

function binding(label: string): CodexThreadBinding & {
  notifications: Array<{ method: string; params: unknown }>;
  exits: Error[];
} {
  const notifications: Array<{ method: string; params: unknown }> = [];
  const exits: Error[] = [];
  return {
    notifications,
    exits,
    onNotification(method, params) {
      notifications.push({ method, params });
    },
    async onDynamicToolCall(call) {
      return {
        contentItems: [{ type: "inputText", text: `${label}:${call.tool}` }],
        success: true,
      };
    },
    onExit(error) {
      exits.push(error);
    },
  };
}

describe("CodexAppServerManager", () => {
  it.each([
    "http://127.0.0.1:9222",
    "http://chrome:9333",
    undefined,
  ])("keeps browser transport out of the shared agent environment (%s)", async (endpoint) => {
    rs.stubEnv("OPENCLI_CDP_ENDPOINT", endpoint as string);
    rs.stubEnv("ROME_TEST_UNLISTED_ENV", "not-for-child-processes");
    const clients: FakeConnection[] = [];
    const manager = new CodexAppServerManager({
      createClient: (options) => {
        const client = new FakeConnection(options, () => "thread-env");
        clients.push(client);
        return client;
      },
    });

    try {
      await manager.warmup();

      expect(clients).toHaveLength(1);
      const env = clients[0].options.env;
      expect(env).not.toHaveProperty("OPENCLI_CDP_ENDPOINT");
      expect(env).not.toHaveProperty("ROME_TEST_UNLISTED_ENV");
    } finally {
      manager.close();
      rs.unstubAllEnvs();
    }
  });

  it("initializes once and isolates concurrent thread notifications and dynamic calls", async () => {
    const clients: FakeConnection[] = [];
    let threadSequence = 0;
    const manager = new CodexAppServerManager({
      createClient: (options) => {
        const client = new FakeConnection(options, () => `thread-${++threadSequence}`);
        clients.push(client);
        return client;
      },
    });
    const alpha = binding("alpha");
    const beta = binding("beta");

    const [openedA, openedB] = await Promise.all([
      manager.openThread(config("rome_alpha"), alpha),
      manager.openThread(config("rome_beta"), beta),
      manager.warmup(),
    ]).then(([a, b]) => [a, b]);
    const threadA = openedA.threadId;
    const threadB = openedB.threadId;

    expect(clients).toHaveLength(1);
    expect(clients[0].started).toBe(1);
    expect(clients[0].requests.filter((request) => request.method === "initialize")).toHaveLength(
      1,
    );
    expect(threadA).not.toBe(threadB);
    expect(openedA.historyMode).toBe("paginated");
    expect(openedB.historyMode).toBe("paginated");

    clients[0].options.onNotification("item/agentMessage/delta", {
      threadId: threadA,
      turnId: "turn-a",
      delta: "A",
    });
    clients[0].options.onNotification("item/agentMessage/delta", {
      threadId: threadB,
      turnId: "turn-b",
      delta: "B",
    });
    expect(alpha.notifications).toHaveLength(1);
    expect(beta.notifications).toHaveLength(1);
    expect(alpha.notifications[0].params).toMatchObject({ threadId: threadA, delta: "A" });
    expect(beta.notifications[0].params).toMatchObject({ threadId: threadB, delta: "B" });

    const [alphaResult, betaResult] = await Promise.all([
      clients[0].options.onServerRequest("item/tool/call", {
        threadId: threadA,
        turnId: "turn-a",
        callId: "call-a",
        namespace: null,
        tool: "rome_alpha",
        arguments: {},
      }),
      clients[0].options.onServerRequest("item/tool/call", {
        threadId: threadB,
        turnId: "turn-b",
        callId: "call-b",
        namespace: null,
        tool: "rome_beta",
        arguments: {},
      }),
    ]);
    expect(alphaResult).toMatchObject({
      success: true,
      contentItems: [{ text: "alpha:rome_alpha" }],
    });
    expect(betaResult).toMatchObject({
      success: true,
      contentItems: [{ text: "beta:rome_beta" }],
    });

    await manager.unsubscribe(threadA);
    await expect(
      manager.requestForThread(threadB, "turn/start", { threadId: threadB }),
    ).resolves.toEqual({});
    expect(
      clients[0].requests.find(
        (request) =>
          request.method === "thread/unsubscribe" &&
          (request.params as { threadId: string }).threadId === threadA,
      ),
    ).toBeTruthy();
    manager.close();
  });

  it("shares the connection for global requests and routes notifications without a threadId", async () => {
    const clients: FakeConnection[] = [];
    const manager = new CodexAppServerManager({
      createClient: (options) => {
        const client = new FakeConnection(options, () => "thread-1");
        clients.push(client);
        return client;
      },
    });
    const loginCompleted = rs.fn();
    const unsubscribe = manager.onNotification("account/login/completed", loginCompleted);

    await Promise.all([
      manager.warmup(),
      manager.request("account/read", { refreshToken: true }),
      manager.request("account/rateLimits/read"),
    ]);

    expect(clients).toHaveLength(1);
    expect(clients[0].requests.map((request) => request.method)).toEqual([
      "initialize",
      "account/read",
      "account/rateLimits/read",
    ]);

    clients[0].options.onNotification("account/login/completed", {
      loginId: "login-1",
      success: true,
      error: null,
    });
    expect(loginCompleted).toHaveBeenCalledWith({
      loginId: "login-1",
      success: true,
      error: null,
    });

    unsubscribe();
    clients[0].options.onNotification("account/login/completed", {
      loginId: "login-2",
      success: true,
      error: null,
    });
    expect(loginCompleted).toHaveBeenCalledTimes(1);
    manager.close();
  });

  it("fails bindings on exit and lazily resumes them on a new connection", async () => {
    const clients: FakeConnection[] = [];
    let threadSequence = 0;
    const manager = new CodexAppServerManager({
      createClient: (options) => {
        const client = new FakeConnection(options, () => `thread-${++threadSequence}`);
        clients.push(client);
        return client;
      },
    });
    const callbacks = binding("source");
    const globalExit = rs.fn();
    manager.onExit(globalExit);
    const opened = await manager.openThread(config("rome_source"), callbacks);
    const threadId = opened.threadId;

    clients[0].options.onExit?.(137);
    expect(callbacks.exits).toHaveLength(1);
    expect(globalExit).toHaveBeenCalledWith(
      expect.objectContaining({ message: "codex app-server exited (code 137)" }),
    );

    await manager.requestForThread(threadId, "turn/start", { threadId, input: [] });
    expect(clients).toHaveLength(2);
    expect(clients[1].requests.map((request) => request.method)).toEqual([
      "initialize",
      "thread/resume",
      "turn/start",
    ]);
    expect(clients[1].requests[1].params).toMatchObject({ threadId, excludeTurns: true });
    expect(clients[1].requests[1].params).not.toHaveProperty("dynamicTools");
    expect(clients[1].requests[1].params).not.toHaveProperty("historyMode");
    manager.close();
  });

  it("fails closed for a dynamic call whose thread is not bound", async () => {
    let client: FakeConnection | undefined;
    const manager = new CodexAppServerManager({
      createClient: (options) => {
        client = new FakeConnection(options, () => "thread-1");
        return client;
      },
    });
    await manager.warmup();
    const result = await client!.options.onServerRequest("item/tool/call", {
      threadId: "unknown",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "missing",
      arguments: {},
    });
    expect(result).toMatchObject({ success: false });
    manager.close();
  });
});

describe("CodexAppServerManager Rome credits wiring", () => {
  const capture = () => {
    const clients: FakeConnection[] = [];
    const manager = new CodexAppServerManager({
      createClient: (options) => {
        const client = new FakeConnection(options, () => "thread-credits");
        clients.push(client);
        return client;
      },
    });
    return { clients, manager };
  };

  it("passes the instance credential and credits provider definition to the app-server", async () => {
    rs.stubEnv("PANTHEON_BASE_ORIGIN", "https://cloud.example");
    setInstanceTokenInMemory("romeinst_wiring_test");
    const { clients, manager } = capture();
    try {
      await manager.warmup();
      expect(clients[0].options.env.ROME_CREDITS_TOKEN).toBe("romeinst_wiring_test");
      const args = clients[0].options.configArgs ?? [];
      expect(args.some((arg) => arg.includes('base_url="https://cloud.example/v1"'))).toBe(true);
      expect(args.join(" ")).not.toContain("romeinst_wiring_test");
    } finally {
      manager.close();
      setInstanceTokenInMemory(null);
      rs.unstubAllEnvs();
    }
  });

  it("does not publish a client invalidated by successive payer switches during initialize", async () => {
    const clients: FakeConnection[] = [];
    let resolveInitialize!: (value: unknown) => void;
    const manager = new CodexAppServerManager({
      createClient: (options) => {
        const client = new FakeConnection(options, () => "thread-credits");
        if (clients.length === 0) resolveInitialize = client.defer(Method.initialize);
        clients.push(client);
        return client;
      },
    });
    try {
      const initializing = manager.warmup();
      resolveInitialize({});
      manager.setDefaultProvider("rome_credits");
      manager.setDefaultProvider(null);

      await expect(initializing).rejects.toThrow(
        "codex app-server was replaced during initialization",
      );
      await manager.warmup();

      expect(clients).toHaveLength(2);
      expect(clients[0].closed).toBeGreaterThan(0);
    } finally {
      manager.close();
    }
  });

  it("treats a payer change like an exit and lazily resumes idle threads", async () => {
    rs.stubEnv("PANTHEON_BASE_ORIGIN", "https://cloud.example");
    const { clients, manager } = capture();
    const callbacks = binding("credits");
    const exited = rs.fn();
    manager.onExit(exited);
    try {
      const { threadId } = await manager.openThread(config("rome_credits"), callbacks);

      manager.setDefaultProvider("rome_credits");

      expect(clients).toHaveLength(1);
      expect(clients[0].closed).toBe(1);
      expect(callbacks.exits).toEqual([
        expect.objectContaining({ message: "codex app-server exited (code null)" }),
      ]);
      expect(exited).toHaveBeenCalledWith(
        expect.objectContaining({ message: "codex app-server exited (code null)" }),
      );

      await manager.requestForThread(threadId, Method.turnStart, { threadId });

      expect(clients).toHaveLength(2);
      expect(clients[1].options.configArgs).toContain('model_provider="rome_credits"');
      expect(clients[1].requests.map((request) => request.method)).toEqual([
        "initialize",
        "thread/resume",
        "turn/start",
      ]);
    } finally {
      manager.close();
      rs.unstubAllEnvs();
    }
  });

  it("cancels an active sign-in when the payer replaces Codex", async () => {
    const { manager } = capture();
    const accountService = new SharedCodexAccountService(manager);
    try {
      await accountService.startDeviceLogin();

      manager.setDefaultProvider("rome_credits");

      expect(accountService.getLoginState()).toMatchObject({
        running: false,
        lastError: "Codex sign-in stopped: codex app-server exited (code null)",
      });
    } finally {
      accountService.close();
      manager.close();
    }
  });

  it("does not restore a sign-in whose start response raced with a payer switch", async () => {
    const { clients, manager } = capture();
    const accountService = new SharedCodexAccountService(manager);
    try {
      await manager.warmup();
      const resolveLoginStart = clients[0].defer(Method.accountLoginStart);
      const starting = accountService.startDeviceLogin();
      await rs.waitFor(() => {
        expect(
          clients[0].requests.some((request) => request.method === Method.accountLoginStart),
        ).toBe(true);
      });

      resolveLoginStart({
        loginId: "device-credits",
        userCode: "ABCD-EFGH",
        verificationUrl: "https://auth.openai.com/codex/device",
      });
      manager.setDefaultProvider("rome_credits");

      await expect(starting).rejects.toThrow("Codex login was canceled");
      expect(accountService.getLoginState()).toMatchObject({
        running: false,
        lastError: "Codex sign-in stopped: codex app-server exited (code null)",
      });
    } finally {
      accountService.close();
      manager.close();
    }
  });
});
