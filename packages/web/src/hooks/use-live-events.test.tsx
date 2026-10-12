// @rstest-environment jsdom
import type { ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { z } from "zod";
import { LiveEventsClient } from "@/lib/live-events";
import { asWebSocket, FakeWebSocket } from "@/test/fake-websocket";
import { chatSessionTopic, LiveEventsClientContext, useLiveEvents } from "./use-live-events";
import type { UseSseEventsOptions } from "./use-sse-events";

class MockEventSource {
  static instances: MockEventSource[] = [];
  static readonly CLOSED = 2;
  readonly close = rs.fn();
  readyState = 1;
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const set = this.listeners.get(type) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data }));
    }
  }
}

const topic = chatSessionTopic("s1");
const nameSchema = z.object({ sessionId: z.string(), name: z.string() });

function render(
  live: LiveEventsClient,
  fn: (value: z.infer<typeof nameSchema>) => void,
  options?: UseSseEventsOptions,
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <LiveEventsClientContext.Provider value={live}>{children}</LiveEventsClientContext.Provider>
  );
  return renderHook(
    () => useLiveEvents(topic, { session_name: { schema: nameSchema, fn } }, options),
    { wrapper },
  );
}

function socketClient(): LiveEventsClient {
  return new LiveEventsClient({
    WebSocket: asWebSocket,
    url: () => "ws://rome.test/ws/events",
    reconnectDelayMs: () => 100,
    minFallbackMs: 0,
  });
}

describe("useLiveEvents", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    MockEventSource.instances = [];
    rs.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
  });

  afterEach(() => {
    cleanup();
    rs.useRealTimers();
    rs.unstubAllGlobals();
    rs.restoreAllMocks();
  });

  it("streams the topic over the socket, validating each payload, and opens no EventSource", () => {
    const error = rs.spyOn(console, "error").mockImplementation(() => {});
    const fn = rs.fn();
    render(socketClient(), fn);
    const socket = FakeWebSocket.latest();
    act(() => {
      socket.open();
      socket.receive({ type: "subscribed", topic: topic.topic });
    });
    expect(socket.sent).toEqual([{ type: "subscribe", topic: "chat.session:s1" }]);

    act(() => {
      socket.receive({
        type: "event",
        topic: topic.topic,
        event: "session_name",
        data: { sessionId: "s1", name: 42 },
      });
      socket.receive({
        type: "event",
        topic: topic.topic,
        event: "session_name",
        data: { sessionId: "s1", name: "Renamed" },
      });
    });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({ sessionId: "s1", name: "Renamed" });
    expect(error).toHaveBeenCalledWith(
      "Invalid Live event payload",
      expect.objectContaining({ topic: "chat.session:s1", eventName: "session_name" }),
    );
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it("resyncs after a reconnect once resubscribed, and reports a refused topic as CLOSED", () => {
    rs.useFakeTimers();
    const onReconnect = rs.fn();
    const onError = rs.fn();
    render(socketClient(), () => {}, { onReconnect, onError });
    const first = FakeWebSocket.latest();
    act(() => {
      first.open();
      first.receive({ type: "subscribed", topic: topic.topic });
    });
    expect(onReconnect).not.toHaveBeenCalled();

    act(() => first.close());
    expect(onError).toHaveBeenLastCalledWith({ readyState: 0 });
    act(() => rs.advanceTimersByTime(100));
    const second = FakeWebSocket.latest();
    act(() => second.open());
    expect(onReconnect).not.toHaveBeenCalled();
    act(() => second.receive({ type: "subscribed", topic: topic.topic }));
    expect(onReconnect).toHaveBeenCalledTimes(1);

    act(() => second.receive({ type: "error", topic: topic.topic, message: "Not found" }));
    expect(onError).toHaveBeenLastCalledWith({ readyState: 2 });
  });

  it("switches to the topic's SSE route when the socket never opens", () => {
    rs.useFakeTimers();
    const fn = rs.fn();
    const onReconnect = rs.fn();
    render(socketClient(), fn, { onReconnect });
    for (let attempt = 0; attempt < 3; attempt++) {
      act(() => FakeWebSocket.latest().close());
      act(() => rs.advanceTimersByTime(100));
    }

    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(MockEventSource.instances.map((source) => source.url)).toEqual([
      "/api/chat/sessions/s1/events",
    ]);
    act(() =>
      MockEventSource.instances[0].emit(
        "session_name",
        JSON.stringify({ sessionId: "s1", name: "Over SSE" }),
      ),
    );
    expect(fn).toHaveBeenCalledWith({ sessionId: "s1", name: "Over SSE" });
  });

  it("moves back to the socket when a later probe opens, closing the EventSource and resyncing", () => {
    rs.useFakeTimers();
    const onReconnect = rs.fn();
    const live = new LiveEventsClient({
      WebSocket: asWebSocket,
      url: () => "ws://rome.test/ws/events",
      reconnectDelayMs: () => 100,
      minFallbackMs: 0,
      reprobeMs: 1_000,
    });
    render(live, () => {}, { onReconnect });
    for (let attempt = 0; attempt < 3; attempt++) {
      act(() => FakeWebSocket.latest().close());
      act(() => rs.advanceTimersByTime(100));
    }
    expect(MockEventSource.instances).toHaveLength(1);
    expect(onReconnect).toHaveBeenCalledTimes(1);

    act(() => rs.advanceTimersByTime(1_000));
    const socket = FakeWebSocket.latest();
    act(() => socket.open());
    expect(MockEventSource.instances[0].close).toHaveBeenCalled();
    expect(socket.sent).toEqual([{ type: "subscribe", topic: "chat.session:s1" }]);
    act(() => socket.receive({ type: "subscribed", topic: topic.topic }));
    expect(onReconnect).toHaveBeenCalledTimes(2);
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it("uses SSE from the start without WebSocket, and opens nothing while disabled", () => {
    const live = new LiveEventsClient();
    const { unmount } = render(live, () => {}, { enabled: false });
    expect(MockEventSource.instances).toHaveLength(0);
    unmount();

    render(live, () => {});
    expect(MockEventSource.instances).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});
