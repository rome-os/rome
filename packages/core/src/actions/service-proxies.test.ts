import { afterEach, describe, expect, it, rs } from "@rstest/core";
import {
  BackendTurnRunnerProxy,
  ChildSessionsProxy,
  NotifyServiceProxy,
  TalkRouterProxy,
} from "./service-proxies.js";
import { actionExecutionContext } from "./context.js";
import {
  setWorkerRpcInProcessDispatcher,
  WorkerRpcDisconnectError,
  WorkerRpcSendError,
  WorkerRpcTimeoutError,
} from "./worker-rpc-client.js";

describe("TalkRouterProxy", () => {
  const originalSend = process.send;

  afterEach(() => {
    process.send = originalSend;
    setWorkerRpcInProcessDispatcher(null);
  });

  it("reads the live main-process connection list on every call", async () => {
    process.send = undefined;
    let connections = [{ connectionId: "discord-1", service: "discord" }];
    const calls: string[] = [];
    setWorkerRpcInProcessDispatcher(async (method) => {
      calls.push(method);
      return connections;
    });
    const proxy = new TalkRouterProxy();

    await expect(proxy.list()).resolves.toEqual(connections);
    connections = [{ connectionId: "wechat-1", service: "wechat" }];
    await expect(proxy.list()).resolves.toEqual(connections);
    expect(calls).toEqual(["talk.list", "talk.list"]);
  });

  it("rehydrates history timestamps after worker RPC serialization", async () => {
    process.send = undefined;
    setWorkerRpcInProcessDispatcher(async (method) => {
      expect(method).toBe("talk.history.query");
      return [
        {
          messageId: "message-1",
          conversationId: "conversation-1",
          senderId: "user-1",
          text: "hello",
          attachments: [],
          timestamp: "2026-08-04T10:00:00.000Z",
        },
      ];
    });
    const history = new TalkRouterProxy().feature("discord-1", "history");

    const messages = await history?.query({});

    expect(messages?.[0]?.timestamp).toBeInstanceOf(Date);
    expect(messages?.[0]?.timestamp.toISOString()).toBe("2026-08-04T10:00:00.000Z");
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

describe("ChildSessionsProxy", () => {
  const originalSend = process.send;

  afterEach(() => {
    process.send = originalSend;
    setWorkerRpcInProcessDispatcher(null);
  });

  it("stamps the calling agent turn onto the wire", async () => {
    // The RPC server dispatches outside the action context, so main can only
    // learn which turn asked from what the proxy puts in the params.
    process.send = undefined;
    const calls: Array<{ method: string; params: unknown }> = [];
    setWorkerRpcInProcessDispatcher(async (method, params) => {
      calls.push({ method, params });
      return {
        sessionId: "child-1",
        turnId: "child-turn-1",
        agentName: "coder",
        parentSessionId: "rome-session-1",
      };
    });

    const started = await actionExecutionContext.run(
      {
        executionId: "exec-1",
        rootExecutionId: "exec-1",
        initiator: "agent:main",
        romeSessionId: "rome-session-1",
        turnId: "parent-turn-1",
        agentName: "main",
      },
      () => new ChildSessionsProxy().startDetached({ agentName: "coder", prompt: "go" }),
    );

    expect(started.sessionId).toBe("child-1");
    expect(calls).toEqual([
      {
        method: "childSessions.startDetached",
        params: {
          agentName: "coder",
          prompt: "go",
          resumeSessionId: undefined,
          workingDir: undefined,
          parent: {
            parentSessionId: "rome-session-1",
            parentTurnId: "parent-turn-1",
            parentAgentName: "main",
          },
        },
      },
    ]);
  });

  it("refuses to start a child outside an agent turn", async () => {
    process.send = undefined;
    const dispatch = rs.fn(async () => ({}));
    setWorkerRpcInProcessDispatcher(dispatch);

    await expect(
      actionExecutionContext.run(
        { executionId: "exec-1", rootExecutionId: "exec-1", initiator: "routine" },
        () => new ChildSessionsProxy().startDetached({ agentName: "coder", prompt: "go" }),
      ),
    ).rejects.toThrow(/agent-session caller/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("stamps the calling agent onto a status read", async () => {
    // A child answers only to the agent that owns it, so a read main cannot
    // attribute belongs to nobody.
    process.send = undefined;
    const calls: Array<{ method: string; params: unknown }> = [];
    setWorkerRpcInProcessDispatcher(async (method, params) => {
      calls.push({ method, params });
      return null;
    });

    await expect(
      actionExecutionContext.run(
        {
          executionId: "exec-1",
          rootExecutionId: "exec-1",
          initiator: "agent:engineer",
          romeSessionId: "tick-2",
          turnId: "tick-2-turn",
          agentName: "engineer:engineer",
        },
        () => new ChildSessionsProxy().getStatus({ sessionId: "child-1", transcriptTail: 3 }),
      ),
    ).resolves.toBeNull();
    expect(calls).toEqual([
      {
        method: "childSessions.getStatus",
        params: {
          sessionId: "child-1",
          transcriptTail: 3,
          caller: { romeSessionId: "tick-2", agentName: "engineer:engineer" },
        },
      },
    ]);
  });

  it("stamps the calling agent onto a stop", async () => {
    process.send = undefined;
    const calls: Array<{ method: string; params: unknown }> = [];
    setWorkerRpcInProcessDispatcher(async (method, params) => {
      calls.push({ method, params });
      return { stopped: true, status: "running" };
    });

    await actionExecutionContext.run(
      {
        executionId: "exec-1",
        rootExecutionId: "exec-1",
        initiator: "agent:engineer",
        romeSessionId: "tick-2",
        turnId: "tick-2-turn",
        agentName: "engineer:engineer",
      },
      () => new ChildSessionsProxy().stop({ sessionId: "child-1" }),
    );

    expect(calls).toEqual([
      {
        method: "childSessions.stop",
        params: {
          sessionId: "child-1",
          caller: { romeSessionId: "tick-2", agentName: "engineer:engineer" },
        },
      },
    ]);
  });

  it.each([
    ["a status read", (proxy: ChildSessionsProxy) => proxy.getStatus({ sessionId: "child-1" })],
    ["a stop", (proxy: ChildSessionsProxy) => proxy.stop({ sessionId: "child-1" })],
  ])("refuses %s outside an agent turn", async (_label, call) => {
    process.send = undefined;
    const dispatch = rs.fn(async () => null);
    setWorkerRpcInProcessDispatcher(dispatch);

    await expect(
      actionExecutionContext.run(
        { executionId: "exec-1", rootExecutionId: "exec-1", initiator: "routine" },
        () => call(new ChildSessionsProxy()),
      ),
    ).rejects.toThrow(/agent-session caller/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("carries an explicit workingDir onto the wire", async () => {
    process.send = undefined;
    const calls: Array<{ method: string; params: unknown }> = [];
    setWorkerRpcInProcessDispatcher(async (method, params) => {
      calls.push({ method, params });
      return {
        sessionId: "child-1",
        turnId: "child-turn-1",
        agentName: "coder",
        parentSessionId: "rome-session-1",
      };
    });

    await actionExecutionContext.run(
      {
        executionId: "exec-1",
        rootExecutionId: "exec-1",
        initiator: "agent:main",
        romeSessionId: "rome-session-1",
        turnId: "parent-turn-1",
        agentName: "main",
      },
      () =>
        new ChildSessionsProxy().startDetached({
          agentName: "coder",
          prompt: "go",
          workingDir: "/srv/clones/rome",
        }),
    );

    expect(calls[0]!.params).toMatchObject({ workingDir: "/srv/clones/rome" });
  });
});
