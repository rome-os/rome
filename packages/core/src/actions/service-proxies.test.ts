import { afterEach, describe, expect, it, rs } from "@rstest/core";
import {
  AppManagerProxy,
  BackendTurnRunnerProxy,
  ChannelsServiceProxy,
  NotifyServiceProxy,
  FeedbackServiceProxy,
} from "./service-proxies.js";
import {
  runWithHookInvocationContext,
  runWithoutHookInvocationContext,
  type HookInvocationContext,
} from "../core/hook-recursion.js";
import { WorkerRpcServer, type WorkerRpcServices } from "./worker-rpc.js";
import { AppLifecycleService } from "../apps/lifecycle-service.js";
import { getCurrentHookInvocationContext } from "../core/hook-recursion.js";
import {
  setWorkerRpcInProcessDispatcher,
  WorkerRpcDisconnectError,
  WorkerRpcSendError,
  WorkerRpcTimeoutError,
} from "./worker-rpc-client.js";

describe("ChannelsServiceProxy", () => {
  const originalSend = process.send;

  afterEach(() => {
    process.send = originalSend;
    setWorkerRpcInProcessDispatcher(null);
  });

  const wireLine = {
    channel: "discord",
    direction: "inbound",
    messageId: "message-1",
    conversationId: "conversation-1",
    senderId: "user-1",
    text: "hello",
    attachments: [],
    timestamp: "2026-08-04T10:00:00.000Z",
  };

  it("sends a read's since as an instant and rehydrates the answer", async () => {
    process.send = undefined;
    const calls: Array<{ method: string; params: unknown }> = [];
    setWorkerRpcInProcessDispatcher(async (method, params) => {
      calls.push({ method, params });
      return [wireLine];
    });
    const proxy = new ChannelsServiceProxy();
    const since = new Date("2026-08-04T09:00:00.000Z");

    const queried = await proxy.query("discord", { since, limit: 2 });

    expect(queried[0]?.timestamp).toBeInstanceOf(Date);
    expect(queried[0]?.timestamp.toISOString()).toBe("2026-08-04T10:00:00.000Z");
    expect(calls).toEqual([
      {
        method: "channels.query",
        params: { channel: "discord", since: "2026-08-04T09:00:00.000Z", limit: 2 },
      },
    ]);
  });

  it("sends by channel name", async () => {
    process.send = undefined;
    const calls: unknown[] = [];
    setWorkerRpcInProcessDispatcher(async (_method, params) => {
      calls.push(params);
      return { messageId: "m1" };
    });
    const proxy = new ChannelsServiceProxy();

    await proxy.send("discord", "c1" as never, { text: "a" });

    expect(calls).toEqual([{ channel: "discord", conversationId: "c1", message: { text: "a" } }]);
  });

  // TODO(0.8): remove with the migration getters.
  it("tells an app built on 0.6 how to migrate off history and connectionIds", async () => {
    process.send = undefined;
    setWorkerRpcInProcessDispatcher(async () => [{ name: "discord", sendable: true }]);
    const proxy = new ChannelsServiceProxy();

    const [summary] = await proxy.list();

    expect(summary).toEqual({ name: "discord", sendable: true });
    expect(() => (proxy as unknown as { history: unknown }).history).toThrow(
      "ChannelsService.history was removed in @rome-os/app-runtime 0.7",
    );
    expect(() => (summary as unknown as { connectionIds: unknown }).connectionIds).toThrow(
      "ChannelSummary.connectionIds was removed in @rome-os/app-runtime 0.7",
    );
  });
});

describe("BackendTurnRunnerProxy", () => {
  const originalSend = process.send;

  afterEach(() => {
    rs.useRealTimers();
    process.send = originalSend;
    setWorkerRpcInProcessDispatcher(null);
  });

  it("allows a backend turn 30 minutes to finish", async () => {
    rs.useFakeTimers();
    process.send = undefined;
    setWorkerRpcInProcessDispatcher(() => new Promise<never>(() => {}));

    const promise = new BackendTurnRunnerProxy().runAndDeliver({
      agentName: "main",
      sessionId: "agent-session-1",
      channel: "webchat",
      threadId: "thread-1",
      prompt: "continue",
    });
    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await rs.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(settled).toBe(false);

    const rejection = expect(promise).rejects.toThrow(
      "WorkerRPC timeout: session.continue (1800000ms)",
    );
    await rs.advanceTimersByTimeAsync(20 * 60 * 1000);
    await rejection;
  });
});

describe("NotifyServiceProxy", () => {
  const originalSend = process.send;

  afterEach(() => {
    rs.useRealTimers();
    // getWorkerRpc() only uses the in-process dispatcher when process.send is
    // undefined (Rstest's forks pool otherwise leaves it defined); restore both.
    process.send = originalSend;
    setWorkerRpcInProcessDispatcher(null);
  });

  it("does not time out a ~120s dispatch under the 150s RPC budget", async () => {
    rs.useFakeTimers();
    process.send = undefined;
    setWorkerRpcInProcessDispatcher(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ kind: "ok", attempted: 1, sent: 1, failed: 0 }), 120_000);
        }),
    );

    const promise = new NotifyServiceProxy().send();
    await rs.advanceTimersByTimeAsync(120_000);

    await expect(promise).resolves.toEqual({
      kind: "ok",
      attempted: 1,
      sent: 1,
      failed: 0,
    });
  });

  it("configures a 150s RPC timeout, not the 30s WorkerRPC default", async () => {
    rs.useFakeTimers();
    process.send = undefined;
    setWorkerRpcInProcessDispatcher(() => new Promise<never>(() => {})); // never settles

    const promise = new NotifyServiceProxy().send();
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    // Past the 30s default: if the timeout weren't overridden, it would fire here.
    await rs.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false);

    // At 150s the RPC times out; the proxy converts that transport failure.
    await rs.advanceTimersByTimeAsync(120_000);
    await expect(promise).resolves.toEqual({ kind: "outcome_unknown" });
  });

  it("returns the dispatched SendOutcome", async () => {
    process.send = undefined;
    setWorkerRpcInProcessDispatcher(async (method) => {
      expect(method).toBe("notify.send");
      return { kind: "ok", attempted: 1, sent: 1, failed: 0 };
    });

    expect(await new NotifyServiceProxy().send()).toEqual({
      kind: "ok",
      attempted: 1,
      sent: 1,
      failed: 0,
    });
  });

  it.each([
    ["a custom body", { body: "Build failed" } as const, { body: "Build failed" }],
    ["an empty-string body", { body: "" } as const, { body: "" }],
    ["no content (no arg)", undefined, {}],
  ])("dispatches notify.send with %s as RPC params", async (_label, content, expectedParams) => {
    process.send = undefined;
    let seenParams: unknown;
    setWorkerRpcInProcessDispatcher(async (method, params) => {
      expect(method).toBe("notify.send");
      seenParams = params;
      return { kind: "ok", attempted: 1, sent: 1, failed: 0 };
    });

    await new NotifyServiceProxy().send(content);
    expect(seenParams).toEqual(expectedParams);
  });

  // The three delivery-uncertain worker→main transport failures all convert to
  // outcome_unknown; a later caller must not retry them.
  it.each([
    new WorkerRpcTimeoutError("notify.send", 150_000),
    new WorkerRpcDisconnectError(),
    new WorkerRpcSendError("notify.send", new Error("EPIPE")),
  ])("converts %s to outcome_unknown", async (err) => {
    process.send = undefined;
    setWorkerRpcInProcessDispatcher(async () => {
      throw err;
    });

    expect(await new NotifyServiceProxy().send()).toEqual({ kind: "outcome_unknown" });
  });

  it("still maps a transport failure to outcome_unknown when a body was sent", async () => {
    // The error mapping must be independent of the content arg: a custom-body
    // send that times out is just as delivery-ambiguous as a zero-arg one.
    process.send = undefined;
    setWorkerRpcInProcessDispatcher(async () => {
      throw new WorkerRpcTimeoutError("notify.send", 150_000);
    });

    expect(await new NotifyServiceProxy().send({ body: "Build failed" })).toEqual({
      kind: "outcome_unknown",
    });
  });

  it("rethrows a non-transport error (a genuine handler bug)", async () => {
    process.send = undefined;
    setWorkerRpcInProcessDispatcher(async () => {
      throw new Error("handler blew up");
    });

    await expect(new NotifyServiceProxy().send()).rejects.toThrow("handler blew up");
  });

  it("throws when there is no IPC channel and no dispatcher", async () => {
    process.send = undefined;
    setWorkerRpcInProcessDispatcher(null);

    await expect(new NotifyServiceProxy().send()).rejects.toThrow(
      /not running in a Node\.js child process/,
    );
  });
});

describe("AppManagerProxy", () => {
  const originalSend = process.send;

  afterEach(() => {
    process.send = originalSend;
    setWorkerRpcInProcessDispatcher(null);
  });

  const chain: HookInvocationContext = {
    rootInvocationId: "root-1",
    depth: 1,
    chain: [{ hookType: "app", appId: "looper", hookName: "app-started" }],
  };

  it("sends the caller's hook chain with every lifecycle call", async () => {
    process.send = undefined;
    const calls: Array<{ method: string; params: unknown }> = [];
    setWorkerRpcInProcessDispatcher(async (method, params) => {
      calls.push({ method, params });
      return {};
    });
    const proxy = new AppManagerProxy();

    await runWithHookInvocationContext(chain, async () => {
      await proxy.install({ source: { mode: "bundle", path: "/tmp/app" } });
      await proxy.uninstall({ appId: "looper" });
      await proxy.setEnabled({ appId: "looper", enabled: true });
    });
    await proxy.setEnabled({ appId: "looper", enabled: false });

    expect(calls).toEqual([
      {
        method: "apps.install",
        params: { source: { mode: "bundle", path: "/tmp/app" }, hookInvocationContext: chain },
      },
      { method: "apps.uninstall", params: { appId: "looper", hookInvocationContext: chain } },
      {
        method: "apps.setEnabled",
        params: { appId: "looper", enabled: true, hookInvocationContext: chain },
      },
      { method: "apps.setEnabled", params: { appId: "looper", enabled: false } },
    ]);
  });

  it("delivers the chain to the app manager across the worker hop", async () => {
    process.send = undefined;
    let seen: HookInvocationContext | undefined;
    const appManager = {
      setEnabled: rs.fn(async () => {
        seen = getCurrentHookInvocationContext();
      }),
    };
    const server = new WorkerRpcServer({
      appLifecycle: new AppLifecycleService(appManager as never, {} as never, {} as never),
    } as unknown as WorkerRpcServices);
    // A real worker hop serializes the params and loses the caller's async
    // context. Model both, so only the params can carry the chain.
    setWorkerRpcInProcessDispatcher((method, params) =>
      runWithoutHookInvocationContext(() =>
        server.dispatchInProcess(method, JSON.parse(JSON.stringify(params))),
      ),
    );

    await runWithHookInvocationContext(chain, () =>
      new AppManagerProxy().setEnabled({ appId: "looper", enabled: true }),
    );

    expect(appManager.setEnabled).toHaveBeenCalledWith("looper", true);
    expect(seen).toEqual(chain);
  });
});

describe("FeedbackServiceProxy", () => {
  const originalSend = process.send;
  const input = {
    category: "bug" as const,
    summary: "Broken",
    details: "Repro",
    reporter: { kind: "agent" as const, agentName: "main" },
  };
  afterEach(() => {
    process.send = originalSend;
    setWorkerRpcInProcessDispatcher(null);
  });
  it("forwards runtime provenance and returns only the classified outcome", async () => {
    process.send = undefined;
    setWorkerRpcInProcessDispatcher(async (method, params) => {
      expect(method).toBe("feedback.send");
      expect(params).toEqual(input);
      return { kind: "ok" };
    });
    expect(await new FeedbackServiceProxy().send(input)).toEqual({ kind: "ok" });
  });
  it.each([
    new WorkerRpcTimeoutError("feedback.send", 30_000),
    new WorkerRpcDisconnectError(),
    new WorkerRpcSendError("feedback.send", new Error("EPIPE")),
  ])("classifies transport uncertainty without retry: %s", async (err) => {
    process.send = undefined;
    const dispatch = rs.fn(async () => {
      throw err;
    });
    setWorkerRpcInProcessDispatcher(dispatch);
    expect(await new FeedbackServiceProxy().send(input)).toEqual({ kind: "unreachable" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("does not hide a genuine handler bug", async () => {
    process.send = undefined;
    setWorkerRpcInProcessDispatcher(async () => {
      throw new Error("bug");
    });
    await expect(new FeedbackServiceProxy().send(input)).rejects.toThrow("bug");
  });
});
