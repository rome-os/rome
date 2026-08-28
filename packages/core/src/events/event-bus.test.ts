import { describe, it, expect } from "@rstest/core";
import { EventBus, type BusEvent } from "./event-bus.js";

function makeEvent(overrides: Partial<BusEvent> = {}): BusEvent {
  return {
    name: overrides.name ?? "test.event",
    source: overrides.source ?? "tester",
    payload: overrides.payload ?? {},
    emittedAt: overrides.emittedAt ?? new Date().toISOString(),
  };
}

describe("EventBus", () => {
  it("delivers a published event to a subscriber", () => {
    const bus = new EventBus();
    const received: BusEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const event = makeEvent({ name: "a", payload: { x: 1 } });
    bus.publish(event);

    expect(received).toEqual([event]);
  });

  it("delivers to every subscriber", () => {
    const bus = new EventBus();
    const a: BusEvent[] = [];
    const b: BusEvent[] = [];
    bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));

    bus.publish(makeEvent({ name: "fanout" }));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("stops delivering after unsubscribe", () => {
    const bus = new EventBus();
    const received: BusEvent[] = [];
    const unsubscribe = bus.subscribe((e) => received.push(e));

    bus.publish(makeEvent());
    unsubscribe();
    bus.publish(makeEvent());

    expect(received).toHaveLength(1);
  });

  it("isolates a throwing subscriber so others still receive the event", () => {
    const bus = new EventBus();
    const received: BusEvent[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((e) => received.push(e));

    expect(() => bus.publish(makeEvent({ name: "resilient" }))).not.toThrow();
    expect(received).toHaveLength(1);
    expect(received[0].name).toBe("resilient");
  });
});
