// @rstest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { z } from "zod";
import { raw, useSseEvent, useSseEvents } from "./use-sse-events";

class MockEventSource {
  static instances: MockEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly url: string;
  readonly withCredentials: boolean;
  readonly close = rs.fn();
  readyState = MockEventSource.OPEN;
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(url: string | URL, init?: EventSourceInit) {
    this.url = String(url);
    this.withCredentials = init?.withCredentials ?? false;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  emit(type: string, data = ""): void {
    const event = type === "open" ? new Event(type) : new MessageEvent(type, { data });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  emitError(readyState: number): void {
    this.readyState = readyState;
    const event = new Event("error");
    for (const listener of this.listeners.get("error") ?? []) listener(event);
  }
}

describe("useSseEvents", () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    rs.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
  });

  afterEach(() => {
    cleanup();
    rs.unstubAllGlobals();
    rs.restoreAllMocks();
  });

  it("parses, validates, and dispatches default messages", () => {
    const handler = rs.fn();

    renderHook(() =>
      useSseEvent("/events", {
        schema: z.object({ count: z.number() }),
        fn: (value) => {
          handler(value);
        },
      }),
    );

    expect(MockEventSource.instances).toHaveLength(1);
    const source = MockEventSource.instances[0];
    expect(source.url).toBe("/events");
    expect(source.withCredentials).toBe(true);

    act(() => source.emit("message", JSON.stringify({ count: 2 })));

    expect(handler).toHaveBeenCalledWith({ count: 2 });
  });

  it("dispatches multiple named event schemas over one connection", () => {
    const countHandler = rs.fn();
    const labelHandler = rs.fn();

    renderHook(() =>
      useSseEvents("/events", {
        count: {
          schema: z.object({ value: z.number() }),
          fn: (value) => {
            countHandler(value);
          },
        },
        label: {
          schema: z.object({ value: z.string() }),
          fn: (value) => {
            labelHandler(value);
          },
        },
      }),
    );

    expect(MockEventSource.instances).toHaveLength(1);
    const source = MockEventSource.instances[0];
    act(() => {
      source.emit("count", JSON.stringify({ value: 3 }));
      source.emit("label", JSON.stringify({ value: "three" }));
    });

    expect(countHandler).toHaveBeenCalledWith({ value: 3 });
    expect(labelHandler).toHaveBeenCalledWith({ value: "three" });
  });

  it("drops malformed and schema-invalid payloads without logging raw data", () => {
    const handler = rs.fn();
    const error = rs.spyOn(console, "error").mockImplementation(() => {});
    renderHook(() =>
      useSseEvents("/events", {
        update: { schema: z.object({ count: z.number() }), fn: handler },
      }),
    );
    const source = MockEventSource.instances[0];

    act(() => {
      source.emit("update", "private malformed payload");
      source.emit("update", JSON.stringify({ count: "private invalid value" }));
    });

    expect(handler).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(2);
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toContain("/events");
    expect(logged).toContain("update");
    expect(logged).not.toContain("private malformed payload");
    expect(logged).not.toContain("private invalid value");
  });

  it("redacts payload-derived Zod paths and messages from validation logs", () => {
    const secret = "private-validation-value";
    const error = rs.spyOn(console, "error").mockImplementation(() => {});
    renderHook(() =>
      useSseEvent("/events", {
        schema: z.string().refine(() => false, { message: `Rejected ${secret}` }),
        fn: rs.fn(),
      }),
    );

    act(() => MockEventSource.instances[0].emit("message", JSON.stringify(secret)));

    expect(error).toHaveBeenCalledWith(
      "Invalid SSE event payload",
      expect.objectContaining({
        url: "/events",
        eventName: "message",
        issueCount: 1,
        issueCodes: ["custom"],
      }),
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
  });

  it.each([
    ["object", { nested: true }],
    ["array", [1, "two"]],
    ["string", "value"],
    ["number", 42],
    ["boolean", false],
    ["null", null],
  ])("raw accepts valid JSON %s values", (_category, value) => {
    const handler = rs.fn();
    renderHook(() => useSseEvent("/events", { schema: raw, fn: handler }));

    act(() => MockEventSource.instances[0].emit("message", JSON.stringify(value)));

    expect(handler).toHaveBeenCalledWith(value);
  });

  it("uses updated schemas and callbacks without reconnecting", () => {
    const firstHandler = rs.fn();
    const secondHandler = rs.fn();
    const { rerender } = renderHook(
      ({ useSecond }: { useSecond: boolean }) =>
        useSseEvent("/events", {
          schema: useSecond ? z.object({ value: z.number() }) : z.object({ value: z.string() }),
          fn: useSecond ? secondHandler : firstHandler,
        }),
      { initialProps: { useSecond: false } },
    );
    const source = MockEventSource.instances[0];

    rerender({ useSecond: true });
    act(() => source.emit("message", JSON.stringify({ value: 5 })));

    expect(MockEventSource.instances).toHaveLength(1);
    expect(firstHandler).not.toHaveBeenCalled();
    expect(secondHandler).toHaveBeenCalledWith({ value: 5 });
  });

  it("uses updated named callbacks without reconnecting", () => {
    const alpha = rs.fn();
    const updatedAlpha = rs.fn();
    const { rerender } = renderHook(
      ({ updated }: { updated: boolean }) =>
        useSseEvents("/events", {
          alpha: { schema: z.string(), fn: updated ? updatedAlpha : alpha },
        }),
      { initialProps: { updated: false } },
    );
    const source = MockEventSource.instances[0];

    rerender({ updated: true });
    act(() => source.emit("alpha", JSON.stringify("updated")));

    expect(MockEventSource.instances).toHaveLength(1);
    expect(alpha).not.toHaveBeenCalled();
    expect(updatedAlpha).toHaveBeenCalledWith("updated");
  });

  it("opens and closes connections when enabled or the URL changes", () => {
    const handler = rs.fn();
    const { rerender } = renderHook(
      ({ enabled, url }: { enabled: boolean; url: string }) =>
        useSseEvent(url, { schema: z.string(), fn: handler }, { enabled }),
      { initialProps: { enabled: false, url: "/first" } },
    );

    expect(MockEventSource.instances).toHaveLength(0);
    rerender({ enabled: true, url: "/first" });
    const first = MockEventSource.instances[0];
    expect(first.url).toBe("/first");

    rerender({ enabled: true, url: "/second" });
    expect(first.close).toHaveBeenCalledOnce();
    const second = MockEventSource.instances[1];
    expect(second.url).toBe("/second");

    rerender({ enabled: false, url: "/second" });
    expect(second.close).toHaveBeenCalledOnce();
    rerender({ enabled: true, url: "/second" });
    expect(MockEventSource.instances).toHaveLength(3);
  });

  it("calls the latest reconnect callback only after the first successful open", () => {
    const firstReconnect = rs.fn();
    const secondReconnect = rs.fn();
    const { rerender } = renderHook(
      ({ latest }: { latest: boolean }) =>
        useSseEvent(
          "/events",
          { schema: z.string(), fn: rs.fn() },
          { onReconnect: latest ? secondReconnect : firstReconnect },
        ),
      { initialProps: { latest: false } },
    );
    const source = MockEventSource.instances[0];

    act(() => source.emit("open"));
    expect(firstReconnect).not.toHaveBeenCalled();
    rerender({ latest: true });
    act(() => source.emit("open"));

    expect(MockEventSource.instances).toHaveLength(1);
    expect(firstReconnect).not.toHaveBeenCalled();
    expect(secondReconnect).toHaveBeenCalledOnce();
  });

  it("reports transport errors to the latest callback without replacing the connection", () => {
    const firstError = rs.fn();
    const secondError = rs.fn();
    const { rerender } = renderHook(
      ({ latest }: { latest: boolean }) =>
        useSseEvent(
          "/events",
          { schema: z.string(), fn: rs.fn() },
          { onError: latest ? secondError : firstError },
        ),
      { initialProps: { latest: false } },
    );
    const source = MockEventSource.instances[0];

    act(() => source.emitError(MockEventSource.CONNECTING));
    expect(firstError).toHaveBeenCalledWith({ readyState: MockEventSource.CONNECTING });

    rerender({ latest: true });
    act(() => source.emitError(MockEventSource.CLOSED));

    expect(MockEventSource.instances).toHaveLength(1);
    expect(firstError).toHaveBeenCalledOnce();
    expect(secondError).toHaveBeenCalledWith({ readyState: MockEventSource.CLOSED });
  });

  it("does not serialize handlers and logs rejected promises", async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const handler = rs
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(first)
      .mockRejectedValueOnce(new Error("handler failed"));
    const error = rs.spyOn(console, "error").mockImplementation(() => {});
    renderHook(() => useSseEvent("/events", { schema: z.number(), fn: handler }));
    const source = MockEventSource.instances[0];

    await act(async () => {
      source.emit("message", "1");
      source.emit("message", "2");
      await Promise.resolve();
    });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(
      "SSE event handler rejected",
      expect.objectContaining({ url: "/events", eventName: "message" }),
    );
    releaseFirst();
  });

  it("removes listeners and closes the connection on unmount", () => {
    const handler = rs.fn();
    const { unmount } = renderHook(() =>
      useSseEvents("/events", { changed: { schema: z.string(), fn: handler } }),
    );
    const source = MockEventSource.instances[0];

    unmount();

    expect(source.listenerCount("changed")).toBe(0);
    expect(source.listenerCount("open")).toBe(0);
    expect(source.listenerCount("error")).toBe(0);
    expect(source.close).toHaveBeenCalledOnce();
  });
});
