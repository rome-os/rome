import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { context, ROOT_CONTEXT, trace, type Context, type SpanContext } from "@opentelemetry/api";
import { IpcRpc, type IpcMessage, type IpcTransport } from "./ipc.js";
import { installTestSpanHarness, type SpanHarness } from "../test/helpers.js";

let harness: SpanHarness;
const tracer = () => trace.getTracer("ipc-test");

beforeEach(() => {
  harness = installTestSpanHarness("node");
});

afterEach(async () => {
  await harness.shutdown();
});

// A span from an unrelated, already finished trace, standing in for whatever
// span was active when main forked a pooled worker.
function staleContext(): Context {
  const stale = tracer().startSpan("stale-fork-request", undefined, ROOT_CONTEXT);
  stale.end();
  return trace.setSpan(ROOT_CONTEXT, stale);
}

type Listener = (message: IpcMessage) => void;

// Two IpcRpc ends over an in-memory channel. Every message reaching `main` is
// delivered inside `mainIngress`, the way a ChildProcess `message` callback
// re-enters the async context captured at fork(). Without that, both peers
// share one AsyncLocalStorage and the caller's span would leak across for free.
function linkedPeers(mainIngress: Context) {
  const mainInbox = new Set<Listener>();
  const workerInbox = new Set<Listener>();
  const sentToMain: IpcMessage[] = [];
  const sentToWorker: IpcMessage[] = [];
  const end = (inbox: Set<Listener>, deliver: (message: IpcMessage) => void): IpcTransport => ({
    connected: true,
    send: deliver,
    onMessage(listener) {
      inbox.add(listener);
      return () => inbox.delete(listener);
    },
    onDisconnect: () => () => undefined,
  });
  const deliverToMain = (message: IpcMessage) => {
    sentToMain.push(message);
    const copy = structuredClone(message);
    queueMicrotask(() =>
      context.with(mainIngress, () => {
        for (const listener of mainInbox) listener(copy);
      }),
    );
  };
  const deliverToWorker = (message: IpcMessage) => {
    sentToWorker.push(message);
    const copy = structuredClone(message);
    queueMicrotask(() =>
      context.with(ROOT_CONTEXT, () => {
        for (const listener of workerInbox) listener(copy);
      }),
    );
  };
  const main = new IpcRpc(end(mainInbox, deliverToWorker), "main");
  const worker = new IpcRpc(end(workerInbox, deliverToMain), "worker");
  return { main, worker, sentToMain, sentToWorker, deliverToMain };
}

function probeActiveSpan(rpc: IpcRpc): { seen: Array<SpanContext | undefined> } {
  const state = { seen: [] as Array<SpanContext | undefined> };
  rpc.handle("probe", async () => {
    state.seen.push(trace.getActiveSpan()?.spanContext());
    return "ok";
  });
  return state;
}

describe("IpcRpc trace context", () => {
  it("runs the handler under the caller's span, not the ingress context", async () => {
    const stale = staleContext();
    const { main, worker } = linkedPeers(stale);
    const probe = probeActiveSpan(main);

    const callerSpan = await tracer().startActiveSpan("worker-root", async (span) => {
      await worker.call("probe", {});
      span.end();
      return span.spanContext();
    });

    expect(probe.seen).toHaveLength(1);
    expect(probe.seen[0]?.traceId).toBe(callerSpan.traceId);
    expect(probe.seen[0]?.spanId).toBe(callerSpan.spanId);
  });

  it("runs the handler with no span when the caller had none", async () => {
    const { main, worker, sentToMain } = linkedPeers(staleContext());
    const probe = probeActiveSpan(main);

    await context.with(ROOT_CONTEXT, () => worker.call("probe", {}));

    expect(probe.seen).toEqual([undefined]);
    // An empty carrier stays off the wire.
    expect(sentToMain[0]).not.toHaveProperty("traceCarrier");
  });

  it("dispatches a request without a carrier, as an older peer sends, under no span", async () => {
    const { main, sentToWorker, deliverToMain } = linkedPeers(staleContext());
    const probe = probeActiveSpan(main);

    deliverToMain({ type: "rpc_request", reqId: "legacy-1", method: "probe", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentToWorker).toEqual([{ type: "rpc_response", reqId: "legacy-1", result: "ok" }]);
    expect(probe.seen).toEqual([undefined]);
  });
});
