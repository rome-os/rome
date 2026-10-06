import { afterEach, describe, expect, it, rs } from "@rstest/core";
import {
  BackendTurnRunnerProxy,
  ChannelsServiceProxy,
  NotifyServiceProxy,
} from "./service-proxies.js";
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
    const read = await proxy.history("discord", { since, connectionId: "discord-1" });

    for (const page of [queried, read]) {
      expect(page[0]?.timestamp).toBeInstanceOf(Date);
      expect(page[0]?.timestamp.toISOString()).toBe("2026-08-04T10:00:00.000Z");
    }
    expect(calls).toEqual([
      {
        method: "channels.query",
        params: { channel: "discord", since: "2026-08-04T09:00:00.000Z", limit: 2 },
      },
      {
        method: "channels.history",
        params: {
          channel: "discord",
          since: "2026-08-04T09:00:00.000Z",
          connectionId: "discord-1",
        },
      },
    ]);
  });

  it("names the Connection a send means only when the action does", async () => {
    process.send = undefined;
    const calls: unknown[] = [];
    setWorkerRpcInProcessDispatcher(async (_method, params) => {
      calls.push(params);
      return { messageId: "m1" };
    });
    const proxy = new ChannelsServiceProxy();

    await proxy.send("discord", "c1" as never, { text: "a" });
    await proxy.send("discord", "c1" as never, { text: "b" }, { connectionId: "discord-1" });

    expect(calls).toEqual([
      { channel: "discord", conversationId: "c1", message: { text: "a" } },
      {
        channel: "discord",
        conversationId: "c1",
        message: { text: "b" },
        connectionId: "discord-1",
      },
    ]);
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
