import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { DeviceRunResult } from "../desktops/node-devices.js";
import { EventBusTriggerProvider } from "../routines/event-bus-trigger-provider.js";
import type { Routine } from "../routines/types.js";
import { deferred } from "../test/kit/im/peer.js";
import { ComputerConsentWatcher } from "./computer-consent.js";
import { EventBus } from "./event-bus.js";

const deviceId = "mac";
const requestId = "request-a";
const pending = { status: "pending_consent", requestId, revision: 1, expiresInMs: 30_000 };
const permission = {
  ...pending,
  status: "needs_system_permission",
  revision: 2,
  missing: ["accessibility"],
  guideOpened: false,
};
const authorized = { ...pending, status: "authorized", revision: 3 };

function routine(id = "wait", afterRevision?: number, timeout = 60_000): Routine {
  return {
    id,
    name: id,
    enabled: true,
    createdAt: new Date(),
    actionName: "system:resume_session",
    trigger: {
      type: "event-bus",
      once: true,
      eventName: "computer.consent.changed",
      sourcePattern: "rome-node",
      filter: [
        { field: "deviceId", equals: deviceId },
        { field: "requestId", equals: requestId },
      ],
    },
    args: { afterRevision, deadline: new Date(Date.now() + timeout).toISOString() },
  };
}

describe("Computer Use access waits", () => {
  const read = rs.fn<(device: string, action: string, args: unknown) => Promise<DeviceRunResult>>();
  const fire = rs.fn(async (_payload: Record<string, unknown>) => {});
  const published = rs.fn();
  let bus: EventBus;
  let provider: EventBusTriggerProvider;
  beforeEach(() => {
    rs.useFakeTimers();
    read.mockReset().mockResolvedValue({ ok: true, result: pending });
    fire.mockClear();
    published.mockClear();
    bus = new EventBus();
    bus.subscribe(published);
    provider = new EventBusTriggerProvider(
      bus,
      { update: async () => {} },
      new ComputerConsentWatcher({ runAction: read }, bus),
    );
  });

  afterEach(() => {
    provider.stop();
    rs.useRealTimers();
  });

  it.each([
    authorized,
    permission,
    ...["consent_denied", "consent_expired", "cancelled"].map((status) => ({
      status,
      requestId,
      revision: 4,
    })),
    { status: "permissions_expired", requestId, revision: 4, missing: ["screen_recording"] },
    { status: "cancelled", requestId, revision: 2, reason: "method_unavailable" },
    { status: "cancelled", requestId, revision: 2, reason: "invalid_helper_bundle" },
    { status: "not_found", requestId },
  ])("delivers an existing $status on registration, once", async (result) => {
    read.mockResolvedValue({ ok: true, result });
    await provider.activate(routine("wait", 1), fire);
    expect(read).toHaveBeenCalledWith(deviceId, "computer.status", { requestId });
    await rs.advanceTimersByTimeAsync(0);
    expect(published).toHaveBeenCalledExactlyOnceWith({
      name: "computer.consent.changed",
      source: "rome-node",
      emittedAt: expect.any(String),
      payload: { ...result, deviceId },
    });
    expect(fire).toHaveBeenCalledExactlyOnceWith({ ...result, deviceId });
    await rs.advanceTimersByTimeAsync(65_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("without a revision, waits through pending consent and delivers the first resolved state", async () => {
    await provider.activate(routine(), fire);
    await rs.advanceTimersByTimeAsync(2_000);
    expect(published).not.toHaveBeenCalled();
    read.mockResolvedValue({ ok: true, result: permission });
    await rs.advanceTimersByTimeAsync(2_000);
    expect(fire).toHaveBeenCalledExactlyOnceWith({ deviceId, ...permission });
  });

  it("shares an outstanding read and applies each wait's revision to every publication", async () => {
    const slow = deferred<DeviceRunResult>();
    read.mockReturnValueOnce(slow.promise).mockResolvedValue({ ok: true, result: permission });
    const second = rs.fn(async () => {});
    await provider.activate(routine("first", 1), fire);
    await provider.activate(routine("second", 2), second);
    await rs.advanceTimersByTimeAsync(8_000);
    expect(read).toHaveBeenCalledTimes(1);
    slow.resolve({ ok: true, result: permission });
    await rs.advanceTimersByTimeAsync(2_000);
    expect(fire).toHaveBeenCalledExactlyOnceWith({ deviceId, ...permission });
    expect(published).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    read.mockResolvedValue({ ok: true, result: authorized });
    await rs.advanceTimersByTimeAsync(2_000);
    expect(second).toHaveBeenCalledExactlyOnceWith({ deviceId, ...authorized });
  });

  it("delivers each completed poll to existing watches while new watches keep arriving", async () => {
    const first = deferred<DeviceRunResult>();
    const next = deferred<DeviceRunResult>();
    read.mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
    const second = rs.fn(async () => {});
    const third = rs.fn(async () => {});
    await provider.activate(routine("first", 1), fire);
    await provider.activate(routine("second", 1), second);
    first.resolve({ ok: true, result: authorized });
    await rs.advanceTimersByTimeAsync(1);
    expect(fire).toHaveBeenCalledExactlyOnceWith({ deviceId, ...authorized });
    expect(second).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(2);
    await provider.activate(routine("third", 1), third);
    next.resolve({ ok: true, result: authorized });
    await rs.advanceTimersByTimeAsync(1);
    expect(second).toHaveBeenCalledExactlyOnceWith({ deviceId, ...authorized });
    expect(third).not.toHaveBeenCalled();
  });

  it("retries offline, rejected, and malformed RPC replies without waking another request", async () => {
    read
      .mockResolvedValueOnce({ ok: false, code: "target_unavailable", message: "offline" })
      .mockRejectedValueOnce(new Error("RPC closed"))
      .mockResolvedValueOnce({ ok: true, result: { ...authorized, requestId: "other" } })
      .mockResolvedValueOnce({ ok: true, result: { status: "idle" } })
      .mockResolvedValue({ ok: true, result: authorized });
    await provider.activate(routine("wait", 1), fire);
    await rs.advanceTimersByTimeAsync(7_999);
    expect(fire).not.toHaveBeenCalled();
    await rs.advanceTimersByTimeAsync(1);
    expect(fire).toHaveBeenCalledExactlyOnceWith({ deviceId, ...authorized });
  });

  it("wakes at the deadline while offline and stops retrying", async () => {
    read.mockRejectedValue(new Error("offline"));
    await provider.activate(routine("wait", 1, 5_000), fire);
    await rs.advanceTimersByTimeAsync(6_000);
    expect(fire).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ deadlinePassed: true }));
    const calls = read.mock.calls.length;
    await rs.advanceTimersByTimeAsync(20_000);
    expect(read).toHaveBeenCalledTimes(calls);
    expect(published).not.toHaveBeenCalled();
  });

  it.each(["cancel", "shutdown"])("drops a late RPC reply after %s", async (how) => {
    const slow = deferred<DeviceRunResult>();
    read.mockReturnValue(slow.promise);
    await provider.activate(routine(), fire);
    if (how === "cancel") provider.deactivate("wait");
    else provider.stop();
    slow.resolve({ ok: true, result: authorized });
    await rs.advanceTimersByTimeAsync(70_000);
    expect(published).not.toHaveBeenCalled();
    expect(fire).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("wakes an overdue watch on startup without calling the Mac", async () => {
    const overdue = routine("overdue", 2);
    const deadline = "2001-01-01T00:00:00.000Z";
    overdue.args.deadline = deadline;
    await provider.activate(overdue, fire);
    await rs.advanceTimersByTimeAsync(0);
    expect(fire).toHaveBeenCalledExactlyOnceWith({ deadlinePassed: true, deadline });
    expect(provider.isActive(overdue.id)).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it("rechecks a replacement wait after the cancelled wait's in-flight read settles", async () => {
    const slow = deferred<DeviceRunResult>();
    read.mockReturnValueOnce(slow.promise);
    await provider.activate(routine("same", 1), fire);
    await provider.activate(routine("same", 1), fire);
    slow.resolve({ ok: true, result: { status: "not_found", requestId } });
    await rs.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(published).not.toHaveBeenCalled();
    expect(fire).not.toHaveBeenCalled();
    read.mockResolvedValue({ ok: true, result: authorized });
    await rs.advanceTimersByTimeAsync(2_000);
    expect(fire).toHaveBeenCalledExactlyOnceWith({ deviceId, ...authorized });
  });
});
