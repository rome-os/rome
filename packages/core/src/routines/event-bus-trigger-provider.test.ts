import { describe, it, expect, beforeEach } from "@rstest/core";
import {
  EventBusTriggerProvider,
  matchesSource,
  matchesFilter,
} from "./event-bus-trigger-provider.js";
import { EventBus, type BusEvent } from "../events/event-bus.js";
import type { Routine, Trigger } from "./types.js";

function buildRoutine(overrides: Partial<Routine> & { trigger: Trigger }): Routine {
  return {
    id: overrides.id ?? "r-1",
    name: overrides.name ?? "test",
    enabled: overrides.enabled ?? true,
    trigger: overrides.trigger,
    actionName: overrides.actionName ?? "noop",
    args: overrides.args ?? {},
    createdAt: overrides.createdAt ?? new Date(),
  };
}

function publish(bus: EventBus, overrides: Partial<BusEvent> = {}): void {
  bus.publish({
    name: overrides.name ?? "evt",
    source: overrides.source ?? "src",
    payload: overrides.payload ?? {},
    emittedAt: overrides.emittedAt ?? new Date().toISOString(),
  });
}

describe("EventBusTriggerProvider", () => {
  let bus: EventBus;
  let provider: EventBusTriggerProvider;

  beforeEach(() => {
    bus = new EventBus();
    provider = new EventBusTriggerProvider(bus);
  });

  it("fires a routine when a matching event is published, with the payload", async () => {
    const fired: Record<string, unknown>[] = [];
    await provider.activate(
      buildRoutine({ id: "r-1", trigger: { type: "event-bus", eventName: "order.created" } }),
      async (p) => {
        fired.push(p);
      },
    );

    publish(bus, { name: "order.created", payload: { orderId: 42 } });

    expect(fired).toEqual([{ orderId: 42 }]);
  });

  it("does not fire when the event name differs", async () => {
    const fired: Record<string, unknown>[] = [];
    await provider.activate(
      buildRoutine({ trigger: { type: "event-bus", eventName: "order.created" } }),
      async (p) => {
        fired.push(p);
      },
    );

    publish(bus, { name: "order.shipped" });

    expect(fired).toHaveLength(0);
  });

  it("honors sourcePattern as an include/exclude filter", async () => {
    const fired: Record<string, unknown>[] = [];
    await provider.activate(
      buildRoutine({
        trigger: { type: "event-bus", eventName: "evt", sourcePattern: "connector*" },
      }),
      async (p) => {
        fired.push(p);
      },
    );

    publish(bus, { name: "evt", source: "connector.gmail", payload: { ok: true } });
    publish(bus, { name: "evt", source: "other-app", payload: { ok: false } });

    expect(fired).toEqual([{ ok: true }]);
  });

  it("fires only when every payload filter condition matches", async () => {
    const fired: Record<string, unknown>[] = [];
    await provider.activate(
      buildRoutine({
        trigger: {
          type: "event-bus",
          eventName: "connector:GMAIL_NEW_MESSAGE",
          filter: [{ field: "from.email", equals: "dana@example.com" }],
        },
      }),
      async (p) => {
        fired.push(p);
      },
    );

    publish(bus, {
      name: "connector:GMAIL_NEW_MESSAGE",
      payload: { from: { email: "dana@example.com" }, subject: "rent" },
    });
    publish(bus, {
      name: "connector:GMAIL_NEW_MESSAGE",
      payload: { from: { email: "spam@example.com" }, subject: "sale" },
    });

    expect(fired).toEqual([{ from: { email: "dana@example.com" }, subject: "rent" }]);
  });

  it("requires all conditions to hold (AND), not any", async () => {
    const fired: Record<string, unknown>[] = [];
    await provider.activate(
      buildRoutine({
        trigger: {
          type: "event-bus",
          eventName: "evt",
          filter: [
            { field: "from", equals: "dana" },
            { field: "label", equals: "important" },
          ],
        },
      }),
      async (p) => {
        fired.push(p);
      },
    );

    // Right sender, wrong label — must not fire.
    publish(bus, { name: "evt", payload: { from: "dana", label: "promo" } });
    expect(fired).toHaveLength(0);

    publish(bus, { name: "evt", payload: { from: "dana", label: "important" } });
    expect(fired).toHaveLength(1);
  });

  it("stops firing after deactivate and reflects isActive", async () => {
    const fired: Record<string, unknown>[] = [];
    await provider.activate(
      buildRoutine({ id: "r-9", trigger: { type: "event-bus", eventName: "evt" } }),
      async (p) => {
        fired.push(p);
      },
    );
    expect(provider.isActive("r-9")).toBe(true);

    provider.deactivate("r-9");
    expect(provider.isActive("r-9")).toBe(false);

    publish(bus, { name: "evt" });
    expect(fired).toHaveLength(0);
  });

  it("stop() unsubscribes from the bus and clears registrations", async () => {
    const fired: Record<string, unknown>[] = [];
    await provider.activate(
      buildRoutine({ trigger: { type: "event-bus", eventName: "evt" } }),
      async (p) => {
        fired.push(p);
      },
    );

    provider.stop();
    publish(bus, { name: "evt" });

    expect(fired).toHaveLength(0);
  });
});

describe("matchesSource", () => {
  it("matches exactly when there is no wildcard", () => {
    expect(matchesSource("connector", "connector")).toBe(true);
    expect(matchesSource("connector", "connector.gmail")).toBe(false);
  });

  it("treats * as any run of characters", () => {
    expect(matchesSource("connector*", "connector.gmail")).toBe(true);
    expect(matchesSource("*gmail*", "connector.gmail.received")).toBe(true);
    expect(matchesSource("connector.*.received", "connector.gmail.received")).toBe(true);
    expect(matchesSource("connector*", "slack.message")).toBe(false);
  });

  it("does not let regex metacharacters in the pattern leak through", () => {
    // The dot is literal, so "a.b" must not match "axb".
    expect(matchesSource("a.b", "axb")).toBe(false);
  });
});

describe("matchesFilter", () => {
  it("reads dot-paths into nested payloads", () => {
    expect(
      matchesFilter([{ field: "from.email", equals: "a@b.com" }], { from: { email: "a@b.com" } }),
    ).toBe(true);
    expect(
      matchesFilter([{ field: "from.email", equals: "a@b.com" }], { from: { email: "x@y.com" } }),
    ).toBe(false);
  });

  it("coerces non-string payload values before comparing", () => {
    expect(matchesFilter([{ field: "count", equals: "3" }], { count: 3 })).toBe(true);
  });

  it("fails a condition whose path is absent rather than matching loosely", () => {
    expect(matchesFilter([{ field: "from.email", equals: "a@b.com" }], { from: {} })).toBe(false);
    expect(matchesFilter([{ field: "missing", equals: "" }], {})).toBe(false);
  });

  it("matches when there are no conditions", () => {
    expect(matchesFilter([], { anything: true })).toBe(true);
  });
});
