import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { Cron } from "croner";
import {
  EventBusTriggerProvider,
  matchesSource,
  matchesFilter,
} from "./event-bus-trigger-provider.js";
import { EventBus, type BusEvent } from "../events/event-bus.js";
import { COMPUTER_CONSENT_EVENT, ComputerConsentWatcher } from "../events/computer-consent.js";
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

/** Records the `update` calls the provider makes (a `once` routine disables
 * itself through it). */
function fakeRepo() {
  const updates: Array<{ id: string; data: { enabled?: boolean } }> = [];
  return {
    updates,
    async update(id: string, data: { enabled?: boolean }) {
      updates.push({ id, data });
    },
  };
}

// Reach into the provider's private registrations to fire a wait's deadline
// timer with `Cron.trigger()`, croner's public "fire the callback now" API, as
// the schedule provider's tests do. Waiting out the wall clock was flaky: croner
// counts in whole seconds, so a deadline can fire up to a second late.
function deadlineTimerFor(provider: EventBusTriggerProvider, routineId: string): Cron {
  const registrations = (provider as unknown as { registrations: Map<string, { deadline?: Cron }> })
    .registrations;
  const timer = registrations.get(routineId)?.deadline;
  if (!timer) throw new Error(`no deadline timer for routine ${routineId}`);
  return timer;
}

/** Let the provider's fire-and-forget chain (disable, then fire) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("EventBusTriggerProvider", () => {
  let bus: EventBus;
  let repo: ReturnType<typeof fakeRepo>;
  let provider: EventBusTriggerProvider;

  beforeEach(() => {
    bus = new EventBus();
    repo = fakeRepo();
    provider = new EventBusTriggerProvider(bus, repo);
  });

  it("refuses invalid recovered consent watches before polling or delivering events", async () => {
    const read = rs.fn(async () => ({
      ok: true as const,
      result: { status: "not_found", requestId: "a" },
    }));
    const fire = rs.fn(async () => {});
    provider = new EventBusTriggerProvider(
      bus,
      repo,
      new ComputerConsentWatcher({ runAction: read }, bus),
    );
    const trigger = {
      type: "event-bus" as const,
      eventName: COMPUTER_CONSENT_EVENT,
      once: true,
      sourcePattern: "rome-node",
      filter: [
        { field: "deviceId", equals: "mac" },
        { field: "requestId", equals: "a" },
      ],
    };
    const deadline = new Date(Date.now() + 60_000).toISOString();
    for (const routine of [
      { trigger: { ...trigger, filter: undefined }, args: { deadline } },
      { trigger: { ...trigger, sourcePattern: "*" }, args: { deadline } },
      { trigger: { ...trigger, once: false }, args: { deadline } },
      { trigger, args: {} },
      { trigger, args: { deadline: "invalid" } },
      { trigger, args: { deadline: new Date(Date.now() + 86_400_000).toISOString() } },
      { trigger, args: { deadline, afterRevision: -1 } },
    ]) {
      await provider.activate(buildRoutine(routine), fire);
      expect(provider.isActive("r-1")).toBe(false);
    }
    const validFire = rs.fn(async () => {});
    await provider.activate(buildRoutine({ id: "valid", trigger, args: { deadline } }), validFire);
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(validFire).toHaveBeenCalledTimes(1);
    expect(fire).not.toHaveBeenCalled();
    provider.stop();
  });

  it("does not deliver a consent payload without an active watcher", async () => {
    const trigger = {
      type: "event-bus" as const,
      eventName: COMPUTER_CONSENT_EVENT,
      once: true,
      sourcePattern: "rome-node",
      filter: [
        { field: "deviceId", equals: "mac" },
        { field: "requestId", equals: "a" },
      ],
    };
    const fire = rs.fn(async () => {});
    await provider.activate(
      buildRoutine({ trigger, args: { deadline: new Date(Date.now() + 60_000).toISOString() } }),
      fire,
    );
    publish(bus, {
      name: COMPUTER_CONSENT_EVENT,
      source: "rome-node",
      payload: { deviceId: "mac", requestId: "a", status: "authorized", revision: 2 },
    });
    await flush();
    expect(fire).not.toHaveBeenCalled();
    provider.stop();
  });

  it("ends a once wait at its deadline when no event came, and never fires it twice", async () => {
    const fired: Record<string, unknown>[] = [];
    const routine = buildRoutine({
      trigger: { type: "event-bus", eventName: "ci.done", once: true },
      args: {
        deadline: new Date(Date.now() + 60 * 60_000).toISOString(),
        waitingFor: "the CI run",
      },
    });
    await provider.activate(routine, async (payload) => void fired.push(payload));
    await flush();
    expect(fired).toEqual([]);
    await deadlineTimerFor(provider, routine.id).trigger();
    await flush();
    expect(fired).toEqual([
      expect.objectContaining({ deadlinePassed: true, waitingFor: "the CI run" }),
    ]);
    expect(repo.updates).toEqual([{ id: routine.id, data: { enabled: false } }]);
    publish(bus, { name: "ci.done" });
    await flush();
    expect(fired).toHaveLength(1);
  });

  it("ends a once wait whose deadline passed while Rome was down when it activates", async () => {
    const fired: Record<string, unknown>[] = [];
    const routine = buildRoutine({
      trigger: { type: "event-bus", eventName: "ci.done", once: true },
      args: { deadline: "2001-01-01T00:00:00Z" },
    });
    await provider.activate(routine, async (payload) => void fired.push(payload));
    await flush();
    expect(fired).toEqual([expect.objectContaining({ deadlinePassed: true })]);
  });

  it("drops a wait's deadline once its event came", async () => {
    const fired: Record<string, unknown>[] = [];
    const routine = buildRoutine({
      trigger: { type: "event-bus", eventName: "ci.done", once: true },
      args: { deadline: new Date(Date.now() + 60).toISOString() },
    });
    await provider.activate(routine, async (payload) => void fired.push(payload));
    publish(bus, { name: "ci.done", payload: { ok: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await flush();
    expect(fired).toEqual([{ ok: 1 }]);
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

describe("EventBusTriggerProvider once routines", () => {
  let bus: EventBus;
  let repo: ReturnType<typeof fakeRepo>;
  let provider: EventBusTriggerProvider;

  beforeEach(() => {
    bus = new EventBus();
    repo = fakeRepo();
    provider = new EventBusTriggerProvider(bus, repo);
  });

  afterEach(() => {
    provider.stop();
  });

  it("fires on the first matching event only and disables the routine", async () => {
    const fired: Record<string, unknown>[] = [];
    await provider.activate(
      buildRoutine({
        id: "once-1",
        trigger: { type: "event-bus", eventName: "ci.done", once: true },
      }),
      async (p) => {
        fired.push(p);
      },
    );

    publish(bus, { name: "ci.done", payload: { run: 1 } });
    publish(bus, { name: "ci.done", payload: { run: 2 } });
    await flush();

    expect(fired).toEqual([{ run: 1 }]);
    expect(repo.updates).toEqual([{ id: "once-1", data: { enabled: false } }]);
    expect(provider.isActive("once-1")).toBe(false);
  });

  it("skips non-matching events and still waits for a match", async () => {
    const fired: Record<string, unknown>[] = [];
    await provider.activate(
      buildRoutine({
        id: "once-2",
        trigger: {
          type: "event-bus",
          eventName: "ci.done",
          once: true,
          filter: [{ field: "branch", equals: "feat" }],
        },
      }),
      async (p) => {
        fired.push(p);
      },
    );

    publish(bus, { name: "ci.done", payload: { branch: "main" } });
    await flush();
    expect(fired).toEqual([]);
    expect(provider.isActive("once-2")).toBe(true);

    publish(bus, { name: "ci.done", payload: { branch: "feat" } });
    await flush();
    expect(fired).toEqual([{ branch: "feat" }]);
  });

  it("does not disable a routine that is not once", async () => {
    await provider.activate(
      buildRoutine({ id: "many", trigger: { type: "event-bus", eventName: "ci.done" } }),
      async () => {},
    );
    publish(bus, { name: "ci.done" });
    await flush();
    expect(repo.updates).toEqual([]);
    expect(provider.isActive("many")).toBe(true);
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
