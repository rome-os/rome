// @rstest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { FakeTurnStream, runSegment, stepsSummary } from "@/test/fake-turn-stream";
import * as chatSse from "@/lib/chat-sse" with { rstest: "importActual" };
import { useTurnStream } from "./use-turn-stream";

// A plain function rather than rs.fn: rstest reports a rejected promise that an
// rs.fn returns as an unhandled rejection, even when the caller handles it.
let calls: { turnId: string; signal?: AbortSignal }[] = [];
let respond: (turnId: string, signal?: AbortSignal) => Promise<Response> = async () =>
  new Response(null, { status: 404 });
// A short stall timeout, so a read that never resolves can be waited out.
rs.mock("@/lib/chat-sse", () => ({ ...chatSse, STREAM_STALL_TIMEOUT_MS: 200 }));
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
  });

  it("is done when the stream is gone (404)", async () => {
    respond = async () => new Response("{}", { status: 404 });
    const { result } = renderHook(() => useTurnStream("old-turn"));
    await waitFor(() => expect(result.current.done).toBe(true));
    expect(result.current.segments).toEqual([]);
  });

  describe("a transport failure is not the end of the turn", () => {
    // Real timers: the first retry waits one second.
    const RETRY_WAIT = { timeout: 3_000 };

    it("keeps the snapshot and reopens the stream when the connection closes without done", async () => {
      const first = new FakeTurnStream();
      const second = new FakeTurnStream();
      const streams = [first, second];
      respond = async () => streams.shift()?.response ?? new Response(null, { status: 404 });
      const { result } = renderHook(() => useTurnStream("child-turn-3"));
      await act(async () => {
        first.send("segment_upsert", runSegment("run-1", [{ tool: "Bash", input: {} }]));
        first.send("summary_update", stepsSummary(1));
        first.close();
      });

      await waitFor(() => expect(result.current.segments).toHaveLength(1));
      expect(result.current.done).toBe(false);
      expect(result.current.segments).toHaveLength(1);

      // The server replays the turn from its start on the new connection.
      await waitFor(() => expect(calls).toHaveLength(2), RETRY_WAIT);
      await act(async () => {
        // The server replays the turn from its start, then goes on.
        second.send("segment_upsert", runSegment("run-1", [{ tool: "Bash", input: {} }]));
        second.send("summary_update", stepsSummary(1));
        second.send("segment_upsert", runSegment("run-2", [{ tool: "Read", input: {} }]));
        second.send("summary_update", stepsSummary(2));
        second.send("done", { success: true });
      });
      await waitFor(() => expect(result.current.done).toBe(true));
      expect(result.current.segments.map((s) => s.id)).toEqual(["run-1", "run-2"]);
      expect(result.current.summary?.totalSteps).toBe(2);
    });

    it("retries a failed request and a 503, then ends on a 404", async () => {
      const outcomes: (() => Promise<Response>)[] = [
        () => Promise.reject(new Error("offline")),
        async () => new Response("{}", { status: 503 }),
        async () => new Response("{}", { status: 404 }),
      ];
      respond = () => (outcomes.shift() ?? (async () => new Response("{}", { status: 404 })))();
      const { result } = renderHook(() => useTurnStream("child-turn-2"));
      await act(async () => new Promise((r) => setTimeout(r, 100)));
      expect(result.current.done).toBe(false);
      await waitFor(() => expect(result.current.done).toBe(true), { timeout: 5_000 });
      expect(calls).toHaveLength(3);
    });

    it("resumes exactly after a reconnect: the replay never lowers what is shown", async () => {
      const first = new FakeTurnStream();
      const second = new FakeTurnStream();
      const streams = [first, second];
      respond = async () => streams.shift()?.response ?? new Response(null, { status: 404 });
      const seen: (number | undefined)[] = [];
      const { result } = renderHook(() => {
        const state = useTurnStream("replay-turn-1");
        seen.push(state.summary?.totalSteps);
        return state;
      });
      await act(async () => {
        first.send("summary_update", stepsSummary(0));
        first.send("segment_upsert", runSegment("run-1", [{ tool: "Bash", input: {} }]));
        first.send("summary_update", stepsSummary(1));
        first.send(
          "segment_upsert",
          runSegment("run-1", [
            { tool: "Bash", input: {} },
            { tool: "Read", input: {} },
          ]),
        );
        first.send("summary_update", stepsSummary(2));
        first.close();
      });
      await waitFor(() => expect(calls).toHaveLength(2), RETRY_WAIT);
      expect(result.current.summary?.totalSteps).toBe(2);

      // The same events again, one chunk at a time, then new ones.
      await act(async () => second.send("summary_update", stepsSummary(0)));
      await act(async () => {
        second.send("segment_upsert", runSegment("run-1", [{ tool: "Bash", input: {} }]));
      });
      await act(async () => second.send("summary_update", stepsSummary(1)));
      await act(async () => {
        second.send(
          "segment_upsert",
          runSegment("run-1", [
            { tool: "Bash", input: {} },
            { tool: "Read", input: {} },
          ]),
        );
        second.send("summary_update", stepsSummary(2));
      });
      expect(result.current.summary?.totalSteps).toBe(2);
      const run = result.current.segments[0];
      expect(run.kind === "run" && run.blocks).toHaveLength(2);
      await act(async () => {
        second.send("segment_upsert", runSegment("run-2", [{ tool: "Edit", input: {} }]));
        second.send("summary_update", stepsSummary(3));
      });
      await waitFor(() => expect(result.current.summary?.totalSteps).toBe(3));
      expect(result.current.segments.map((s) => s.id)).toEqual(["run-1", "run-2"]);
      // No snapshot of any reader went backwards or blank.
      const counts = seen.filter((n): n is number => n !== undefined);
      expect(counts).toEqual([...counts].sort((a, b) => a - b));
    });

    it("reopens the stream when a read stays pending, keeping the snapshot", async () => {
      const first = new FakeTurnStream();
      const second = new FakeTurnStream();
      const streams = [first, second];
      respond = async () => streams.shift()?.response ?? new Response(null, { status: 404 });
      const { result } = renderHook(() => useTurnStream("stalled-turn"));
      await act(async () => {
        first.send("summary_update", stepsSummary(5));
      });
      await waitFor(() => expect(result.current.summary?.totalSteps).toBe(5));

      // Nothing more arrives and the connection is never closed.
      await waitFor(() => expect(calls).toHaveLength(2), RETRY_WAIT);
      expect(result.current.done).toBe(false);
      expect(result.current.summary?.totalSteps).toBe(5);
    });

    it.each([401, 403])("stops retrying on HTTP %i and keeps the snapshot", async (status) => {
      const first = new FakeTurnStream();
      const outcomes: (() => Promise<Response>)[] = [
        async () => first.response,
        async () => new Response("{}", { status }),
      ];
      respond = () => (outcomes.shift() ?? (async () => first.response))();
      const { result } = renderHook(() => useTurnStream(`denied-turn-${status}`));
      await act(async () => {
        first.send("summary_update", stepsSummary(4));
        first.close();
      });
      await waitFor(() => expect(result.current.done).toBe(true), RETRY_WAIT);
      expect(result.current.summary?.totalSteps).toBe(4);
      await act(async () => new Promise((r) => setTimeout(r, 1_300)));
      expect(calls).toHaveLength(2);
    });

    it("stops retrying once the last reader leaves", async () => {
      respond = () => Promise.reject(new Error("offline"));
      const { unmount } = renderHook(() => useTurnStream("child-turn-5"));
      await waitFor(() => expect(calls).toHaveLength(1));
      unmount();
      await act(async () => new Promise((r) => setTimeout(r, 1_300)));
      expect(calls).toHaveLength(1);
    });
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
