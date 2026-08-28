import { describe, expect, it, rs } from "@rstest/core";
import type { AppServerClientOptions } from "./app-server-client.js";
import {
  CodexAppServerManager,
  type CodexAppServerConnection,
  type CodexThreadBinding,
} from "./app-server-manager.js";
import type { ThreadStartParams } from "./app-server-protocol.js";

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
  ) {}

  start(): void {
    this.started += 1;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "thread/start") return { thread: { id: this.nextThreadId() } };
    if (method === "thread/resume") {
      return { thread: { id: (params as { threadId: string }).threadId } };
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

    const [threadA, threadB] = await Promise.all([
      manager.openThread(config("rome_alpha"), alpha),
      manager.openThread(config("rome_beta"), beta),
      manager.warmup(),
    ]).then(([a, b]) => [a, b]);

    expect(clients).toHaveLength(1);
    expect(clients[0].started).toBe(1);
    expect(clients[0].requests.filter((request) => request.method === "initialize")).toHaveLength(
      1,
    );
    expect(threadA).not.toBe(threadB);

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
    const threadId = await manager.openThread(config("rome_source"), callbacks);

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
    expect(clients[1].requests[1].params).toMatchObject({
      threadId,
      dynamicTools: [expect.objectContaining({ name: "rome_source" })],
    });
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
