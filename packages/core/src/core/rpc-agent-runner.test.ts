import { describe, expect, it } from "@rstest/core";
import { IpcRpc, type IpcMessage, type IpcTransport } from "../actions/ipc.js";
import { RpcAgentRunner } from "./rpc-agent-runner.js";
import type { RunTurnRequest, RunTurnResponse } from "./agent-session-bridge.js";
import type { StreamAgentMessage } from "@rome-os/app-runtime";

/** In-memory transport pair: messages sent on one side arrive on the other. */
function createTransportPair(): [IpcTransport, IpcTransport] {
  const aListeners = new Set<(m: IpcMessage) => void>();
  const bListeners = new Set<(m: IpcMessage) => void>();
  const make = (
    mine: Set<(m: IpcMessage) => void>,
    theirs: Set<(m: IpcMessage) => void>,
  ): IpcTransport => ({
    connected: true,
    send(message) {
      // Preserve pipe ordering but decouple call stacks, like process IPC.
      queueMicrotask(() => {
        for (const l of theirs) l(message);
      });
    },
    onMessage(listener) {
      mine.add(listener);
      return () => mine.delete(listener);
    },
    onDisconnect() {
      return () => undefined;
    },
  });
  return [make(aListeners, bListeners), make(bListeners, aListeners)];
}

interface FakeMainOptions {
  /** Messages to stream for each turn, keyed by prompt. */
  turns: Map<string, StreamAgentMessage[]>;
  requests?: RunTurnRequest[];
}

/**
 * Minimal stand-in for the main-process AgentSessionBridge: handles
 * `agent.session.runTurn`, opens the `agent.turn:<turnId>` stream BEFORE the
 * rpc_response resolves (matching the real bridge's message ordering), and
 * drains the configured messages.
 */
function attachFakeMain(rpc: IpcRpc, options: FakeMainOptions): void {
  let turnCounter = 0;
  rpc.handle<RunTurnRequest, RunTurnResponse>("agent.session.runTurn", async (req, ctx) => {
    options.requests?.push(req);
    const turnId = `turn-${++turnCounter}`;
    const messages = options.turns.get(req.input.prompt) ?? [];
    const stream = ctx.openStream<StreamAgentMessage>(`agent.turn:${turnId}`);
    void (async () => {
      for (const msg of messages) {
        stream.send(msg);
        await new Promise((r) => setTimeout(r, 1));
      }
      stream.close();
    })();
    return {
      turnId,
      sessionId: `session-${turnId}`,
      romeSession: { _romeSessionId: `action:test:${req.key.agentName}`, _type: "action" },
    };
  });
}

async function collect(iter: AsyncIterable<unknown>): Promise<StreamAgentMessage[]> {
  const out: StreamAgentMessage[] = [];
  for await (const msg of iter) out.push(msg as StreamAgentMessage);
  return out;
}

function turnMessages(label: string): StreamAgentMessage[] {
  return [
    { type: "text", content: `${label}-chunk` } as StreamAgentMessage,
    { type: "result", content: `${label}-result` } as StreamAgentMessage,
  ];
}

describe("RpcAgentRunner turn stream routing", () => {
  function setup(
    turns: Map<string, StreamAgentMessage[]>,
    requests?: RunTurnRequest[],
  ): RpcAgentRunner {
    const [mainTransport, workerTransport] = createTransportPair();
    const mainRpc = new IpcRpc(mainTransport, "main");
    const workerRpc = new IpcRpc(workerTransport, "worker");
    attachFakeMain(mainRpc, { turns, requests });
    return new RpcAgentRunner(workerRpc);
  }

  it("delivers a single run's stream", async () => {
    const runner = setup(new Map([["p1", turnMessages("one")]]));
    const msgs = await collect(runner.run({ agentName: "a", prompt: "p1" }));
    expect(msgs.map((m) => (m as { content?: string }).content)).toEqual([
      "one-chunk",
      "one-result",
    ]);
  });

  it("attaches main's authoritative Rome session metadata to session_init", async () => {
    const runner = setup(
      new Map([
        [
          "p1",
          [
            { type: "session_init", sessionId: "runtime-session" } as StreamAgentMessage,
            { type: "result", content: "done" } as StreamAgentMessage,
          ],
        ],
      ]),
    );

    const messages = await collect(runner.run({ agentName: "reviewer", prompt: "p1" }));

    expect(messages[0]).toEqual({
      type: "session_init",
      sessionId: "runtime-session",
      romeSession: { _romeSessionId: "action:test:reviewer", _type: "action" },
    });
  });

  it("forwards explicit sessionId to main for resume", async () => {
    const requests: RunTurnRequest[] = [];
    const runner = setup(new Map([["p1", turnMessages("one")]]), requests);

    await collect(
      runner.run({
        agentName: "a",
        prompt: "p1",
        channelThreadKey: "telegram:t-1",
        sessionId: "session-123",
      }),
    );

    expect(requests[0]).toMatchObject({
      sessionId: "session-123",
      key: { agentName: "a", channelThreadKey: "telegram:t-1" },
    });
  });

  it("routes sequential runs on the same ipc to their own consumers", async () => {
    // Regression: the previous per-run catch-all handler delivered every
    // stream after the first to the first (finished) run's consumer, so the
    // second sequential run hung forever.
    const runner = setup(
      new Map([
        ["p1", turnMessages("one")],
        ["p2", turnMessages("two")],
      ]),
    );

    const first = await collect(runner.run({ agentName: "a", prompt: "p1" }));
    const second = await collect(runner.run({ agentName: "a", prompt: "p2" }));

    expect(first.map((m) => (m as { content?: string }).content)).toEqual([
      "one-chunk",
      "one-result",
    ]);
    expect(second.map((m) => (m as { content?: string }).content)).toEqual([
      "two-chunk",
      "two-result",
    ]);
  });

  it("routes concurrent runs to their own consumers", async () => {
    const runner = setup(
      new Map([
        ["p1", turnMessages("one")],
        ["p2", turnMessages("two")],
        ["p3", turnMessages("three")],
      ]),
    );

    const [first, second, third] = await Promise.all([
      collect(runner.run({ agentName: "a", prompt: "p1" })),
      collect(runner.run({ agentName: "b", prompt: "p2" })),
      collect(runner.run({ agentName: "c", prompt: "p3" })),
    ]);

    expect(first.map((m) => (m as { content?: string }).content)).toEqual([
      "one-chunk",
      "one-result",
    ]);
    expect(second.map((m) => (m as { content?: string }).content)).toEqual([
      "two-chunk",
      "two-result",
    ]);
    expect(third.map((m) => (m as { content?: string }).content)).toEqual([
      "three-chunk",
      "three-result",
    ]);
  });

  it("does not lose a turn that completes before the consumer claims it", async () => {
    // The fake main streams everything and closes within microtasks/timers;
    // run() only claims after the rpc_response resolves. Buffered delivery
    // must hand the full stream to the late claimer.
    const many = Array.from(
      { length: 50 },
      (_, i) => ({ type: "text", content: `c${i}` }) as StreamAgentMessage,
    );
    const runner = setup(new Map([["p1", many]]));
    const msgs = await collect(runner.run({ agentName: "a", prompt: "p1" }));
    expect(msgs).toHaveLength(50);
    expect((msgs[49] as { content?: string }).content).toBe("c49");
  });

  it("keeps an abandoned run's stream from blocking later runs", async () => {
    const runner = setup(
      new Map([
        ["p1", turnMessages("one")],
        ["p2", turnMessages("two")],
      ]),
    );

    // Start a run and abandon it after the first message (early return from
    // a for-await loop calls the generator's return()).
    const iter = runner.run({ agentName: "a", prompt: "p1" })[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.done).toBe(false);
    await iter.return?.(undefined);

    const second = await collect(runner.run({ agentName: "a", prompt: "p2" }));
    expect(second.map((m) => (m as { content?: string }).content)).toEqual([
      "two-chunk",
      "two-result",
    ]);
  });
});
