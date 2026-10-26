// @rstest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { FakeTurnStream, runSegment, stepsSummary } from "@/test/fake-turn-stream";
import { useTurnStream } from "./use-turn-stream";

// A plain function rather than rs.fn: rstest reports a rejected promise that an
// rs.fn returns as an unhandled rejection, even when the caller handles it.
let calls: { turnId: string; signal?: AbortSignal }[] = [];
let respond: (turnId: string, signal?: AbortSignal) => Promise<Response> = async () =>
  new Response(null, { status: 404 });
rs.mock("@/lib/chat-api", () => ({
  openTurnStream: (turnId: string, signal?: AbortSignal) => {
    calls.push({ turnId, signal });
    return respond(turnId, signal);
  },
}));

// Each test uses its own turn id: a released stream lingers one tick, so a reused id
// would pick up the previous test's connection.
beforeEach(() => {
  calls = [];
});
afterEach(cleanup);

describe("useTurnStream", () => {
  it("adds segments, replaces one that shares an id, and tracks the summary", async () => {
    const stream = new FakeTurnStream();
    respond = async () => stream.response;
    const { result } = renderHook(() => useTurnStream("child-turn-0"));

    await act(async () => {
      stream.send(
        "segment_upsert",
        runSegment("run-1", [{ tool: "Bash", input: { command: "ls" } }]),
      );
      stream.send("summary_update", stepsSummary(1));
    });
    await waitFor(() => expect(result.current.summary?.totalSteps).toBe(1));
    expect(result.current.segments).toHaveLength(1);

    await act(async () => {
      stream.send(
        "segment_upsert",
        runSegment("run-1", [
          { tool: "Bash", input: { command: "ls" } },
          { tool: "Read", input: { path: "a.ts" } },
        ]),
      );
      stream.send(
        "segment_upsert",
        runSegment("run-2", [{ tool: "Edit", input: { path: "b.ts" } }]),
      );
      stream.send("summary_update", stepsSummary(3));
    });
    await waitFor(() => expect(result.current.summary?.totalSteps).toBe(3));
    expect(result.current.segments.map((s) => s.id)).toEqual(["run-1", "run-2"]);
    const first = result.current.segments[0];
    expect(first.kind === "run" && first.blocks).toHaveLength(2);
    expect(result.current.done).toBe(false);
    expect(calls.map((c) => c.turnId)).toEqual(["child-turn-0"]);
  });

  it("is done when the server sends done, keeping what it streamed", async () => {
    const stream = new FakeTurnStream();
    respond = async () => stream.response;
    const { result } = renderHook(() => useTurnStream("child-turn-1"));

    await act(async () => {
      stream.send("segment_upsert", runSegment("run-1", [{ tool: "Bash", input: {} }]));
      stream.send("done", { success: true });
    });
    await waitFor(() => expect(result.current.done).toBe(true));
    expect(result.current.segments).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it("is done without an error when the stream is gone (404)", async () => {
    respond = async () => new Response("{}", { status: 404 });
    const { result } = renderHook(() => useTurnStream("old-turn"));
    await waitFor(() => expect(result.current.done).toBe(true));
    expect(result.current.error).toBeNull();
    expect(result.current.segments).toEqual([]);
  });

  it("is done with an error when the request fails", async () => {
    respond = () => Promise.reject(new Error("offline"));
    const { result } = renderHook(() => useTurnStream("child-turn-2"));
    await waitFor(() => expect(result.current.done).toBe(true));
    expect(result.current.error).toBe("offline");
  });

  it("is done when the connection closes without a done event", async () => {
    const stream = new FakeTurnStream();
    respond = async () => stream.response;
    const { result } = renderHook(() => useTurnStream("child-turn-3"));
    await act(async () => stream.close());
    await waitFor(() => expect(result.current.done).toBe(true));
  });

  it("opens no stream while disabled", () => {
    const { result } = renderHook(() => useTurnStream("child-turn", { enabled: false }));
    expect(calls).toHaveLength(0);
    expect(result.current.done).toBe(false);
  });

  it("shares one connection between readers of a turn and closes it after the last leaves", async () => {
    const stream = new FakeTurnStream();
    respond = async () => stream.response;
    const a = renderHook(() => useTurnStream("shared-turn"));
    const b = renderHook(() => useTurnStream("shared-turn"));
    await act(async () => stream.send("summary_update", stepsSummary(2)));
    await waitFor(() => expect(b.result.current.summary?.totalSteps).toBe(2));
    expect(a.result.current.summary?.totalSteps).toBe(2);
    expect(calls).toHaveLength(1);

    a.unmount();
    await act(async () => new Promise((r) => setTimeout(r, 5)));
    expect(calls[0]?.signal?.aborted).toBe(false);
    b.unmount();
    await waitFor(() => expect(calls[0]?.signal?.aborted).toBe(true));
  });
});
