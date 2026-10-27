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

      await waitFor(() => expect(result.current.error).toBe("Stream closed"));
      expect(result.current.done).toBe(false);
      expect(result.current.endedAt).toBeNull();
      expect(result.current.segments).toHaveLength(1);

      // The server replays the turn from its start on the new connection.
      await waitFor(() => expect(calls).toHaveLength(2), RETRY_WAIT);
      await act(async () => {
        second.send("segment_upsert", runSegment("run-1", [{ tool: "Bash", input: {} }]));
        second.send("segment_upsert", runSegment("run-2", [{ tool: "Read", input: {} }]));
        second.send("summary_update", stepsSummary(2));
        second.send("done", { success: true });
      });
      await waitFor(() => expect(result.current.done).toBe(true));
      expect(result.current.error).toBeNull();
      expect(result.current.segments.map((s) => s.id)).toEqual(["run-1", "run-2"]);
      expect(result.current.summary?.totalSteps).toBe(2);
    });

    it("retries a failed request and a non-404 HTTP error without ending", async () => {
      const stream = new FakeTurnStream();
      const outcomes: (() => Promise<Response>)[] = [
        () => Promise.reject(new Error("offline")),
        async () => new Response("{}", { status: 503 }),
        async () => stream.response,
      ];
      respond = () => (outcomes.shift() ?? (async () => stream.response))();
      const { result } = renderHook(() => useTurnStream("child-turn-2"));

      await waitFor(() => expect(result.current.error).toBe("offline"));
      expect(result.current.done).toBe(false);
      await waitFor(() => expect(result.current.error).toBe("HTTP 503"), RETRY_WAIT);
      expect(result.current.done).toBe(false);
      await waitFor(() => expect(calls).toHaveLength(3), RETRY_WAIT);
      await waitFor(() => expect(result.current.error).toBeNull());
      expect(result.current.done).toBe(false);
    });

    it("ends on a 404 after a failed attempt", async () => {
      const outcomes: (() => Promise<Response>)[] = [
        () => Promise.reject(new Error("offline")),
        async () => new Response("{}", { status: 404 }),
      ];
      respond = () => (outcomes.shift() ?? (async () => new Response("{}", { status: 404 })))();
      const { result } = renderHook(() => useTurnStream("child-turn-4"));
      await waitFor(() => expect(result.current.done).toBe(true), RETRY_WAIT);
      expect(result.current.error).toBeNull();
    });

    it("keeps the shown snapshot while a reconnect replays history, and swaps once caught up", async () => {
      const first = new FakeTurnStream();
      const second = new FakeTurnStream();
      const streams = [first, second];
      respond = async () => streams.shift()?.response ?? new Response(null, { status: 404 });
      const { result } = renderHook(() => useTurnStream("replay-turn-1"));
      await act(async () => {
        first.send("segment_upsert", runSegment("run-1", [{ tool: "Bash", input: {} }]));
        first.send("segment_upsert", runSegment("run-2", [{ tool: "Read", input: {} }]));
        first.send("summary_update", stepsSummary(7));
        first.close();
      });
      await waitFor(() => expect(result.current.error).toBe("Stream closed"));
      await waitFor(() => expect(calls).toHaveLength(2), RETRY_WAIT);

      // The server starts over: a zero-step summary, then older versions, in separate chunks.
      await act(async () => second.send("summary_update", stepsSummary(0)));
      await act(async () => second.send("segment_upsert", runSegment("run-1", [])));
      await act(async () => second.send("summary_update", stepsSummary(3)));
      await act(async () => new Promise((r) => setTimeout(r, 20)));
      expect(result.current.summary?.totalSteps).toBe(7);
      expect(result.current.segments.map((s) => s.id)).toEqual(["run-1", "run-2"]);
      const shown = result.current.segments[0];
      expect(shown.kind === "run" && shown.blocks).toHaveLength(1);

      await act(async () => {
        second.send("segment_upsert", runSegment("run-2", [{ tool: "Read", input: {} }]));
        second.send("summary_update", stepsSummary(8));
      });
      await waitFor(() => expect(result.current.summary?.totalSteps).toBe(8));
      expect(result.current.done).toBe(false);
    });

    it("ends without losing the shown snapshot when the replay ends before catching up", async () => {
      const first = new FakeTurnStream();
      const second = new FakeTurnStream();
      const streams = [first, second];
      respond = async () => streams.shift()?.response ?? new Response(null, { status: 404 });
      const { result } = renderHook(() => useTurnStream("replay-turn-2"));
      await act(async () => {
        first.send("summary_update", stepsSummary(7));
        first.close();
      });
      await waitFor(() => expect(calls).toHaveLength(2), RETRY_WAIT);
      await act(async () => {
        second.send("summary_update", stepsSummary(0));
        second.send("done", { success: true });
      });
      await waitFor(() => expect(result.current.done).toBe(true));
      expect(result.current.summary?.totalSteps).toBe(7);
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
      await waitFor(() => expect(result.current.error).toBe(`HTTP ${status}`), RETRY_WAIT);
      expect(result.current.done).toBe(true);
      expect(result.current.summary?.totalSteps).toBe(4);
      await act(async () => new Promise((r) => setTimeout(r, 1_300)));
      expect(calls).toHaveLength(2);
    });

    it("stops retrying once the last reader leaves", async () => {
      respond = () => Promise.reject(new Error("offline"));
      const { result, unmount } = renderHook(() => useTurnStream("child-turn-5"));
      await waitFor(() => expect(result.current.error).toBe("offline"));
      unmount();
      await act(async () => new Promise((r) => setTimeout(r, 1_300)));
      expect(calls).toHaveLength(1);
    });
  });

  it("stamps the end once, so every reader shares it", async () => {
    const stream = new FakeTurnStream();
    respond = async () => stream.response;
    const a = renderHook(() => useTurnStream("ended-turn"));
    expect(a.result.current.endedAt).toBeNull();
    await act(async () => stream.send("done", { success: true }));
    await waitFor(() => expect(a.result.current.done).toBe(true));
    const endedAt = a.result.current.endedAt;
    expect(endedAt).not.toBeNull();

    await act(async () => new Promise((r) => setTimeout(r, 20)));
    const b = renderHook(() => useTurnStream("ended-turn"));
    expect(b.result.current.endedAt).toBe(endedAt);
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
