import { describe, expect, it, rs } from "@rstest/core";
import type { AppServerClientOptions } from "./app-server-client.js";
import {
  CodexAppServerManager,
  type CodexAppServerConnection,
  type CodexThreadBinding,
} from "./app-server-manager.js";
import type { ThreadStartParams } from "./app-server-protocol.js";
import { setInstanceTokenInMemory } from "../../lib/instance-identity.js";

interface FakeRequest {
  method: string;
  params: unknown;
}

class FakeConnection implements CodexAppServerConnection {
  readonly requests: FakeRequest[] = [];
  readonly notifications: FakeRequest[] = [];
  started = 0;
  closed = 0;

  constructor(
    readonly options: AppServerClientOptions,
    private readonly nextThreadId: () => string,
    private readonly beforeRequest?: (method: string, params: unknown) => void | Promise<void>,
  ) {}

  start(): void {
    this.started += 1;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    await this.beforeRequest?.(method, params);
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

  it("leaves the credential out and the provider undefined for an unenrolled instance", async () => {
    rs.stubEnv("PANTHEON_BASE_ORIGIN", "");
    rs.stubEnv("PANTHEON_DOMAIN", "");
    setInstanceTokenInMemory(null);
    const { clients, manager } = capture();
    try {
      await manager.warmup();
      expect(clients[0].options.env).not.toHaveProperty("ROME_CREDITS_TOKEN");
      expect(clients[0].options.configArgs).toEqual([
        "-c",
        'shell_environment_policy.exclude=["ROME_CREDITS_TOKEN"]',
      ]);
    } finally {
      manager.close();
      rs.unstubAllEnvs();
    }
  });

  it("forwards a successful final turn before restarting the shared process", async () => {
    rs.stubEnv("PANTHEON_BASE_ORIGIN", "https://cloud.example");
    const clients: FakeConnection[] = [];
    const manager = new CodexAppServerManager({
      createClient: (options) => {
        const client = new FakeConnection(options, () => "thread-restart");
        clients.push(client);
        return client;
      },
    });
    try {
      const callbacks = binding("restart");
      const handle = await manager.openThread(config("rome_restart"), callbacks);
      await manager.requestForThread(handle.threadId, "turn/start", { threadId: handle.threadId });

      const switched = manager.setDefaultProvider("rome_credits");
      await Promise.resolve();
      expect(clients).toHaveLength(1);

      clients[0].options.onNotification("turn/completed", { threadId: handle.threadId });
      await switched;
      expect(clients).toHaveLength(2);
      expect(clients[0].closed).toBe(1);
      expect(callbacks.exits).toHaveLength(0);
      expect(callbacks.notifications).toEqual([
        { method: "turn/completed", params: { threadId: handle.threadId } },
      ]);
      expect(clients[1].options.configArgs).toContain('model_provider="rome_credits"');

      await manager.requestForThread(handle.threadId, "turn/start", { threadId: handle.threadId });
      const resume = clients[1].requests.find((request) => request.method === "thread/resume");
      expect(resume?.params).not.toHaveProperty("modelProvider");
    } finally {
      manager.close();
      rs.unstubAllEnvs();
    }
  });

  it("keeps a starting lazy-resume turn ahead of a payer switch", async () => {
    rs.stubEnv("PANTHEON_BASE_ORIGIN", "https://cloud.example");
    const clients: FakeConnection[] = [];
    let resumeStarted!: () => void;
    const resumeStartedPromise = new Promise<void>((resolve) => {
      resumeStarted = resolve;
    });
    let releaseResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const manager = new CodexAppServerManager({
      createClient: (options) => {
        const beforeRequest =
          clients.length === 1
            ? async (method: string) => {
                if (method !== "thread/resume") return;
                resumeStarted();
                await resumeGate;
              }
            : undefined;
        const client = new FakeConnection(options, () => "thread-resume", beforeRequest);
        clients.push(client);
        return client;
      },
    });
    try {
      const handle = await manager.openThread(config("rome_resume"), binding("resume"));
      await manager.setDefaultProvider("rome_credits");

      const starting = manager.requestForThread(handle.threadId, "turn/start", {
        threadId: handle.threadId,
      });
      await resumeStartedPromise;
      const switched = manager.setDefaultProvider(null);
      await Promise.resolve();
      expect(clients).toHaveLength(2);
      expect(clients[1].closed).toBe(0);

      releaseResume();
      await starting;
      clients[1].options.onNotification("turn/completed", { threadId: handle.threadId });
      await switched;
      expect(clients).toHaveLength(3);
      expect(clients[1].closed).toBe(1);
    } finally {
      manager.close();
      rs.unstubAllEnvs();
    }
  });

  it("settles a cancelled pending switch while forwarding the terminal notification", async () => {
    const clients: FakeConnection[] = [];
    const manager = new CodexAppServerManager({
      createClient: (options) => {
        const client = new FakeConnection(options, () => "thread-cancel");
        clients.push(client);
        return client;
      },
    });
    try {
      const callbacks = binding("cancel");
      const handle = await manager.openThread(config("rome_cancel"), callbacks);
      await manager.requestForThread(handle.threadId, "turn/start", { threadId: handle.threadId });

      const switchingToCredits = manager.setDefaultProvider("rome_credits");
      const revertingToLogin = manager.setDefaultProvider(null);
      clients[0].options.onNotification("turn/completed", { threadId: handle.threadId });
      await Promise.all([switchingToCredits, revertingToLogin]);

      expect(clients).toHaveLength(1);
      expect(callbacks.notifications).toEqual([
        { method: "turn/completed", params: { threadId: handle.threadId } },
      ]);
    } finally {
      manager.close();
    }
  });

  it("waits for the final payer when a replacement initializes during another switch", async () => {
    rs.stubEnv("PANTHEON_BASE_ORIGIN", "https://cloud.example");
    const clients: FakeConnection[] = [];
    let firstInitializeStarted!: () => void;
    const firstInitializeStartedPromise = new Promise<void>((resolve) => {
      firstInitializeStarted = resolve;
    });
    let releaseFirstInitialize!: () => void;
    const firstInitializeGate = new Promise<void>((resolve) => {
      releaseFirstInitialize = resolve;
    });
    let secondInitializeStarted!: () => void;
    const secondInitializeStartedPromise = new Promise<void>((resolve) => {
      secondInitializeStarted = resolve;
    });
    let releaseSecondInitialize!: () => void;
    const secondInitializeGate = new Promise<void>((resolve) => {
      releaseSecondInitialize = resolve;
    });
    const manager = new CodexAppServerManager({
      createClient: (options) => {
        const index = clients.length;
        const beforeRequest =
          index === 1
            ? async (method: string) => {
                if (method !== "initialize") return;
                firstInitializeStarted();
                await firstInitializeGate;
              }
            : index === 2
              ? async (method: string) => {
                  if (method !== "initialize") return;
                  secondInitializeStarted();
                  await secondInitializeGate;
                }
              : undefined;
        const client = new FakeConnection(options, () => "thread-retarget", beforeRequest);
        clients.push(client);
        return client;
      },
    });
    try {
      await manager.warmup();

      let firstSettled = false;
      const firstSwitch = manager.setDefaultProvider("rome_credits").then(() => {
        firstSettled = true;
      });
      await firstInitializeStartedPromise;
      let secondSettled = false;
      const secondSwitch = manager.setDefaultProvider("other").then(() => {
        secondSettled = true;
      });

      releaseFirstInitialize();
      await secondInitializeStartedPromise;
      await Promise.resolve();
      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);

      releaseSecondInitialize();
      await Promise.all([firstSwitch, secondSwitch]);
      expect(clients).toHaveLength(3);
      expect(clients[2].options.configArgs).toContain('model_provider="other"');
    } finally {
      manager.close();
      rs.unstubAllEnvs();
    }
  });

  it("rejects a payer switch that is waiting for an active turn when closing", async () => {
    const clients: FakeConnection[] = [];
    const manager = new CodexAppServerManager({
      createClient: (options) => {
        const client = new FakeConnection(options, () => "thread-close");
        clients.push(client);
        return client;
      },
    });
    const handle = await manager.openThread(config("rome_close"), binding("close"));
    await manager.requestForThread(handle.threadId, "turn/start", { threadId: handle.threadId });

    const switching = manager.setDefaultProvider("rome_credits");
    manager.close();

    await expect(switching).rejects.toThrow("codex app-server manager closed");
    expect(clients[0].closed).toBe(1);
  });
});
