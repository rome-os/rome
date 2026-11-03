// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, renderHook } from "@testing-library/react";
import { useAppCatalogChanges } from "./use-app-catalog-events";

class MockEventSource {
  static instances: MockEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly url: string;
  readonly close = rs.fn();
  readyState = MockEventSource.OPEN;
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(url: string | URL) {
    this.url = String(url);
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

  emit(type: string, data = ""): void {
    const event = type === "open" ? new Event(type) : new MessageEvent(type, { data });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  rs.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
});

afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

describe("useAppCatalogChanges", () => {
  it("opens the catalog stream and reports every change, whichever app it is about", () => {
    const onChange = rs.fn();
    renderHook(() => useAppCatalogChanges(true, onChange));

    expect(MockEventSource.instances).toHaveLength(1);
    const stream = MockEventSource.instances[0];
    expect(stream.url).toBe("/api/apps/events");

    stream.emit("open");
    stream.emit("catalog-change", JSON.stringify({ appId: "trip-planner", change: "added" }));
    stream.emit("catalog-change", JSON.stringify({ appId: "other-app", change: "removed" }));

    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("closes the stream on unmount", () => {
    const { unmount } = renderHook(() => useAppCatalogChanges(true, () => {}));
    const stream = MockEventSource.instances[0];

    unmount();

    expect(stream.close).toHaveBeenCalled();
  });

  it("opens nothing for a visitor without a session", () => {
    renderHook(() => useAppCatalogChanges(false, () => {}));

    expect(MockEventSource.instances).toHaveLength(0);
  });
});
